/**
 * The clean-up engine: sorts legacy entries into Covered,
 * Exception or Remove, with a reason for each, and turns the exceptions into
 * site lists split by action and capped at 750 sites.
 *
 *   Remove     the entry can't go in a site list, repeats an earlier entry,
 *              no policy acts on it, or its domain doesn't resolve.
 *   Covered    SophosLabs puts the site in a category the target profile
 *              already gives the entry's action, or it is a security risk
 *              site the entry blocks (security risk sites are always filtered).
 *   Exception  anything else: the category gives a different action, the
 *              site is uncategorized, or there was no SophosLabs lookup.
 *
 * Entries the tool can't settle on its own carry needsDecision, and an
 * admin's decision overrides the verdict. Lookups (SophosLabs Intelix) and DNS
 * are passed in, so the engine runs the same in the wizard, the standalone
 * site list cleaner, and its static page.
 *
 * Pure: no Node or browser imports.
 */

import { broadness, parseSite, type ParsedSite } from "./sites.js";
import { CLASSIC_ALWAYS_BLOCKED, labelOf, type Catalog, type CategoryActions, type FilterAction } from "./categories.js";
import { CLASSIC_CATEGORIES } from "./categories-data.js";
import type { IntelixLookup } from "./intelix.js";
import { csvObjects, toCsv } from "./csv.js";

export type EntryAction = FilterAction | "mixed" | "none";
export type Verdict = "covered" | "exception" | "remove";
export const SITES_PER_LIST = 750;

export interface CleanupTarget {
  /** Where the entry applies, for the reason text: a policy name or "your list". */
  name: string;
  /** What the entry does there. */
  action: FilterAction;
  /** The profile's action for each category. */
  categoryActions: CategoryActions;
}

export interface CleanupInput {
  /** Stable key, usually the Website Management id or the line number. */
  id: string;
  raw: string;
  tags?: string[];
  comment?: string;
  categoryId?: number;
  source: "website-management" | "paste" | "csv";
  /** One entry per place it applies. Empty when no policy acts on it. */
  targets: CleanupTarget[];
}

export interface DnsResult {
  status: "resolves" | "nxdomain" | "skipped" | "error";
  detail?: string;
}

export interface CleanupResult {
  id: string;
  raw: string;
  site: ParsedSite;
  /** What the entry does: one action, mixed when policies disagree, none when no policy acts on it. */
  action: EntryAction;
  tags: string[];
  comment?: string;
  source: CleanupInput["source"];
  verdict: Verdict;
  reason: string;
  needsDecision: boolean;
  /** Set when an admin decided; overrides the computed verdict. */
  decided?: { verdict: Verdict; action?: FilterAction };
  lookup?: IntelixLookup;
  lookupError?: string;
  dns?: DnsResult;
  categoryLabel?: string;
  /** The classic category a Website Management override puts the site in. */
  override?: string;
  /** Set when the entry covers far more than one site (a whole top-level domain, a public suffix, a shared platform, a wide range). Left out of site lists until decided. */
  broad?: string;
}

function entryAction(targets: CleanupTarget[]): EntryAction {
  const acts = new Set(targets.map((t) => t.action));
  if (acts.size === 0) return "none";
  return acts.size === 1 ? [...acts][0]! : "mixed";
}

const VERB: Record<FilterAction, string> = { allow: "allows", block: "blocks", warn: "warns on" };
const ACTION_WORD_LOWER: Record<FilterAction, string> = { allow: "an Allow", block: "a Block", warn: "a Warn" };
const VERB_PLURAL: Record<FilterAction, string> = { allow: "allow", block: "block", warn: "warn on" };

/**
 * Classifies one entry. `seen` holds site values already classified, to catch
 * duplicates. A broad entry (a whole top-level domain, a public suffix such as
 * co.uk, a shared hosting platform, a range wider than /24, or a wildcard on
 * any of them) that would go into a site list needs a decision, with the
 * reason first.
 */
