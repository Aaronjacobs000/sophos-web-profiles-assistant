/**
 * The rollback snapshot: every web-control-relevant object in a tenant, as it
 * was read, in one JSON document. Drops 2 and 3 restore from it:
 *
 *   - Web Control and server Web Control policies, whole (settings, priority,
 *     enabled, appliesTo), so a changed or deleted policy can be put back;
 *   - the web settings of every Threat Protection policy (decryption, Block
 *     QUIC, web filtering and scanning, and type "web" scanning exclusions);
 *     only these keys, because only these are ever changed;
 *   - every Website Management entry with its tags, category and comment;
 *   - the tenant's SSL/TLS decryption exclusions;
 *   - global scanning exclusions of type "web";
 *   - every web filtering profile (full settings) and site list (with sites);
 *   - names for every ID an assignment refers to, so a restore can say what
 *     it is putting back.
 *
 * Devices are not objects to restore, so only the eligibility counts are kept.
 * The integrity hash is added by the store (services/snapshot-store.ts),
 * which has Node's crypto.
 *
 * Pure: no Node or browser imports.
 */

import { summariseEligibility } from "./eligibility.js";
import { sectionData, type Inventory, type InventoryTenant, type SiteListWithSites } from "./inventory.js";
import type { Policy } from "../sophos/api/policies.js";
import type { LocalSite, TlsDecryptionSettings } from "../sophos/api/web-control.js";
import type { ScanningExclusion } from "../sophos/api/exclusions.js";
import type { WebProfile } from "../sophos/api/web-filters.js";

export const SNAPSHOT_KIND = "web-profiles-assistant.snapshot";
export const SNAPSHOT_SCHEMA = 1;

/** Threat Protection keys the tool may change, and so keeps for rollback. */
export const THREAT_WEB_KEYS = [
  "endpoint.threat-protection.web-control.tls-decryption.enabled",
  "endpoint.threat-protection.web-control.tls-decryption.quic.enabled",
  "endpoint.threat-protection.malware-protection.web-filtering.enabled",
  "endpoint.threat-protection.malware-protection.web-scanning.enabled",
] as const;

export interface ThreatPolicyWebSettings {
  id: string;
  name: string;
  type: string;
  priority?: number;
  enabled?: boolean;
  settings: Record<string, unknown>;
  /** The policy's own scanning exclusions of type "web". */
  webExclusions: Array<{ value: string; type: string; [k: string]: unknown }>;
}

export interface Snapshot {
  kind: typeof SNAPSHOT_KIND;
  schemaVersion: typeof SNAPSHOT_SCHEMA;
  tool: { name: string; version: string };
  takenAt: string;
  tenant: InventoryTenant;
  /** Sections that could not be read; a restore must not treat them as empty. */
  unreadSections: string[];
  counts: Record<string, number | null>;
  context: {
    eligibility: { inScope: number; eligible: number; macos: number; olderWindows: number } | null;
  };
  objects: {
    webControlPolicies: Policy[] | null;
    serverWebControlPolicies: Policy[] | null;
    threatProtectionWebSettings: ThreatPolicyWebSettings[] | null;
    websiteManagement: LocalSite[] | null;
    tlsDecryption: (TlsDecryptionSettings & { excludedWebsiteItems: Array<Record<string, unknown>> }) | null;
    webScanningExclusions: ScanningExclusion[] | null;
    webFilteringProfiles: WebProfile[] | null;
    siteLists: SiteListWithSites[] | null;
  };
  references: {
    users: Array<{ id: string; name?: string; email?: string; exists: boolean }>;
    userGroups: Array<{ id: string; name: string }>;
    endpointGroups: Array<{ id: string; name: string }>;
  };
  restoreNotes: string[];
  /** sha256 of the canonical JSON of `objects`, set by the store. */
  integrity?: { algorithm: "sha256"; objects: string };
}

function threatWebSettings(p: Policy): ThreatPolicyWebSettings {
  const settings: Record<string, unknown> = {};
  for (const key of THREAT_WEB_KEYS) {
    if (p.settings?.[key] !== undefined) settings[key] = p.settings[key];
  }
  const exclusions = (p.settings?.["endpoint.threat-protection.exclusions.scanning"]?.value ?? []) as Array<{ value: string; type: string }>;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    priority: p.priority,
    enabled: p.enabled,
    settings,
    webExclusions: exclusions.filter((x) => x.type === "web"),
  };
}

