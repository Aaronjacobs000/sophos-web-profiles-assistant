/**
 * The design step: one web filtering profile per distinct
 * classic policy, mapped onto the nearest preset or a Custom profile, with
 * the difference shown group by group, site lists from the clean-up step's
 * exceptions, and everything fitted under the account limits (20 profiles,
 * 20 site lists, 20 lists per profile, 750 sites per list).
 *
 * It also builds the plan the build step runs: site lists, then profiles,
 * then a pilot policy at the top of the order.
 *
 * Pure: no Node or browser imports.
 */

import {
  classicOverrideAction,
  compress,
  differences,
  expand,
  expandPreset,
  groups,
  labelOf,
  readClassic,
  stricter,
  type Catalog,
  type CategoryActions,
  type ClassicReading,
  type FilterAction,
} from "./categories.js";
import { PRESET_LABELS } from "./categories-data.js";
import { DESCRIPTION_MAX, finalAction, finalVerdict, fitName, SITES_PER_LIST, type CleanupResult } from "./cleanup.js";
import { parseSite } from "./sites.js";
import { isBasePolicy, settingValue } from "./inventory.js";
import type { Policy } from "../sophos/api/policies.js";
import type { LocalSite } from "../sophos/api/web-control.js";

export const PROFILE_LIMIT = 20;
export const SITE_LIST_LIMIT = 20;
export const LISTS_PER_PROFILE = 20;

const AI_HOSTS = ["chatgpt.com", "openai.com", "claude.ai", "anthropic.com", "gemini.google.com", "bard.google.com", "copilot.microsoft.com", "perplexity.ai", "poe.com", "character.ai", "deepseek.com", "mistral.ai", "meta.ai", "grok.com", "x.ai", "huggingface.co"];

export interface DesignOptions {
  /** Today's date for descriptions, DD/MM/YYYY. */
  date: string;
  /** Profiles and site lists already in the tenant (they count against the limits). */
  existingProfiles: number;
  existingSiteLists: number;
  /** Generative AI action per source policy id, when the admin has chosen one. */
  genAi?: Record<string, FilterAction>;
}

export interface DiffRow {
  group: string;
  classic: string;
  profile: string;
  note?: string;
}

export interface PolicyDesign {
  policyId: string;
  policyName: string;
  type: string;
  skipped?: string;
  nearestPreset?: { name: string; label: string; mismatches: number };
  mode?: "preset" | "custom" | "sites-only";
  reading?: ClassicReading;
  categoryActions?: CategoryActions;
  sites?: Record<FilterAction, string[]>;
  flags: string[];
}

export interface SiteListPlan {
  key: string;
  name: string;
  description: string;
  action: FilterAction;
  sites: string[];
}

export interface ProfilePlan {
  key: string;
  name: string;
  description: string;
  mode: "preset" | "custom" | "sites-only";
  preset?: string;
  categoryActions: CategoryActions;
  sourcePolicies: Array<{ id: string; name: string; type: string }>;
  siteLists: Array<{ listKey: string; action: FilterAction; priority: number }>;
  diff: DiffRow[];
  flags: string[];
  /** The profile body for POST /web-filters/v1/profiles, without site list ids (the build step fills them). */
  body: Record<string, unknown>;
}

export interface DesignPlan {
  policies: PolicyDesign[];
  profiles: ProfilePlan[];
  siteLists: SiteListPlan[];
  warnings: string[];
  limits: { profiles: { planned: number; existing: number; limit: number }; siteLists: { planned: number; existing: number; limit: number } };
  cleanedUp: boolean;
}

const ACTION_WORD: Record<FilterAction, string> = { allow: "Allow", block: "Block", warn: "Warn" };

function summarizeGroup(catalog: Catalog, group: string, actions: Partial<CategoryActions>): string {
  const members = catalog.categories.filter((c) => c.group === group).map((c) => actions[c.name]).filter((a): a is FilterAction => !!a);
  if (members.length === 0) return "Not in classic";
  return members.every((a) => a === members[0]) ? ACTION_WORD[members[0]!] : "Let me specify";
}