export function classify(
  input: CleanupInput,
  catalog: Catalog,
  opts: { lookup?: IntelixLookup; lookupError?: string; dns?: DnsResult; seen?: Set<string> } = {},
): CleanupResult {
  const r = classifyEntry(input, catalog, opts);
  // Only exceptions go into site lists, so only they need the review.
  if (r.verdict !== "exception") return r;
  const b = broadness(r.site);
  if (!b.broad) return r;
  const why = b.why ?? b.reason ?? "covers many sites";
  return { ...r, broad: why, needsDecision: true, reason: `Broad (${why}): review it before it goes into a site list. ${r.reason}` };
}

function classifyEntry(
  input: CleanupInput,
  catalog: Catalog,
  opts: { lookup?: IntelixLookup; lookupError?: string; dns?: DnsResult; seen?: Set<string> },
): CleanupResult {
  const site = parseSite(input.raw);
  const action = entryAction(input.targets);
  const base = {
    id: input.id,
    raw: input.raw,
    site,
    action,
    tags: input.tags ?? [],
    comment: input.comment,
    source: input.source,
    lookup: opts.lookup,
    lookupError: opts.lookupError,
    dns: opts.dns,
    categoryLabel: opts.lookup?.profileCategory ? labelOf(catalog, opts.lookup.profileCategory) : undefined,
    ...(input.categoryId !== undefined ? { override: CLASSIC_CATEGORIES.find((c) => c.id === input.categoryId)?.label ?? `category ${input.categoryId}` } : {}),
  };
  const out = (verdict: Verdict, reason: string, needsDecision = false): CleanupResult => ({ ...base, verdict, reason, needsDecision });

  if (site.kind === "invalid" || !site.value) {
    return out("remove", site.kind === "wildcard" ? "Matches every site; a site list can't hold it." : "Not a site, address or range a site list can hold.");
  }
  if (opts.seen) {
    if (opts.seen.has(site.value)) return out("remove", "Repeats an earlier entry.");
    opts.seen.add(site.value);
  }
  const override = base.override ?? null;
  if (action === "none" && override) {
    return out("exception", `Overrides its category to ${override}, but no policy here gives that category an action (category filtering off, or no setting); decide what it should do.`, true);
  }
  if (action === "none") return out("remove", "No policy acts on its tag, so it does nothing today.");
  if (opts.dns?.status === "nxdomain") return out("remove", `${site.host} doesn't resolve in DNS: dead, mistyped, or expired.`);

  const lookup = opts.lookup;
  if (lookup?.securityRisk) {
    if (action === "block") return out("covered", `SophosLabs rates it a security risk (${lookup.securityCategory}${lookup.riskLevel ? `, risk ${lookup.riskLevel}` : ""}); security risk sites are always filtered.`);
    return out("exception", `SophosLabs rates it a security risk (${lookup.securityCategory}${lookup.riskLevel ? `, risk ${lookup.riskLevel}` : ""}). An Allow or Warn entry overrides that; confirm it's wanted.`, true);
  }
  if (override && CLASSIC_ALWAYS_BLOCKED.has(input.categoryId!) && action === "block") {
    return out("exception", `Website Management puts it in ${override}, which classic always blocks; profiles have no category override, so it moves to a Block site list.`);
  }
  // An override says what the admin wanted; without a SophosLabs category to compare, carry it over as it is.
  if (override && !lookup?.profileCategory) {
    const what = action === "mixed" ? "which its policies treat differently" : input.targets.length > 1 ? `which its policies ${VERB_PLURAL[action]}` : `which its policy ${VERB[action]}`;
    return out(
      "exception",
      `Website Management puts it in ${override}, ${what}. ${lookup ? "SophosLabs has no category for it" : "No SophosLabs category was looked up"}, so ${action === "mixed" ? "decide its action" : `it moves to ${ACTION_WORD_LOWER[action]} site list`}.`,
      action === "mixed",
    );
  }
  if (!lookup && (site.kind === "cidr4" || site.kind === "cidr6")) {
    return out("exception", "An address range has no SophosLabs category; kept until you decide.", true);
  }
  if (!lookup?.profileCategory) {
    if (lookup && lookup.productivityCategory) {
      return out("exception", `SophosLabs category ${lookup.productivityCategory} has no profile equivalent; kept until you decide.`, true);
    }
    if (lookup) {
      // Seen live (13/10/2026): an unknown site comes back 200 with scores but no category.
      return out("exception", "SophosLabs has no category for it yet (often a new, rare or internal site); kept until you decide.", true);
    }
    return out(
      "exception",
      opts.lookupError ? `No SophosLabs category (${opts.lookupError}); kept until you decide.` : "No SophosLabs category looked up; kept until you decide.",
      true,
    );
  }
  const cat = lookup.profileCategory;
  const label = labelOf(catalog, cat);
  if (cat === "uncategorized") {
    return out("exception", "SophosLabs has no category for it, often a business system; keep the entry.", action === "mixed");
  }
  // Compare with every place the entry applies.
  const verdicts = input.targets.map((t) => ({ t, catAction: t.categoryActions[cat] ?? "allow" }));
  const covered = verdicts.filter((v) => v.catAction === v.t.action);
  if (covered.length === verdicts.length) {
    const v = verdicts[0]!;
    return out("covered", `SophosLabs puts it in ${label}, which the profile already ${VERB[v.t.action]}.`);
  }
  if (covered.length > 0) {
    const names = verdicts.filter((v) => v.catAction !== v.t.action).map((v) => v.t.name);
    return out("exception", `SophosLabs puts it in ${label}. Covered in some policies, not in ${names.join(", ")}.`, true);
  }
  const v = verdicts[0]!;
  if (action === "mixed") return out("exception", `SophosLabs puts it in ${label}, and its policies act on it differently.`, true);
  const translators = cat === "translators" || cat === "anonymizers" ? ` Classic "Proxies and translators" is now two categories; check ${label} is what you meant.` : "";
  return out("exception", `SophosLabs puts it in ${label}, which the profile ${VERB[v.catAction]}; keep a ${v.t.action} entry.${translators}`, !!translators);
}

