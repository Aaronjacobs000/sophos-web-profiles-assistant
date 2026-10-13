/**
 * The readiness scorecard: requirements, inventory, Website Management,
 * profiles and pilot settings, run against one tenant's inventory. Each item
 * says what was found and what to fix, and carries a plain topic label.
 *
 * Severities:
 *   fix   blocks a pilot (no eligible device, decryption off, a section the
 *         tool could not read, a policy pointing at a missing profile)
 *   plan  work to plan around before or during the conversion
 *   ok    checked and fine
 *   info  a manual check the API can't answer, or context
 *
 * Pure: no Node or browser imports.
 */

import { summariseEligibility, type EligibilitySummary } from "./eligibility.js";
import { broadness, needsRewrite, parseSite } from "./sites.js";
import { CLASSIC_ALWAYS_BLOCKED } from "./categories.js";
import { CLASSIC_CATEGORIES } from "./categories-data.js";
import {
  SECTION_LABELS,
  isBasePolicy,
  sectionData,
  settingValue,
  targetCount,
  targetsOf,
  usesWebProfile,
  type Inventory,
  type SectionKey,
  type Targets,
} from "./inventory.js";
import type { Policy } from "../sophos/api/policies.js";

export type Severity = "fix" | "plan" | "ok" | "info";

export interface ScoreItem {
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  fix?: string;
  /** Names, hosts or entries behind the finding, at most 25. */
  evidence?: string[];
  evidenceMore?: number;
  /** A plain topic label for grouping: Requirements, Inventory, Website Management, Profiles, Pilot, Decryption, Classic settings. */
  topic: string;
}

export interface PolicyRow {
  id: string;
  name: string;
  type: string;
  priority: number;
  enabled: boolean;
  base: boolean;
  mode: "profile" | "classic";
  profileId: string | null;
  logging: boolean | null;
  tags: number;
  assignedTo: string;
  targets: Targets;
}

export interface TagRow {
  tag: string;
  entries: number;
  actions: Array<{ policy: string; action: string }>;
}

export interface Facts {
  eligibility: EligibilitySummary | null;
  policies: PolicyRow[];
  websiteManagement: {
    entries: number;
    tags: number;
    categoryOverrides: number;
    byAction: { allow: number; block: number; warn: number; mixed: number; none: number; override: number };
    tagRows: TagRow[];
  } | null;
  profiles: { count: number; limit: number } | null;
  siteLists: { count: number; sites: number } | null;
  decryption: Array<{ policy: string; type: string; enabled: boolean; decryption: boolean | null; quic: boolean | null }>;
}

export interface Scorecard {
  verdict: "ready" | "fixes" | "unreadable";
  headline: string;
  summary: string;
  counts: Record<Severity, number>;
  items: ScoreItem[];
  facts: Facts;
  unread: Array<{ section: string; label: string; status?: number; error: string }>;
}

export const PROFILE_LIMIT = 20;
export const LISTS_PER_PROFILE_LIMIT = 20;
export const SITES_PER_LIST_LIMIT = 750;
/** Per account, measured on 13/10/2026: the 21st create returns 400 "Site list maximum quota reached". */
export const SITE_LIST_LIMIT = 20;

const WC = "endpoint.web-control.";
const TP = "endpoint.threat-protection.";
const MAX_EVIDENCE = 25;

function evidence(list: string[]): Pick<ScoreItem, "evidence" | "evidenceMore"> {
  if (list.length <= MAX_EVIDENCE) return { evidence: list };
  return { evidence: list.slice(0, MAX_EVIDENCE), evidenceMore: list.length - MAX_EVIDENCE };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "the", "both" or "all N" in front of a plural noun. */
function every(n: number, one: string, many: string): string {
  if (n === 1) return `the ${one}`;
  if (n === 2) return `both ${many}`;
  return `all ${n.toLocaleString("en-US")} ${many}`;
}

function isAre(n: number): string {
  return n === 1 ? "is" : "are";
}

function listNames(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length <= 2) return quoted.join(" and ");
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

/** Top of the order first; the Base policy last, as Sophos Fusion lists them. */
export function policyOrder(a: Policy, b: Policy): number {
  const pa = isBasePolicy(a) ? Number.MAX_SAFE_INTEGER : a.priority ?? Number.MAX_SAFE_INTEGER - 1;
  const pb = isBasePolicy(b) ? Number.MAX_SAFE_INTEGER : b.priority ?? Number.MAX_SAFE_INTEGER - 1;
  return pa - pb || a.name.localeCompare(b.name);
}

function describeTargets(t: Targets, base: boolean): string {
  if (base) return "everyone else";
  const parts: string[] = [];
  if (t.users.length) parts.push(plural(t.users.length, "user"));
  if (t.userGroups.length) parts.push(plural(t.userGroups.length, "user group"));
  if (t.endpoints.length) parts.push(plural(t.endpoints.length, "device"));
  if (t.endpointGroups.length) parts.push(plural(t.endpointGroups.length, "device group"));
  return parts.length ? parts.join(", ") : "no one";
}

function loggingOn(policy: Policy): boolean | null {
  if (usesWebProfile(policy)) {
    const v = settingValue<boolean>(policy, `${WC}web-profile-log-web-events.enabled`);
    return v === undefined ? null : v;
  }
  const v = settingValue<string | boolean>(policy, `${WC}web-monitoring.enabled`);
  if (v === undefined) return null;
  return v === true || v === "yes";
}

function tagSettings(policy: Policy): Array<{ tag: string; action: string }> {
  const v = settingValue<Array<{ tag: string; action: string }>>(policy, `${WC}tags.settings`);
  return Array.isArray(v) ? v : [];
}

function policyRow(p: Policy): PolicyRow {
  const base = isBasePolicy(p);
  const targets = targetsOf(p);
  const profileId = settingValue<string>(p, `${WC}web-profile-id`) || null;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    priority: p.priority ?? 0,
    enabled: p.enabled !== false,
    base,
    mode: usesWebProfile(p) ? "profile" : "classic",
    profileId,
    logging: loggingOn(p),
    tags: tagSettings(p).length,
    assignedTo: describeTargets(targets, base),
    targets,
  };
}

