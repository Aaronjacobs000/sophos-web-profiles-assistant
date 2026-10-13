/**
 * Everything the readiness check reads from one tenant, as plain data. The
 * reader (services/inventory-reader.ts) fills it; the scorecard and the
 * snapshot only read it. Each section either holds its data or says why it
 * could not be read, so one refused call never hides the rest.
 *
 * Pure: type-only imports, no Node or browser APIs.
 */

import type { DeviceLike } from "./eligibility.js";
import type { Policy } from "../sophos/api/policies.js";
import type { LocalSite, ClassicCategory, TlsDecryptionSettings } from "../sophos/api/web-control.js";
import type { ScanningExclusion } from "../sophos/api/exclusions.js";
import type { WebProfile, SiteList, Site } from "../sophos/api/web-filters.js";
import type { EndpointGroup, UserGroup, User } from "../sophos/api/directory.js";

export type Section<T> = { ok: true; data: T } | { ok: false; status?: number; error: string };

export interface InventoryTenant {
  id: string;
  name: string;
  region: string | null;
  apiHost: string;
  credentialType: "tenant" | "partner" | "organization";
}

export interface SiteListWithSites extends SiteList {
  sites: Site[];
}

export interface TlsDecryption extends TlsDecryptionSettings {
  /** Every excluded website, read from its own paged endpoint. */
  excludedWebsiteItems: Array<Record<string, unknown>>;
}

export interface Inventory {
  tenant: InventoryTenant;
  readAt: string;
  durationMs: number;
  /** Fusion API calls the read made. All GET. */
  calls: number;
  endpoints: Section<DeviceLike[]>;
  webControlPolicies: Section<Policy[]>;
  serverWebControlPolicies: Section<Policy[]>;
  threatProtectionPolicies: Section<Policy[]>;
  serverThreatProtectionPolicies: Section<Policy[]>;
  localSites: Section<LocalSite[]>;
  classicCategories: Section<ClassicCategory[]>;
  tlsDecryption: Section<TlsDecryption>;
  scanningExclusions: Section<ScanningExclusion[]>;
  profiles: Section<WebProfile[]>;
  siteLists: Section<SiteListWithSites[]>;
  endpointGroups: Section<EndpointGroup[]>;
  userGroups: Section<UserGroup[]>;
  /** The users web control policies are assigned to, looked up by ID. An ID missing from found no longer exists. */
  referencedUsers: Section<{ ids: string[]; found: User[] }>;
}

export const SECTION_LABELS: Record<Exclude<keyof Inventory, "tenant" | "readAt" | "durationMs" | "calls">, string> = {
  endpoints: "devices",
  webControlPolicies: "Web Control policies",
  serverWebControlPolicies: "server Web Control policies",
  threatProtectionPolicies: "Threat Protection policies",
  serverThreatProtectionPolicies: "server Threat Protection policies",
  localSites: "Website Management",
  classicCategories: "classic web categories",
  tlsDecryption: "SSL/TLS decryption settings",
  scanningExclusions: "scanning exclusions",
  profiles: "web filtering profiles",
  siteLists: "site lists",
  endpointGroups: "device groups",
  userGroups: "user groups",
  referencedUsers: "users",
};

export type SectionKey = keyof typeof SECTION_LABELS;

export function sectionData<T>(section: Section<T>): T | null {
  return section.ok ? section.data : null;
}

/** A policy setting's value, or undefined when the policy doesn't carry it. */
export function settingValue<T = unknown>(policy: Policy, key: string): T | undefined {
  const s = policy.settings?.[key];
  return s === undefined ? undefined : (s.value as T);
}

export function isBasePolicy(policy: Policy): boolean {
  return policy.priority === 0 || policy.name === "Base Policy";
}

/** True when a Web Control policy filters with a web filtering profile rather than classic settings. */
export function usesWebProfile(policy: Policy): boolean {
  return settingValue<boolean>(policy, "endpoint.web-control.web-profile.enabled") === true;
}

export interface Targets {
  users: string[];
  userGroups: string[];
  endpoints: string[];
  endpointGroups: string[];
}

export function targetsOf(policy: Policy): Targets {
  const a = policy.appliesTo ?? {};
  return {
    users: a.users ?? [],
    userGroups: a.userGroups ?? [],
    endpoints: a.endpoints ?? [],
    endpointGroups: a.endpointGroups ?? [],
  };
}

export function targetCount(t: Targets): number {
  return t.users.length + t.userGroups.length + t.endpoints.length + t.endpointGroups.length;
}