export function buildSnapshot(inv: Inventory, tool: { name: string; version: string }): Snapshot {
  const tp = sectionData(inv.threatProtectionPolicies);
  const stp = sectionData(inv.serverThreatProtectionPolicies);
  const threat = tp || stp ? [...(tp ?? []), ...(stp ?? [])].map(threatWebSettings) : null;
  const endpoints = sectionData(inv.endpoints);
  const e = endpoints ? summariseEligibility(endpoints) : null;
  const users = sectionData(inv.referencedUsers);
  const userGroups = sectionData(inv.userGroups) ?? [];
  const endpointGroups = sectionData(inv.endpointGroups) ?? [];
  const exclusions = sectionData(inv.scanningExclusions);
  const unreadSections = (Object.keys(inv) as Array<keyof Inventory>).filter((k) => {
    const v = inv[k] as unknown;
    return typeof v === "object" && v !== null && "ok" in (v as object) && (v as { ok: boolean }).ok === false;
  }) as string[];

  const objects: Snapshot["objects"] = {
    webControlPolicies: sectionData(inv.webControlPolicies),
    serverWebControlPolicies: sectionData(inv.serverWebControlPolicies),
    threatProtectionWebSettings: threat,
    websiteManagement: sectionData(inv.localSites),
    tlsDecryption: sectionData(inv.tlsDecryption),
    webScanningExclusions: exclusions ? exclusions.filter((x) => x.type === "web") : null,
    webFilteringProfiles: sectionData(inv.profiles),
    siteLists: sectionData(inv.siteLists),
  };
  const count = (v: unknown[] | null) => (v ? v.length : null);

  return {
    kind: SNAPSHOT_KIND,
    schemaVersion: SNAPSHOT_SCHEMA,
    tool,
    takenAt: inv.readAt,
    tenant: inv.tenant,
    unreadSections,
    counts: {
      webControlPolicies: count(objects.webControlPolicies),
      serverWebControlPolicies: count(objects.serverWebControlPolicies),
      threatProtectionPolicies: count(objects.threatProtectionWebSettings),
      websiteManagementEntries: count(objects.websiteManagement),
      decryptionExcludedWebsites: objects.tlsDecryption ? objects.tlsDecryption.excludedWebsiteItems.length : null,
      webScanningExclusions: count(objects.webScanningExclusions),
      webFilteringProfiles: count(objects.webFilteringProfiles),
      siteLists: count(objects.siteLists),
      siteListSites: objects.siteLists ? objects.siteLists.reduce((n, l) => n + l.sites.length, 0) : null,
    },
    context: {
      eligibility: e
        ? {
            inScope: e.inScope,
            eligible: e.eligible,
            macos: e.byReason.macos,
            olderWindows: e.byReason["windows-old-agent"] + e.byReason["windows-no-agent-version"],
          }
        : null,
    },
    objects,
    references: {
      users: users
        ? users.ids.map((id) => {
            const u = users.found.find((f) => f.id === id);
            return { id, ...(u?.name ? { name: u.name } : {}), ...(u?.email ? { email: u.email } : {}), exists: !!u };
          })
        : [],
      userGroups: userGroups.map((g) => ({ id: g.id, name: g.name })),
      endpointGroups: endpointGroups.map((g) => ({ id: g.id, name: g.name })),
    },
    restoreNotes: [
      "Restore deletes what the tool created in reverse order: policies, then profiles, then site lists. The API refuses to delete a profile or site list that is still in use.",
      "Website Management entries are restored from objects.websiteManagement by URL, with their tags, category and comment.",
      "Threat Protection policies are restored only for the keys in threatProtectionWebSettings[].settings.",
      "Assignments (appliesTo) are restored by hand in Sophos Fusion unless the API accepts them; see the README.",
    ],
  };
}

/** Sorted-key JSON, so the same objects always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface SnapshotCheck {
  ok: boolean;
  problems: string[];
}

/** Checks a snapshot file before anything restores from it. */
export function validateSnapshot(data: unknown): SnapshotCheck {
  const problems: string[] = [];
  const s = data as Partial<Snapshot> | null;
  if (!s || typeof s !== "object") return { ok: false, problems: ["Not a JSON object."] };
  if (s.kind !== SNAPSHOT_KIND) problems.push(`Not a Web Profiles Assistant snapshot (kind is ${JSON.stringify(s.kind)}).`);
  if (s.schemaVersion !== SNAPSHOT_SCHEMA) problems.push(`Schema version ${JSON.stringify(s.schemaVersion)} is not ${SNAPSHOT_SCHEMA}.`);
  if (!s.tenant?.id) problems.push("No tenant ID.");
  if (!s.takenAt || Number.isNaN(Date.parse(s.takenAt))) problems.push("No valid takenAt time.");
  if (!s.objects || typeof s.objects !== "object") problems.push("No objects.");
  else {
    for (const key of [
      "webControlPolicies",
      "serverWebControlPolicies",
      "threatProtectionWebSettings",
      "websiteManagement",
      "webScanningExclusions",
      "webFilteringProfiles",
      "siteLists",
    ] as const) {
      const v = s.objects[key];
      if (v === undefined) problems.push(`objects.${key} is missing.`);
      else if (v !== null && !Array.isArray(v)) problems.push(`objects.${key} must be a list or null.`);
    }
  }
  return { ok: problems.length === 0, problems };
}