/** The verdict that counts: the admin's decision, else the computed one. */
export function finalVerdict(r: CleanupResult): Verdict {
  return r.decided?.verdict ?? r.verdict;
}

export function finalAction(r: CleanupResult): FilterAction | null {
  if (r.decided?.action) return r.decided.action;
  return r.action === "allow" || r.action === "block" || r.action === "warn" ? r.action : null;
}

export interface SiteListOut {
  name: string;
  action: FilterAction;
  sites: string[];
}

const ACTION_LABEL: Record<FilterAction, string> = { allow: "Allow", block: "Block", warn: "Warn" };

/** Web Filtering API limits: profile and site list names 50 characters, descriptions 250 (spec, and a live 400 "Field too long : name", 13/10/2026). */
export const NAME_MAX = 50;
export const DESCRIPTION_MAX = 250;

/** base + suffix in at most max characters, shortening the base and keeping the suffix. */
export function fitName(base: string, suffix = "", max = NAME_MAX): string {
  const room = Math.max(1, max - suffix.length);
  if (base.length <= room) return `${base}${suffix}`.slice(0, max);
  // Shorten at a word boundary, and drop a dangling "(", "-" or "/" a cut can leave.
  let cut = base.slice(0, room);
  const space = cut.lastIndexOf(" ");
  if (space > room / 2) cut = cut.slice(0, space);
  cut = cut.replace(/\s*\([^)]*$/, "").replace(/[\s\-/:,(]+$/, "");
  return `${cut || base.slice(0, room)}${suffix}`.slice(0, max);
}

/** Exceptions as site lists: one action per list, at most 750 sites each. Mixed and broad entries without a decision are left out. */
export function siteListsFrom(results: CleanupResult[], prefix: string): { lists: SiteListOut[]; leftOut: CleanupResult[] } {
  const byAction: Record<FilterAction, string[]> = { allow: [], block: [], warn: [] };
  const leftOut: CleanupResult[] = [];
  for (const r of results) {
    if (finalVerdict(r) !== "exception") continue;
    const a = finalAction(r);
    if (!a || (r.broad && !r.decided)) {
      leftOut.push(r);
      continue;
    }
    if (!byAction[a].includes(r.site.value)) byAction[a].push(r.site.value);
  }
  const lists: SiteListOut[] = [];
  for (const a of ["block", "warn", "allow"] as FilterAction[]) {
    const sites = byAction[a];
    const parts = Math.ceil(sites.length / SITES_PER_LIST);
    for (let i = 0; i < parts; i++) {
      lists.push({
        name: fitName(prefix, ` ${ACTION_LABEL[a]}${parts > 1 ? ` ${i + 1}` : ""}`),
        action: a,
        sites: sites.slice(i * SITES_PER_LIST, (i + 1) * SITES_PER_LIST),
      });
    }
  }
  return { lists, leftOut };
}

export interface CleanupSummary {
  total: number;
  covered: number;
  exception: number;
  remove: number;
  needsDecision: number;
}

export function summarise(results: CleanupResult[]): CleanupSummary {
  const s: CleanupSummary = { total: results.length, covered: 0, exception: 0, remove: 0, needsDecision: 0 };
  for (const r of results) {
    s[finalVerdict(r)]++;
    if (r.needsDecision && !r.decided) s.needsDecision++;
  }
  return s;
}

/** Every result with its verdict and reason, for a spreadsheet. */
export function resultsCsv(results: CleanupResult[]): string {
  return toCsv(
    ["site", "entry", "tags", "action", "verdict", "decided", "reason", "sophoslabs_category", "security_category", "risk", "dns"],
    results.map((r) => [
      r.site.value,
      r.raw,
      r.tags.join("; "),
      r.decided?.action ?? r.action,
      finalVerdict(r),
      r.decided ? "yes" : "",
      r.decided ? "Your decision." : r.reason,
      r.categoryLabel ?? r.lookup?.productivityCategory ?? "",
      r.lookup?.securityCategory ?? "",
      r.lookup?.riskLevel ?? "",
      r.dns?.status ?? "",
    ]),
  );
}

/** One site list as CSV, one site per row, ready to paste into Sophos Fusion or send to the API. */
export function siteListCsv(list: SiteListOut): string {
  return toCsv(["site"], list.sites.map((s) => [s]));
}

/**
 * Pasted lines or CSV text as clean-up inputs. A CSV with a header row may
 * carry site (or url), action and tags columns; plain lines are sites with the
 * default action.
 */
export function inputsFromText(
  text: string,
  defaultAction: FilterAction,
  categoryActions: CategoryActions,
  targetName = "your list",
): CleanupInput[] {
  const firstLine = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").toLowerCase();
  const looksCsv = /(^|,)\s*"?(site|url|domain)"?\s*(,|$)/.test(firstLine);
  const target = (action: FilterAction): CleanupTarget[] => [{ name: targetName, action, categoryActions }];
  if (looksCsv) {
    return csvObjects(text)
      .map((row, i) => {
        const raw = row.site ?? row.url ?? row.domain ?? "";
        const a = (row.action ?? "").toLowerCase();
        const action: FilterAction = a === "allow" || a === "block" || a === "warn" ? a : defaultAction;
        return { id: `csv-${i + 2}`, raw, tags: row.tags ? row.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [], comment: row.comment, source: "csv" as const, targets: target(action) };
      })
      .filter((x) => x.raw.trim());
  }
  return text
    .split(/\r?\n/)
    .map((l, i) => ({ line: l, i }))
    .filter(({ line }) => line.trim() && !line.trim().startsWith("#"))
    .map(({ line, i }) => ({ id: `line-${i + 1}`, raw: line.trim(), source: "paste" as const, targets: target(defaultAction) }));
}
