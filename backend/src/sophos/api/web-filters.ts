/**
 * Web Filtering API (/web-filters/v1, regional host): web filtering profiles
 * and site lists. Read calls only in drop 1. A profile's list GET carries no
 * filter settings, so the full profile is read by ID.
 */

import type { TenantApi } from "./requester.js";
import { listAllPages } from "./paging.js";

const PROFILES_PATH = "/web-filters/v1/profiles";
const SITE_LISTS_PATH = "/web-filters/v1/site-lists";

export type WebFilterAction = "allow" | "block" | "warn";

export interface WebProfileConsumer {
  type: string;
  id: string;
}

export interface WebProfile {
  id: string;
  name: string;
  description?: string;
  updatedAt?: string;
  updatedBy?: { id?: string; type?: string; name?: string; accountType?: string; accountId?: string };
  consumers?: WebProfileConsumer[];
  filterByCategory?: boolean;
  preset?: string;
  categoryGroupActions?: Array<{ name: string; action: WebFilterAction }>;
  categoryActions?: Array<{ name: string; action: WebFilterAction }>;
  filterBySiteList?: boolean;
  siteListActions?: Array<{ id: string; action: WebFilterAction; priority: number }>;
}

export interface SiteList {
  id: string;
  name: string;
  description?: string;
  numberOfSites?: number;
  updatedAt?: string;
  usedBy?: Array<{ id: string; name?: string }>;
}

export interface Site {
  id?: string;
  site: string;
  siteType?: string;
  createdAt?: string;
}

export interface ProfileMetadata {
  presets?: unknown[];
  categoryGroups?: unknown[];
  [key: string]: unknown;
}

export const listProfiles = (api: TenantApi, tenantId: string) => listAllPages<WebProfile>(api, tenantId, PROFILES_PATH);

export const getProfile = (api: TenantApi, tenantId: string, id: string) =>
  api.tenantRequest<WebProfile>(tenantId, `${PROFILES_PATH}/${encodeURIComponent(id)}`);

export const listSiteLists = (api: TenantApi, tenantId: string) => listAllPages<SiteList>(api, tenantId, SITE_LISTS_PATH);

export const listSites = (api: TenantApi, tenantId: string, siteListId: string) =>
  listAllPages<Site>(api, tenantId, `${SITE_LISTS_PATH}/${encodeURIComponent(siteListId)}/sites`);

/** Presets, category groups and categories. The endpoint needs an Accept-Language header. */
export const getProfileMetadata = (api: TenantApi, tenantId: string) =>
  api.tenantRequest<ProfileMetadata>(tenantId, `${PROFILES_PATH}/metadata`, { headers: { "Accept-Language": "en" } });

// ---------- writes (drop 2). Each is sent once; callers read back and audit. ----------

export const getSiteList = (api: TenantApi, tenantId: string, id: string) =>
  api.tenantRequest<SiteList & { sites?: string[] }>(tenantId, `${SITE_LISTS_PATH}/${encodeURIComponent(id)}`);

export const createSiteList = (api: TenantApi, tenantId: string, body: { name: string; description?: string; sites: string[] }) =>
  api.tenantRequest<SiteList & { sites?: string[] }>(tenantId, SITE_LISTS_PATH, { method: "POST", body });

/** PUT replaces the whole list (name, description and sites). */
export const replaceSiteList = (api: TenantApi, tenantId: string, id: string, body: { name: string; description?: string; sites: string[] }) =>
  api.tenantRequest<SiteList & { sites?: string[] }>(tenantId, `${SITE_LISTS_PATH}/${encodeURIComponent(id)}`, { method: "PUT", body });

/** Refused with 409 while a profile still uses the list. */
export const deleteSiteList = (api: TenantApi, tenantId: string, id: string) =>
  api.tenantRequest<{ deleted?: boolean }>(tenantId, `${SITE_LISTS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" });

export const addSite = (api: TenantApi, tenantId: string, listId: string, site: string) =>
  api.tenantRequest<Site>(tenantId, `${SITE_LISTS_PATH}/${encodeURIComponent(listId)}/sites`, { method: "POST", body: { site } });

export const deleteSite = (api: TenantApi, tenantId: string, listId: string, siteId: string) =>
  api.tenantRequest<{ deleted?: boolean }>(tenantId, `${SITE_LISTS_PATH}/${encodeURIComponent(listId)}/sites/${encodeURIComponent(siteId)}`, { method: "DELETE" });

export const createProfile = (api: TenantApi, tenantId: string, body: Record<string, unknown>) =>
  api.tenantRequest<WebProfile>(tenantId, PROFILES_PATH, { method: "POST", body });

/** PUT replaces the whole profile: send the complete state. */
export const replaceProfile = (api: TenantApi, tenantId: string, id: string, body: Record<string, unknown>) =>
  api.tenantRequest<WebProfile>(tenantId, `${PROFILES_PATH}/${encodeURIComponent(id)}`, { method: "PUT", body });

/** Refused with 409 while a policy still uses the profile. */
export const deleteProfile = (api: TenantApi, tenantId: string, id: string) =>
  api.tenantRequest<{ deleted?: boolean }>(tenantId, `${PROFILES_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" });