function settingsKey(p: Policy): string {
  const s = p.settings ?? {};
  return JSON.stringify(
    Object.keys(s)
      .sort()
      .map((k) => [k, s[k]?.value]),
  );
}

/** Builds the scorecard. `tenantName` heads the headline. */
export function buildScorecard(inv: Inventory): Scorecard {
  const items: ScoreItem[] = [];
  const push = (item: ScoreItem) => items.push(item);

  // ---------- unreadable sections ----------
  const unread: Scorecard["unread"] = [];
  for (const key of Object.keys(SECTION_LABELS) as SectionKey[]) {
    const section = inv[key];
    if (!section.ok) unread.push({ section: key, label: SECTION_LABELS[key], status: section.status, error: section.error });
  }

  const endpoints = sectionData(inv.endpoints);
  const wcPolicies = sectionData(inv.webControlPolicies);
  const swcPolicies = sectionData(inv.serverWebControlPolicies);
  const tpPolicies = sectionData(inv.threatProtectionPolicies);
  const stpPolicies = sectionData(inv.serverThreatProtectionPolicies);
  const localSites = sectionData(inv.localSites);
  const tls = sectionData(inv.tlsDecryption);
  const exclusions = sectionData(inv.scanningExclusions);
  const profiles = sectionData(inv.profiles);
  const siteLists = sectionData(inv.siteLists);
  const endpointGroups = sectionData(inv.endpointGroups);
  const userGroups = sectionData(inv.userGroups);
  const users = sectionData(inv.referencedUsers);

  // Computer policies first, then server, each in Fusion's order.
  const kindRank = (p: Policy) => (p.type.startsWith("server-") ? 1 : 0);
  const webPolicies = [...(wcPolicies ?? []), ...(swcPolicies ?? [])].sort((a, b) => kindRank(a) - kindRank(b) || policyOrder(a, b));
  const threatPolicies = [...(tpPolicies ?? []), ...(stpPolicies ?? [])].sort((a, b) => kindRank(a) - kindRank(b) || policyOrder(a, b));

  // Every section refused: nothing to score.
  const readable = Object.keys(SECTION_LABELS).length - unread.length;
  if (readable === 0) {
    const first = unread[0];
    return {
      verdict: "unreadable",
      headline: `${inv.tenant.name} could not be read`,
      summary: `Every read was refused${first?.status ? ` (${first.status})` : ""}. ${first?.error ?? ""}`.trim(),
      counts: { fix: 1, plan: 0, ok: 0, info: 0 },
      items: [
        {
          id: "unreadable",
          severity: "fix",
          title: "The API credential can't read this tenant",
          detail: first?.error,
          fix: "Check the credential's role and that the tenant's licenses include Sophos Endpoint. A partner credential needs access to the tenant.",
          topic: "Requirements",
        },
      ],
      facts: { eligibility: null, policies: [], websiteManagement: null, profiles: null, siteLists: null, decryption: [] },
      unread,
    };
  }

  for (const u of unread) {
    push({
      id: `unread-${u.section}`,
      severity: "fix",
      title: `Couldn't read ${u.label}${u.status ? ` (${u.status})` : ""}`,
      detail: `The checks that need ${u.label} are skipped. ${u.error}`,
      fix:
        u.status === 403
          ? "Give the API credential a role that can read this, or check that the tenant's licenses include it, then run the check again."
          : "Run the check again. If it keeps failing, the Logs page has the details.",
      topic: "Inventory",
    });
  }

  // ---------- Requirements: eligible devices ----------
  const eligibility = endpoints ? summariseEligibility(endpoints) : null;
  if (eligibility) {
    const e = eligibility;
    const old = e.byReason["windows-old-agent"] + e.byReason["windows-no-agent-version"];
    const mac = e.byReason.macos;
    const other = e.byReason.other;
    if (e.inScope === 0) {
      push({
        id: "devices-none",
        severity: "info",
        title: "No Windows or macOS devices in this tenant",
        detail: e.byReason.linux ? `${plural(e.byReason.linux, "Linux device")} found. Web Control doesn't apply to Linux.` : undefined,
        topic: "Requirements",
      });
    } else if (e.eligible === 0) {
      push({
        id: "eligible-none",
        severity: "fix",
        title: "No device can use web filtering profiles yet",
        detail: `Profiles need Windows with Sophos Endpoint ${"2026.1"} or later. None of the ${plural(e.inScope, "device")} qualifies.`,
        fix: "Upgrade a pilot group of Windows devices to Sophos Endpoint 2026.1 or later before you start.",
        ...evidence(e.oldWindowsVersions.map((v) => `${v.count} on ${v.version}`)),
        topic: "Requirements",
      });
    }
    if (e.eligible > 0 && e.ineligibleTotal > 0) {
      const parts: string[] = [];
      if (mac) parts.push(plural(mac, "macOS device"));
      if (old) parts.push(`${plural(old, "Windows device")} below Sophos Endpoint 2026.1`);
      if (other) parts.push(plural(other, "device") + " on another platform");
      push({
        id: "eligible-partial",
        severity: "plan",
        title: `${plural(e.ineligibleTotal, "device")} can't use profiles yet`,
        detail: `${parts.join(", ")}. A profile policy doesn't apply to them; they fall back to the next Web Control policy that does.`,
        fix: "Keep a classic Web Control policy in place for these devices, and reconfirm agent versions before each wave.",
        ...evidence(e.ineligible.map((d) => `${d.hostname}: ${d.reason === "macos" ? "macOS" : d.coreAgent ? `Windows, ${d.coreAgent}` : `${d.platform === "windows" ? "Windows" : d.platform}, no agent version`}`)),
        evidenceMore: Math.max(0, e.ineligibleTotal - Math.min(e.ineligible.length, MAX_EVIDENCE)) || undefined,
        topic: "Requirements",
      });
    } else if (e.eligible > 0) {
      push({
        id: "eligible-all",
        severity: "ok",
        title: `All ${plural(e.inScope, "device")} can use profiles`,
        topic: "Requirements",
      });
    }
  }

  // ---------- Requirements: HTTPS decryption and QUIC ----------
  const decryption: Facts["decryption"] = threatPolicies.map((p) => ({
    policy: p.name,
    type: p.type,
    enabled: p.enabled !== false,
    decryption: settingValue<boolean>(p, `${TP}web-control.tls-decryption.enabled`) ?? null,
    quic: settingValue<boolean>(p, `${TP}web-control.tls-decryption.quic.enabled`) ?? null,
  }));
  const liveThreat = decryption.filter((d) => d.enabled);
  const threatLabel = (d: Facts["decryption"][number]) => (d.type === "server-threat-protection" ? `${d.policy} (server)` : d.policy);
  if (tpPolicies || stpPolicies) {
    const off = liveThreat.filter((d) => d.decryption === false);
    if (liveThreat.length > 0 && off.length === liveThreat.length) {
      push({
        id: "decryption-off",
        severity: "fix",
        title: `HTTPS decryption is off in ${every(liveThreat.length, "Threat Protection policy", "Threat Protection policies")}`,
        detail: "Warn pages and Generative AI warnings don't show without it, and category checks are less effective on HTTPS.",
        fix: "Turn on SSL/TLS decryption of HTTPS websites in the Threat Protection policy for the pilot devices before the pilot.",
        ...evidence(off.map(threatLabel)),
        topic: "Requirements",
      });
    } else if (off.length > 0) {
      push({
        id: "decryption-partial",
        severity: "plan",
        title: `HTTPS decryption is off in ${plural(off.length, "Threat Protection policy", "Threat Protection policies")}`,
        detail: "Devices under these policies won't show warn pages.",
        fix: "Turn decryption on in these policies before their devices join a wave, or keep those devices out of Warn rules.",
        ...evidence(off.map(threatLabel)),
        topic: "Requirements",
      });
    } else if (liveThreat.length > 0) {
      push({ id: "decryption-on", severity: "ok", title: "HTTPS decryption is on in every Threat Protection policy", topic: "Requirements" });
    }

    const quicOff = liveThreat.filter((d) => d.quic === false);
    if (quicOff.length > 0) {
      push({
        id: "quic-off",
        severity: "plan",
        title:
          quicOff.length === liveThreat.length
            ? `Block QUIC is off in ${every(quicOff.length, "Threat Protection policy", "Threat Protection policies")}`
            : `Block QUIC is off in ${plural(quicOff.length, "Threat Protection policy", "Threat Protection policies")}`,
        detail: "Block QUIC stops browser traffic that uses the QUIC protocol (HTTP/3). It sits beside SSL/TLS decryption in the Threat Protection policy; with it on, browsers use HTTPS over TCP, which decryption can inspect.",
        fix: "Turn on Block QUIC in the same Threat Protection policies where you turn on decryption.",
        ...evidence(quicOff.map(threatLabel)),
        topic: "Requirements",
      });
    } else if (liveThreat.length > 0 && liveThreat.every((d) => d.quic === true)) {
      push({ id: "quic-on", severity: "ok", title: "Block QUIC is on in every Threat Protection policy", topic: "Requirements" });
    }
  }

  if (tls) {
    const excludedCategories = (tls.categories ?? []).filter((c) => c.decryptionEnabled === false).map((c) => c.name);
    const excludedSites = tls.excludedWebsiteItems
      .map((w) => String(w.value ?? w.url ?? w.site ?? w.id ?? ""))
      .filter(Boolean);
    if (excludedCategories.length || excludedSites.length) {
      push({
        id: "decryption-exclusions",
        severity: "info",
        title: `Review decryption exclusions: ${[
          excludedCategories.length ? plural(excludedCategories.length, "category", "categories") : "",
          excludedSites.length ? plural(excludedSites.length, "website") : "",
        ]
          .filter(Boolean)
          .join(" and ")} not decrypted`,
        detail: "Warn pages can't show on sites that aren't decrypted.",
        fix: "Confirm each exclusion is still needed before the pilot.",
        ...evidence([...excludedCategories.map((c) => `Category: ${c}`), ...excludedSites]),
        topic: "Decryption",
      });
    } else {
      push({ id: "decryption-exclusions-none", severity: "ok", title: "No decryption exclusions to review", topic: "Decryption" });
    }
  }

  // ---------- Pilot: threat-check web exclusions ----------
  if (exclusions || threatPolicies.length) {
    const global = (exclusions ?? []).filter((x) => x.type === "web").map((x) => x.value);
    const inPolicy: string[] = [];
    for (const p of threatPolicies) {
      const list = settingValue<Array<{ value: string; type: string }>>(p, `${TP}exclusions.scanning`) ?? [];
      for (const x of list) if (x.type === "web") inPolicy.push(`${x.value} (${p.name})`);
    }
    const all = [...global, ...inPolicy];
    if (all.length > 0) {
      push({
        id: "web-exclusions",
        severity: "plan",
        title: `${plural(all.length, "website exclusion")} ${all.length === 1 ? "bypasses" : "bypass"} Web Control`,
        detail: "Web Control doesn't apply to sites excluded from threat checks, so no profile will filter them.",
        fix: "Review each one and remove any that are no longer needed.",
        ...evidence(all),
        topic: "Pilot",
      });
    } else if (exclusions) {
      push({ id: "web-exclusions-none", severity: "ok", title: "No website exclusions bypass Web Control", topic: "Pilot" });
    }
  }

  // ---------- Inventory: policies, order, assignments ----------
  const rows = webPolicies.map(policyRow);
  const enabledRows = rows.filter((r) => r.enabled);

  // Logging
  if (webPolicies.length) {
    const off = enabledRows.filter((r) => r.logging === false);
    if (off.length) {
      push({
        id: "logging-off",
        severity: "plan",
        title: `Logging is off in ${plural(off.length, "Web Control policy", "Web Control policies")}`,
        detail: "Only visits to infected sites are logged, so there is nothing to tune from.",
        fix: "Turn on Log web control events, and leave it on in the pilot policy.",
        ...evidence(off.map((r) => r.name)),
        topic: "Pilot",
      });
    } else {
      push({
        id: "logging-on",
        severity: "ok",
        title: `Logging is on in ${every(enabledRows.length, "active Web Control policy", "active Web Control policies")}`,
        topic: "Pilot",
      });
    }
  }

  // Policies that apply to no one: disabled, or assigned to nothing.
  const idle = rows.filter((r) => !r.base && (!r.enabled || targetCount(r.targets) === 0));
  if (idle.length) {
    push({
      id: "idle-policies",
      severity: "plan",
      title: `${plural(idle.length, "Web Control policy", "Web Control policies")} ${isAre(idle.length)} disabled or assigned to no one`,
      detail: "They don't filter anything today. Sophos drops a deleted user or group from a policy's assignment straight away, so a policy whose people have all gone shows up here.",
      fix: "Retire the ones that no longer match a group, so you don't convert them.",
      ...evidence(idle.map((r) => `${r.name}: ${!r.enabled ? "disabled" : "no assignment"}`)),
      topic: "Inventory",
    });
  }

  // Duplicates: same type, same settings.
  const dupGroups = new Map<string, PolicyRow[]>();
  for (const p of webPolicies) {
    if (isBasePolicy(p)) continue;
    const key = `${p.type}|${settingsKey(p)}`;
    const row = rows.find((r) => r.id === p.id)!;
    dupGroups.set(key, [...(dupGroups.get(key) ?? []), row]);
  }
  const dups = [...dupGroups.values()].filter((g) => g.length > 1);
  if (dups.length) {
    push({
      id: "duplicate-policies",
      severity: "plan",
      title: `${plural(dups.reduce((n, g) => n + g.length, 0), "policy", "policies")} duplicate another policy's settings`,
      detail: "Policies with identical settings become identical profiles.",
      fix: "Merge duplicates before you design profiles.",
      ...evidence(dups.map((g) => g.map((r) => `"${r.name}" (priority ${r.priority})`).join(" = "))),
      topic: "Inventory",
    });
  }

  // Shadowed: every explicit target is already covered by a higher, enabled policy of the same type.
  const shadowed: string[] = [];
  for (const type of new Set(webPolicies.map((p) => p.type))) {
    const ordered = rows.filter((r) => r.type === type && !r.base).sort((a, b) => a.priority - b.priority);
    const above: Record<keyof Targets, Set<string>> = { users: new Set(), userGroups: new Set(), endpoints: new Set(), endpointGroups: new Set() };
    for (const r of ordered) {
      if (r.enabled && targetCount(r.targets) > 0) {
        const covered = (Object.keys(above) as Array<keyof Targets>).every((k) => r.targets[k].every((id) => above[k].has(id)));
        if (covered) shadowed.push(`${r.name} (priority ${r.priority})`);
      }
      if (r.enabled) for (const k of Object.keys(above) as Array<keyof Targets>) r.targets[k].forEach((id) => above[k].add(id));
    }
  }
  if (shadowed.length) {
    push({
      id: "shadowed-policies",
      severity: "plan",
      title: `${plural(shadowed.length, "policy", "policies")} ${isAre(shadowed.length)} shadowed by a policy above ${shadowed.length === 1 ? "it" : "them"}`,
      detail: "Every user, group or device they're assigned to is already assigned to a higher policy, which wins.",
      fix: "Merge or retire them. Check the order after every change.",
      ...evidence(shadowed),
      topic: "Inventory",
    });
  }

  // Assignments to users or groups that no longer exist, or groups with no members.
  const gone: string[] = [];
  const empty: string[] = [];
  const userIdsFound = users ? new Set(users.found.map((u) => u.id)) : null;
  const userGroupById = userGroups ? new Map(userGroups.map((g) => [g.id, g])) : null;
  const endpointGroupById = endpointGroups ? new Map(endpointGroups.map((g) => [g.id, g])) : null;
  const endpointIds = endpoints ? new Set(endpoints.map((d) => d.id)) : null;
  for (const r of rows) {
    if (r.base) continue;
    const t = r.targets;
    const missingUsers = userIdsFound ? t.users.filter((id) => !userIdsFound.has(id)).length : 0;
    const missingUserGroups = userGroupById ? t.userGroups.filter((id) => !userGroupById.has(id)).length : 0;
    const missingEndpointGroups = endpointGroupById ? t.endpointGroups.filter((id) => !endpointGroupById.has(id)).length : 0;
    const missingEndpoints = endpointIds ? t.endpoints.filter((id) => !endpointIds.has(id)).length : 0;
    const missing = [
      missingUsers ? plural(missingUsers, "deleted user") : "",
      missingUserGroups ? plural(missingUserGroups, "deleted user group") : "",
      missingEndpointGroups ? plural(missingEndpointGroups, "deleted device group") : "",
      missingEndpoints ? plural(missingEndpoints, "deleted device") : "",
    ].filter(Boolean);
    if (missing.length) gone.push(`${r.name}: ${missing.join(", ")}`);

    const emptyUserGroups = userGroupById
      ? t.userGroups.filter((id) => {
          const g = userGroupById.get(id);
          return g && (g.users?.total ?? 1) === 0 && (g.groups?.total ?? 0) === 0;
        })
      : [];
    const emptyEndpointGroups = endpointGroupById
      ? t.endpointGroups.filter((id) => {
          const g = endpointGroupById.get(id);
          return g && g.endpoints?.total === 0;
        })
      : [];
    const names = [
      ...emptyUserGroups.map((id) => userGroupById!.get(id)!.name),
      ...emptyEndpointGroups.map((id) => endpointGroupById!.get(id)!.name),
    ];
    if (names.length) {
      const onlyEmpty =
        t.users.length === 0 && t.endpoints.length === 0 && names.length === t.userGroups.length + t.endpointGroups.length;
      empty.push(`${r.name}: ${listNames(names)}${onlyEmpty ? " (nothing else assigned)" : ""}`);
    }
  }
  if (gone.length) {
    push({
      id: "deleted-assignments",
      severity: "plan",
      title: `${plural(gone.length, "policy", "policies")} ${isAre(gone.length)} assigned to users, groups or devices that no longer exist`,
      fix: "Reassign or delete these policies before you convert them.",
      ...evidence(gone),
      topic: "Inventory",
    });
  }
  if (empty.length) {
    push({
      id: "empty-groups",
      severity: "plan",
      title: `${plural(empty.length, "policy", "policies")} ${isAre(empty.length)} assigned to empty groups`,
      fix: "Reassign or delete these policies before you convert them.",
      ...evidence(empty),
      topic: "Inventory",
    });
  }
  if (!gone.length && !empty.length && rows.some((r) => !r.base && targetCount(r.targets) > 0) && (userIdsFound || userGroupById)) {
    push({ id: "assignments-ok", severity: "ok", title: "Every assigned user and group still exists", topic: "Inventory" });
  }

  // Profile policies pointing at a profile that doesn't exist.
  if (profiles) {
    const profileIds = new Set(profiles.map((p) => p.id));
    const dangling = rows.filter((r) => r.mode === "profile" && r.profileId && !profileIds.has(r.profileId));
    if (dangling.length) {
      push({
        id: "missing-profile",
        severity: "fix",
        title: `${plural(dangling.length, "policy", "policies")} use a web filtering profile that doesn't exist`,
        fix: "Choose an existing profile in these policies.",
        ...evidence(dangling.map((r) => r.name)),
        topic: "Pilot",
      });
    }
  }

  // Time-based rules
  const scheduled = webPolicies.filter((p) => {
    const classic = settingValue<boolean>(p, `${WC}schedule.enabled`) === true;
    const profileSchedules = settingValue<unknown[]>(p, `${WC}web-profile-schedules`);
    return classic || (Array.isArray(profileSchedules) && profileSchedules.length > 0);
  });
  if (scheduled.length) {
    push({
      id: "schedules",
      severity: "info",
      title: `${plural(scheduled.length, "policy", "policies")} apply at set times only`,
      detail: "Schedules use the endpoint's local time, not your admin time zone.",
      fix: "Confirm each schedule still matches working hours in the devices' time zones.",
      ...evidence(scheduled.map((p) => p.name)),
      topic: "Inventory",
    });
  }

  // Classic settings with no profile equivalent: Additional security options (0 Uncategorized, 2 Advertisements) and Protect against data loss (10 Downloads, 54 Web-based email).
  const gapPolicies: string[] = [];
  for (const p of webPolicies) {
    if (p.enabled === false || usesWebProfile(p)) continue;
    if (settingValue<boolean>(p, `${WC}web-filtering.enabled`) === false) continue;
    const act = (id: number) => settingValue<string>(p, `${WC}categories.${id}.action`);
    const hits: string[] = [];
    if (act(2) && act(2) !== "allow") hits.push(`advertisements ${act(2)}`);
    if (act(0) && act(0) !== "allow") hits.push(`uncategorized ${act(0)}`);
    if (act(10) && act(10) !== "allow") hits.push(`downloads ${act(10)}`);
    if (act(54) && act(54) !== "allow") hits.push(`web email ${act(54)}`);
    if (hits.length) gapPolicies.push(`${p.name}: ${hits.join(", ")}`);
  }
  if (gapPolicies.length) {
    push({
      id: "gap-check",
      severity: "plan",
      title: `${plural(gapPolicies.length, "policy", "policies")} use Additional security options or Protect against data loss`,
      detail:
        "A profile has no setting with those names. Help says they cover ads, uncategorized sites, risky downloads, web email and file downloads; in the API that reads as classic categories 2, 0, 10 and 54 (inferred, not documented).",
      fix: "Set the matching profile categories (Advertisements, Uncategorized, Download freeware and shareware, Web e-mail) and keep Risky File Types on Recommended. Confirm the result in a test policy before you retire the classic one.",
      ...evidence(gapPolicies),
      topic: "Classic settings",
    });
  } else if (webPolicies.length) {
    push({
      id: "gap-check-none",
      severity: "ok",
      title: "No policy blocks ads, uncategorized sites, downloads, or web email the classic way",
      topic: "Classic settings",
    });
  }

  // ---------- Website Management ----------
  let websiteManagement: Facts["websiteManagement"] = null;
  if (localSites) {
    const tagActions = new Map<string, Array<{ policy: string; action: string; enabled: boolean }>>();
    for (const p of webPolicies) {
      for (const t of tagSettings(p)) {
        tagActions.set(t.tag, [...(tagActions.get(t.tag) ?? []), { policy: p.name, action: t.action, enabled: p.enabled !== false }]);
      }
    }
    const tagEntries = new Map<string, number>();
    for (const s of localSites) for (const t of s.tags ?? []) tagEntries.set(t, (tagEntries.get(t) ?? 0) + 1);

    const byAction = { allow: 0, block: 0, warn: 0, mixed: 0, none: 0, override: 0 };
    const broadAllows: string[] = [];
    const rewrite: string[] = [];
    const untagged: string[] = [];
    const seen = new Map<string, number>();
    for (const s of localSites) {
      const actions = new Set((s.tags ?? []).flatMap((t) => (tagActions.get(t) ?? []).map((a) => a.action)));
      // An entry no tag acts on still works if it overrides the site's category.
      if (actions.size === 0) byAction[s.categoryId !== undefined ? "override" : "none"]++;
      else if (actions.size > 1) byAction.mixed++;
      else byAction[[...actions][0] as "allow" | "block" | "warn"]++;

      const parsed = parseSite(s.url);
      if (needsRewrite(parsed)) rewrite.push(s.url);
      const allowedSomewhere = (s.tags ?? []).some((t) => (tagActions.get(t) ?? []).some((a) => a.action === "allow" && a.enabled));
      const b = broadness(parsed);
      if (allowedSomewhere && b.broad) broadAllows.push(`${s.url}: ${b.why}`);
      if ((s.tags ?? []).length === 0 && s.categoryId === undefined) untagged.push(s.url);
      if (parsed.value) seen.set(parsed.value, (seen.get(parsed.value) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([v, n]) => `${v} (${n} times)`);
    const overrides = localSites.filter((s) => s.categoryId !== undefined);
    const unusedTags = [...tagEntries.keys()].filter((t) => !(tagActions.get(t) ?? []).length).sort();
    const tagRows: TagRow[] = [...tagEntries.entries()]
      .map(([tag, entries]) => ({ tag, entries, actions: (tagActions.get(tag) ?? []).map((a) => ({ policy: a.policy, action: a.action })) }))
      .sort((a, b) => b.entries - a.entries || a.tag.localeCompare(b.tag));
    websiteManagement = { entries: localSites.length, tags: tagEntries.size, categoryOverrides: overrides.length, byAction, tagRows };

    if (localSites.length === 0) {
      push({ id: "website-management-empty", severity: "ok", title: "No Website Management entries to convert", topic: "Website Management" });
    } else {
      push({
        id: "website-management",
        severity: "info",
        title: `${plural(localSites.length, "Website Management entry", "Website Management entries")} in ${plural(tagEntries.size, "tag")} to review`,
        detail: `${[
          byAction.allow ? `${byAction.allow} allow` : "",
          byAction.block ? `${byAction.block} block` : "",
          byAction.warn ? `${byAction.warn} warn` : "",
          byAction.mixed ? `${byAction.mixed} with different actions in different policies` : "",
          byAction.override ? `${byAction.override} that ${byAction.override === 1 ? "works" : "work"} only through a category override` : "",
          byAction.none ? `${byAction.none} that no policy acts on` : "",
        ]
          .filter(Boolean)
          .join(", ")}.`,
        fix: "Check every entry against SophosLabs before you recreate it, and move only real exceptions into site lists. The clean-up step does both.",
        topic: "Website Management",
      });
    }
    if (overrides.length) {
      const label = (id: number) => CLASSIC_CATEGORIES.find((c) => c.id === id)?.label ?? `category ${id}`;
      const always = overrides.filter((x) => CLASSIC_ALWAYS_BLOCKED.has(x.categoryId!));
      const noProfile = overrides.filter((x) => !CLASSIC_ALWAYS_BLOCKED.has(x.categoryId!) && (CLASSIC_CATEGORIES.find((c) => c.id === x.categoryId)?.profile.length ?? 0) === 0);
      push({
        id: "category-overrides",
        severity: "plan",
        title: `${plural(overrides.length, "entry", "entries")} ${overrides.length === 1 ? "overrides" : "override"} a site's category`,
        detail: `Profiles have no category override, so each becomes a site list entry with the action its policy gives that category.${
          always.length ? ` ${plural(always.length, "entry puts a site", "entries put sites")} in Phishing & Fraud, Spam URLs or Spyware, which classic always blocks: ${always.length === 1 ? "it becomes a Block entry" : "they become Block entries"}.` : ""
        }${noProfile.length ? ` ${plural(noProfile.length, "entry uses a classic category", "entries use classic categories")} with no profile equivalent.` : ""}`,
        fix: "Check each override in the clean-up step; the design step carries the ones you keep into site lists.",
        ...evidence(overrides.map((x) => `${x.url}: ${label(x.categoryId!)}${CLASSIC_ALWAYS_BLOCKED.has(x.categoryId!) ? " (always blocked)" : ""}`)),
        topic: "Website Management",
      });
    }
    if (unusedTags.length) {
      const unused = new Set(unusedTags);
      const tagged = localSites.filter((s) => (s.tags ?? []).some((t) => unused.has(t)));
      const n = tagged.length;
      const withOverride = tagged.filter((s) => s.categoryId !== undefined).length;
      push({
        id: "unused-tags",
        severity: "plan",
        title: `${plural(unusedTags.length, "tag")} on ${plural(n, "entry", "entries")} ${unusedTags.length === 1 ? "isn't" : "aren't"} used by any policy`,
        detail: `No Web Control policy sets an action for ${unusedTags.length === 1 ? "this tag" : "these tags"}, so ${unusedTags.length === 1 ? "it does" : "they do"} nothing today.${withOverride ? ` ${plural(withOverride, "entry also overrides", "entries also override")} a site's category, which still applies.` : ""}`,
        fix: withOverride ? "Delete the tags. Keep or remove the category overrides on their own merits in the clean-up step." : "Delete them. Don't carry them forward.",
        ...evidence(unusedTags.map((t) => `${t} (${tagEntries.get(t)})`)),
        topic: "Website Management",
      });
    }
    if (untagged.length) {
      push({
        id: "untagged-entries",
        severity: "plan",
        title: `${plural(untagged.length, "entry", "entries")} ${untagged.length === 1 ? "has" : "have"} no tag and no category`,
        detail: "They do nothing today.",
        fix: "Delete them.",
        ...evidence(untagged),
        topic: "Website Management",
      });
    }
    if (duplicates.length) {
      push({
        id: "duplicate-entries",
        severity: "plan",
        title: `${plural(duplicates.length, "site")} ${duplicates.length === 1 ? "appears" : "appear"} more than once`,
        fix: "Keep one entry per site.",
        ...evidence(duplicates),
        topic: "Website Management",
      });
    }
    if (rewrite.length) {
      push({
        id: "rewrite-entries",
        severity: "plan",
        title: `${plural(rewrite.length, "entry", "entries")} need rewriting for a site list`,
        detail: "They carry http:// or https://, a *. wildcard, spaces, or characters a site list won't take. The site list API refuses *.example.com.",
        fix: "Use example.com, which also matches its subdomains, with no scheme.",
        ...evidence(rewrite),
        topic: "Website Management",
      });
    }
    if (broadAllows.length) {
      push({
        id: "broad-allows",
        severity: "plan",
        title: `${plural(broadAllows.length, "broad Allow entry", "broad Allow entries")}`,
        detail: "A site list always wins over a category, so a broad Allow bypasses category protection for everything it matches.",
        fix: "Narrow each one to the exact domain, or remove it.",
        ...evidence(broadAllows),
        topic: "Website Management",
      });
    } else if (byAction.allow + byAction.mixed > 0) {
      push({ id: "broad-allows-none", severity: "ok", title: "No broad Allow entries", topic: "Website Management" });
    }
    const ceiling = SITE_LIST_LIMIT * SITES_PER_LIST_LIMIT;
    if (localSites.length > ceiling) {
      push({
        id: "over-site-list-ceiling",
        severity: "plan",
        title: `More entries than site lists can hold`,
        detail: `${plural(localSites.length, "entry", "entries")}, and an account takes at most ${SITE_LIST_LIMIT} site lists of ${SITES_PER_LIST_LIMIT} sites (${ceiling.toLocaleString("en-US")}).`,
        fix: "Clean up first. Only real exceptions should move into site lists.",
        topic: "Website Management",
      });
    }
    const bigTags = tagRows.filter((t) => t.entries > SITES_PER_LIST_LIMIT);
    if (bigTags.length) {
      push({
        id: "large-tags",
        severity: "info",
        title: `${plural(bigTags.length, "tag")} ${bigTags.length === 1 ? "holds" : "hold"} more than ${SITES_PER_LIST_LIMIT} entries`,
        detail: `A site list takes up to ${SITES_PER_LIST_LIMIT} sites, and an account up to ${SITE_LIST_LIMIT} lists.`,
        fix: "Clean these up first; split what's left across lists.",
        ...evidence(bigTags.map((t) => `${t.tag} (${t.entries})`)),
        topic: "Website Management",
      });
    }
  }

  // ---------- Requirements: profiles and site lists ----------
  if (profiles) {
    const left = PROFILE_LIMIT - profiles.length;
    push({
      id: "profile-capacity",
      severity: left <= 4 ? "plan" : "ok",
      title: profiles.length === 0 ? `No profiles yet, ${PROFILE_LIMIT} available` : `${profiles.length} of ${PROFILE_LIMIT} profiles used`,
      detail: left <= 4 ? "Fewer profiles are easier to govern; plan the set before you add more." : undefined,
      topic: "Requirements",
    });
    if (siteLists) {
      const listsLeft = SITE_LIST_LIMIT - siteLists.length;
      push({
        id: "site-list-capacity",
        severity: listsLeft <= 4 ? "plan" : "ok",
        title: siteLists.length === 0 ? `No site lists yet, ${SITE_LIST_LIMIT} available` : `${siteLists.length} of ${SITE_LIST_LIMIT} site lists used`,
        detail: listsLeft <= 4 ? `The API allows ${SITE_LIST_LIMIT} site lists per account, shared by every profile.` : undefined,
        topic: "Profiles",
      });
    }
    const noOwner = profiles.filter((p) => !p.description?.trim());
    if (noOwner.length) {
      push({
        id: "profiles-no-owner",
        severity: "plan",
        title: `${plural(noOwner.length, "profile")} ${noOwner.length === 1 ? "has" : "have"} no description`,
        detail: "Lists decay again within a year when nobody owns them.",
        fix: "Record the owner and the business reason in each profile's Description.",
        ...evidence(noOwner.map((p) => p.name)),
        topic: "Profiles",
      });
    }
    const crowded = profiles.filter((p) => (p.siteListActions?.length ?? 0) > LISTS_PER_PROFILE_LIMIT - 4);
    if (crowded.length) {
      push({
        id: "profiles-crowded",
        severity: "plan",
        title: `${plural(crowded.length, "profile")} near the ${LISTS_PER_PROFILE_LIMIT} site list limit`,
        ...evidence(crowded.map((p) => `${p.name} (${p.siteListActions?.length})`)),
        topic: "Profiles",
      });
    }
  }

  // ---------- Requirements: admin role; pilot: policy type ----------
  push({
    id: "admin-role",
    severity: "info",
    title: "Confirm your admin role includes Manage web profiles",
    detail: "The API can't show an admin's role. This credential can read web profiles; the build step's first write shows whether it can write them.",
    topic: "Requirements",
  });
  const userPolicies = (wcPolicies ?? []).filter((p) => !isBasePolicy(p));
  if (userPolicies.length) {
    push({
      id: "policy-type",
      severity: "info",
      title: "Decide User or Device for each profile policy before you create it",
      detail: "The API has no type field: a policy is a user or device policy by what it's assigned to. Plan assignments first, and confirm the type in Sophos Fusion.",
      topic: "Pilot",
    });
  }

  const counts: Record<Severity, number> = { fix: 0, plan: 0, ok: 0, info: 0 };
  for (const i of items) counts[i.severity]++;
  const order: Record<Severity, number> = { fix: 0, plan: 1, info: 2, ok: 3 };
  items.sort((a, b) => order[a.severity] - order[b.severity]);

  const name = inv.tenant.name;
  const headline =
    counts.fix === 0
      ? `${name} is ready for a pilot`
      : `${name} needs ${counts.fix === 1 ? "one fix" : `${counts.fix} fixes`} before a pilot`;
  const summaryParts = [
    eligibility ? plural(eligibility.inScope + eligibility.byReason.linux, "device") : null,
    wcPolicies || swcPolicies ? plural(webPolicies.length, "Web Control policy", "Web Control policies") : null,
    tpPolicies || stpPolicies ? plural(threatPolicies.length, "Threat Protection policy", "Threat Protection policies") : null,
    localSites ? plural(localSites.length, "Website Management entry", "Website Management entries") : null,
  ].filter(Boolean) as string[];
  const summary = summaryParts.length
    ? `Checked ${summaryParts.slice(0, -1).join(", ")}${summaryParts.length > 1 ? ", and " : ""}${summaryParts[summaryParts.length - 1]}.`
    : "Nothing could be checked.";

  return {
    verdict: counts.fix === 0 ? "ready" : "fixes",
    headline,
    summary,
    counts,
    items,
    facts: {
      eligibility,
      policies: rows,
      websiteManagement,
      profiles: profiles ? { count: profiles.length, limit: PROFILE_LIMIT } : null,
      siteLists: siteLists ? { count: siteLists.length, sites: siteLists.reduce((n, l) => n + (l.numberOfSites ?? l.sites.length), 0) } : null,
      decryption,
    },
    unread,
  };
}