function diffRows(catalog: Catalog, reading: ClassicReading | undefined, profile: CategoryActions): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const group of groups(catalog)) {
    const members = catalog.categories.filter((c) => c.group === group);
    const classic = reading ? summarizeGroup(catalog, group, reading.actions) : "Off";
    const prof = summarizeGroup(catalog, group, profile);
    const changed = reading
      ? members.filter((c) => c.name in reading.actions && reading.actions[c.name] !== profile[c.name]).map((c) => `${labelOf(catalog, c.name)} ${profile[c.name]}`)
      : [];
    const added = reading ? members.filter((c) => !(c.name in reading.actions)) : [];
    const notes: string[] = [];
    if (changed.length) notes.push(`Changed: ${changed.join(", ")}`);
    if (added.length) {
      const byAction = new Map<FilterAction, string[]>();
      for (const c of added) byAction.set(profile[c.name] ?? "allow", [...(byAction.get(profile[c.name] ?? "allow") ?? []), labelOf(catalog, c.name)]);
      notes.push(
        `New: ${[...byAction.entries()].map(([a, names]) => (names.length > 3 ? `${names.length} categories ${a}` : `${names.join(", ")} ${a}`)).join("; ")}`,
      );
    }
    rows.push({ group, classic, profile: prof, note: notes.join(". ") || undefined });
  }
  const unc = reading?.actions.uncategorized;
  rows.push({ group: "uncategorized", classic: unc ? ACTION_WORD[unc] : "Allow", profile: ACTION_WORD[profile.uncategorized ?? "allow"] });
  return rows;
}

function nearestPreset(catalog: Catalog, reading: ClassicReading): { name: string; mismatches: string[] } {
  let best: { name: string; mismatches: string[] } | null = null;
  for (const p of catalog.presets) {
    const exp = expandPreset(catalog, p.name);
    const mismatches = Object.keys(reading.actions).filter((c) => (exp[c] ?? "allow") !== reading.actions[c]);
    if (!best || mismatches.length < best.mismatches.length) best = { name: p.name, mismatches };
  }
  return best!;
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function tagActions(p: Policy): Array<{ tag: string; action: FilterAction }> {
  const v = settingValue<Array<{ tag: string; action: string }>>(p, "endpoint.web-control.tags.settings") ?? [];
  return v.filter((t) => t.action === "allow" || t.action === "block" || t.action === "warn") as Array<{ tag: string; action: FilterAction }>;
}

/** Builds the design from the classic policies, Website Management, and (when run) the clean-up results. */
export function buildDesign(
  catalog: Catalog,
  webPolicies: Policy[],
  localSites: LocalSite[],
  cleanup: CleanupResult[] | null,
  opts: DesignOptions,
): DesignPlan {
  const warnings: string[] = [];
  const base = webPolicies.find((p) => p.type === "web-control" && isBasePolicy(p));
  const serverBase = webPolicies.find((p) => p.type === "server-web-control" && isBasePolicy(p));
  const byId = new Map((cleanup ?? []).map((r) => [r.id, r]));
  const policies: PolicyDesign[] = [];

  for (const p of webPolicies) {
    const flags: string[] = [];
    const d: PolicyDesign = { policyId: p.id, policyName: p.name, type: p.type, flags };
    if (p.enabled === false && !isBasePolicy(p)) {
      d.skipped = "Disabled: retire it rather than convert it.";
      policies.push(d);
      continue;
    }
    if (settingValue<boolean>(p, "endpoint.web-control.web-profile.enabled") === true && settingValue<boolean>(p, "endpoint.web-control.filter-by-web-profile.enabled") === true) {
      d.skipped = "Already uses a web filtering profile.";
      policies.push(d);
      continue;
    }
    const filtering = settingValue<boolean>(p, "endpoint.web-control.web-filtering.enabled") !== false;
    const baseSettings = (p.type === "server-web-control" ? serverBase : base)?.settings;
    const reading = readClassic(catalog, (p.settings ?? {}) as Record<string, { value?: unknown }>, baseSettings as Record<string, { value?: unknown }> | undefined);
    d.reading = reading;
    if (!filtering) {
      d.mode = "sites-only";
      d.categoryActions = {};
      flags.push("Category filtering is off in this policy, so the profile filters by site lists only.");
    } else {
      const near = nearestPreset(catalog, reading);
      d.nearestPreset = { name: near.name, label: PRESET_LABELS[near.name] ?? near.name, mismatches: near.mismatches.length };
      const actions: CategoryActions = { ...expandPreset(catalog, near.name), ...reading.actions };
      const genAi = opts.genAi?.[p.id];
      if (genAi) actions["generative-ai"] = genAi;
      d.categoryActions = actions;
      const presetGenAi = expandPreset(catalog, near.name)["generative-ai"];
      d.mode = near.mismatches.length === 0 && (!genAi || genAi === presetGenAi) ? "preset" : "custom";
      flags.push(
        `Generative AI is a new category: it gets ${actions["generative-ai"] ?? "allow"} here${genAi ? " (your choice)" : ` from ${PRESET_LABELS[near.name] ?? near.name}`}. Decide per group: Block for regulated groups, Warn for general staff, Allow for approved AI teams.`,
      );
      for (const s of reading.splits) {
        if (s.classicId === 37 && s.action !== "allow") {
          flags.push(`Classic "Proxies and translators" (${s.action}) splits into Anonymizers (threats group) and Translators (business group); both get ${s.action}. Consider allowing Translators.`);
        } else if (s.classicId === 37) {
          flags.push('Classic "Proxies and translators" splits into Anonymizers and Translators; both stay allowed.');
        }
      }
      for (const l of reading.lost) {
        flags.push(`Classic "${l.label}" was ${l.action} and has no profile category${l.consider.length ? `; nearest: ${l.consider.map((c) => labelOf(catalog, c)).join(", ")}` : ""}.`);
      }
    }
    // Site lists from this policy's tags, then from category overrides.
    const sites: Record<FilterAction, string[]> = { allow: [], block: [], warn: [] };
    const seen = new Map<string, FilterAction>();
    const aiEntries: string[] = [];
    const heldBroad: string[] = [];
    const add = (e: LocalSite, action: FilterAction): void => {
      const parsed = parseSite(e.url);
      if (!parsed.value) return;
      if (AI_HOSTS.some((h) => parsed.host === h || parsed.host.endsWith(`.${h}`))) aiEntries.push(parsed.value);
      if (cleanup) {
        const r = byId.get(e.id);
        if (!r || finalVerdict(r) !== "exception") return;
        if (r.broad && !r.decided) {
          heldBroad.push(parsed.value);
          return;
        }
        const decided = r.decided?.action;
        if (decided && decided !== action) return;
      }
      const prev = seen.get(parsed.value);
      if (prev && prev !== action) {
        flags.push(`${parsed.value} has entries with different actions in this policy (tags or a category override); the stricter (${stricter(prev, action)}) is kept.`);
        const keep = stricter(prev, action);
        for (const a of ["allow", "block", "warn"] as FilterAction[]) sites[a] = sites[a].filter((x) => x !== parsed.value);
        sites[keep].push(parsed.value);
        seen.set(parsed.value, keep);
        return;
      }
      if (!prev) {
        sites[action].push(parsed.value);
        seen.set(parsed.value, action);
      }
    };
    for (const { tag, action } of tagActions(p)) {
      for (const e of localSites.filter((x) => (x.tags ?? []).includes(tag))) add(e, action);
    }
    // A Website Management category override puts a site in a classic category in every policy.
    // Profiles have no overrides, so it becomes a site list entry with this policy's action for that category.
    const alwaysBlocked: string[] = [];
    const noAction: string[] = [];
    let follows = 0;
    for (const e of localSites.filter((x) => x.categoryId !== undefined)) {
      const o = classicOverrideAction(e.categoryId!, (p.settings ?? {}) as never, baseSettings as never, filtering);
      if (!o.action) {
        noAction.push(`${e.url} (${o.label})`);
        continue;
      }
      if (o.how === "always-blocked") alwaysBlocked.push(`${e.url} (${o.label})`);
      if (o.how === "follows-37") follows++;
      add(e, o.action);
    }
    if (alwaysBlocked.length) flags.push(`${alwaysBlocked.length} Website Management ${alwaysBlocked.length === 1 ? "entry overrides its" : "entries override their"} category to one classic always blocks (${alwaysBlocked.slice(0, 3).join(", ")}); ${alwaysBlocked.length === 1 ? "it goes" : "they go"} into a Block site list.`);
    if (noAction.length) flags.push(`${noAction.length} category ${noAction.length === 1 ? "override has" : "overrides have"} no action in this policy and ${noAction.length === 1 ? "isn't" : "aren't"} carried over: ${noAction.slice(0, 3).join(", ")}.`);
    if (follows) flags.push(`${follows} category ${follows === 1 ? "override uses" : "overrides use"} Anonymizing Proxies or Translation Services, which classic policies set through "Proxies and translators"; the tool used that action.`);
    if (heldBroad.length) flags.push(`${heldBroad.length} broad ${heldBroad.length === 1 ? "entry is" : "entries are"} held back until you decide ${heldBroad.length === 1 ? "it" : "them"} in the clean-up step: ${heldBroad.slice(0, 3).join(", ")}.`);
    if (aiEntries.length) {
      flags.push(`Website Management already acts on AI services (${[...new Set(aiEntries)].slice(0, 5).join(", ")}). Retest these against the Generative AI category.`);
    }
    d.sites = sites;
    if (d.mode === "sites-only" && sites.allow.length + sites.block.length + sites.warn.length === 0) {
      d.skipped = "Category filtering is off and it has no site exceptions, so a profile would add nothing.";
    }
    policies.push(d);
  }

  if (!cleanup) warnings.push("The clean-up step hasn't run, so every Website Management entry a policy uses goes into the site lists. Run the clean-up first to keep only real exceptions.");

  // Group policies whose profiles would be identical.
  const groupsByKey = new Map<string, PolicyDesign[]>();
  for (const d of policies.filter((x) => !x.skipped)) {
    const cat = d.mode === "sites-only" ? "off" : JSON.stringify(compress(catalog, d.categoryActions ?? {}));
    const sitesKey = JSON.stringify(["block", "warn", "allow"].map((a) => [...(d.sites?.[a as FilterAction] ?? [])].sort()));
    const key = hash(`${d.type === "server-web-control" ? "server" : "computer"}|${cat}|${sitesKey}`);
    groupsByKey.set(key, [...(groupsByKey.get(key) ?? []), d]);
  }

  let profileGroups = [...groupsByKey.values()];
  const room = Math.max(0, PROFILE_LIMIT - opts.existingProfiles);
  // Merge the two closest profiles until they fit.
  while (profileGroups.length > room && profileGroups.length > 1) {
    let best: [number, number, number] | null = null;
    for (let i = 0; i < profileGroups.length; i++) {
      for (let j = i + 1; j < profileGroups.length; j++) {
        const a = profileGroups[i]![0]!.categoryActions ?? {};
        const b = profileGroups[j]![0]!.categoryActions ?? {};
        const dist = differences(a, b, catalog).length;
        if (!best || dist < best[2]) best = [i, j, dist];
      }
    }
    const [i, j, dist] = best!;
    const merged = [...profileGroups[i]!, ...profileGroups[j]!];
    warnings.push(`Merged the profiles for ${merged.map((d) => `"${d.policyName}"`).join(" and ")} to stay within ${PROFILE_LIMIT} profiles; they differed in ${dist} categories. The first policy's settings win.`);
    profileGroups = profileGroups.filter((_, k) => k !== i && k !== j);
    profileGroups.push(merged);
  }

  const siteLists: SiteListPlan[] = [];
  const profiles: ProfilePlan[] = [];
  const usedNames = new Set<string>();
  const uniqueName = (base: string, suffix: string) => {
    let name = fitName(base, suffix);
    let k = 2;
    while (usedNames.has(name.toLowerCase())) name = fitName(base, `${suffix} ${k++}`);
    usedNames.add(name.toLowerCase());
    return name;
  };
  const priority: Record<FilterAction, number> = { block: 3, warn: 2, allow: 1 };

  for (const group of profileGroups) {
    const lead = group[0]!;
    const leadName = `${lead.policyName}${lead.type === "server-web-control" ? " (server)" : ""}`;
    const name = uniqueName(leadName, group.length === 1 ? " profile" : ` +${group.length - 1} profile`);
    const actions = lead.categoryActions ?? {};
    const sourcePolicies = group.map((d) => ({ id: d.policyId, name: d.policyName, type: d.type }));
    const description = `From classic ${group.length === 1 ? "policy" : "policies"} ${group.map((d) => `"${d.policyName}"`).join(", ")}. Owner: to confirm. Reason: to confirm. Made by the Web Profiles Assistant (unofficial) on ${opts.date}.`.slice(0, DESCRIPTION_MAX);
    const lists: ProfilePlan["siteLists"] = [];
    for (const action of ["block", "warn", "allow"] as FilterAction[]) {
      const sites = [...new Set(group.flatMap((d) => d.sites?.[action] ?? []))];
      const parts = Math.ceil(sites.length / SITES_PER_LIST);
      for (let i = 0; i < parts; i++) {
        const chunk = sites.slice(i * SITES_PER_LIST, (i + 1) * SITES_PER_LIST);
        const sig = `${action}|${[...chunk].sort().join(",")}`;
        let list = siteLists.find((l) => `${l.action}|${[...l.sites].sort().join(",")}` === sig);
        if (!list) {
          list = {
            key: `list-${hash(sig)}`,
            name: uniqueName(leadName, ` ${ACTION_WORD[action]}${parts > 1 ? ` ${i + 1}` : ""}`),
            description: `${ACTION_WORD[action]} exceptions from Website Management, kept after clean-up. Made by the Web Profiles Assistant (unofficial) on ${opts.date}.`,
            action,
            sites: chunk,
          };
          siteLists.push(list);
        }
        lists.push({ listKey: list.key, action, priority: priority[action] * 10 + (parts - i) });
      }
    }
    const mode = lead.mode ?? "custom";
    const flags = [...new Set(group.flatMap((d) => d.flags))];
    if (group.length > 1) flags.unshift(`Shared by ${group.length} classic policies.`);
    const body: Record<string, unknown> = { name, description };
    if (mode === "sites-only") body.filterByCategory = false;
    else if (mode === "preset") Object.assign(body, { filterByCategory: true, preset: lead.nearestPreset!.name });
    else Object.assign(body, { filterByCategory: true, ...compress(catalog, actions) });
    body.filterBySiteList = lists.length > 0;
    profiles.push({
      key: `profile-${hash(name)}`,
      name,
      description,
      mode,
      preset: mode === "preset" ? lead.nearestPreset!.name : undefined,
      categoryActions: actions,
      sourcePolicies,
      siteLists: lists,
      diff: mode === "sites-only" ? [] : diffRows(catalog, lead.reading, actions),
      flags,
      body,
    });
  }

  if (profiles.some((p) => p.siteLists.length > LISTS_PER_PROFILE)) warnings.push(`A profile needs more than ${LISTS_PER_PROFILE} site lists. Clean up its entries first.`);
  const listRoom = SITE_LIST_LIMIT - opts.existingSiteLists;
  if (siteLists.length > listRoom) {
    warnings.push(`The plan needs ${siteLists.length} site lists and the account has room for ${Math.max(0, listRoom)} (20 per account, shared by every profile). Clean up first, or merge tags.`);
  }
  if (profiles.length + opts.existingProfiles > PROFILE_LIMIT) warnings.push(`There's room for ${room} more profiles.`);

  return {
    policies,
    profiles,
    siteLists,
    warnings,
    limits: {
      profiles: { planned: profiles.length, existing: opts.existingProfiles, limit: PROFILE_LIMIT },
      siteLists: { planned: siteLists.length, existing: opts.existingSiteLists, limit: SITE_LIST_LIMIT },
    },
    cleanedUp: !!cleanup,
  };
}

/** Recommended risky file types, as the API's defaults read back on 13/10/2026. */
export const RECOMMENDED_FILETYPES: Record<string, FilterAction> = {
  "archive-jar": "block",
  "exe-com": "block",
  "exe-dll": "block",
  "exe-javabytecode": "block",
  "exe-ocx": "block",
  "exe-unknown": "block",
  "exe-exe": "warn",
  "exe-msi": "warn",
  "doc-pdf": "allow",
  "video-flv": "allow",
};

export interface PilotTargets {
  users?: string[];
  userGroups?: string[];
  endpoints?: string[];
  endpointGroups?: string[];
}

/**
 * appliesTo for a pilot policy, as the API takes it (retested 13/10/2026):
 * users and user groups, or devices and device groups, never both kinds; and
 * always both keys of a pair, because endpointGroups sent without endpoints
 * returns 500.
 */
export function appliesToFor(t: PilotTargets): { users: string[]; userGroups: string[] } | { endpoints: string[]; endpointGroups: string[] } {
  const user = (t.users?.length ?? 0) + (t.userGroups?.length ?? 0);
  const device = (t.endpoints?.length ?? 0) + (t.endpointGroups?.length ?? 0);
  if (user && device) throw new Error("A policy applies to users and user groups, or to devices and device groups, not both.");
  if (device) return { endpoints: t.endpoints ?? [], endpointGroups: t.endpointGroups ?? [] };
  return { users: t.users ?? [], userGroups: t.userGroups ?? [] };
}

/** The pilot policy body: web profile on, logging on, Recommended file types, top of the order. */
export function pilotPolicyBody(name: string, profileId: string, targets: PilotTargets, enabled: boolean): Record<string, unknown> {
  const settings: Record<string, { value: unknown }> = {
    "endpoint.web-control.web-profile.enabled": { value: true },
    "endpoint.web-control.filter-by-web-profile.enabled": { value: true },
    "endpoint.web-control.web-profile-id": { value: profileId },
    "endpoint.web-control.web-profile-log-web-events.enabled": { value: true },
  };
  for (const [k, v] of Object.entries(RECOMMENDED_FILETYPES)) settings[`endpoint.web-control.filetypes.${k}.action`] = { value: v };
  return { name, type: "web-control", enabled, priority: 1, appliesTo: appliesToFor(targets), settings };
}

/** The profile body with real site list ids, as POST /web-filters/v1/profiles takes it. */
export function profileBody(plan: ProfilePlan, listIds: Record<string, string>): Record<string, unknown> {
  const body = { ...plan.body };
  if (plan.siteLists.length) {
    body.filterBySiteList = true;
    body.siteListActions = plan.siteLists.map((l) => {
      const id = listIds[l.listKey];
      if (!id) throw new Error(`No site list id for ${l.listKey}.`);
      return { id, action: l.action, priority: l.priority };
    });
  }
  return body;
}

/** Checks a profile body against the coverage rule before it is sent. Returns problems, empty when fine. */
export function checkProfileBody(catalog: Catalog, body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (body.filterByCategory !== true) return problems;
  if (body.preset) {
    if (!catalog.presets.some((p) => p.name === body.preset)) problems.push(`Unknown preset ${String(body.preset)}.`);
    if (body.categoryActions || body.categoryGroupActions) problems.push("A preset can't be combined with category actions.");
    return problems;
  }
  const groupActs = (body.categoryGroupActions as Array<{ name: string }> | undefined) ?? [];
  const catActs = (body.categoryActions as Array<{ name: string }> | undefined) ?? [];
  const covered = expand(catalog, body as never);
  const missing = catalog.categories.filter((c) => !(c.name in covered)).map((c) => c.name);
  if (missing.length) problems.push(`Category actions missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}.`);
  const groupNames = new Set(groupActs.map((g) => g.name));
  const doubled = catActs.filter((a) => {
    const g = catalog.categories.find((c) => c.name === a.name)?.group;
    return g && groupNames.has(g);
  });
  if (doubled.length) problems.push(`Set at group level and again by category: ${doubled.map((d) => d.name).join(", ")}.`);
  return problems;
}
