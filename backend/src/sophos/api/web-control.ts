/**
 * Classic Web Control settings: Website Management (local sites, with their
 * tags and category overrides), the classic category list, and the tenant's
 * SSL/TLS decryption settings (category and website exclusions). Read calls
 * only in drop 1.
 *
 * Website Management has a public API, although it's easy to miss:
 * GET/POST/PATCH/DELETE /endpoint/v1/settings/web-control/local-sites.
 */

import type { TenantApi } from "./requester.js";
import { listAllPages } from "./paging.js";

const LOCAL_SITES_PATH = "/endpoint/v1/settings/web-control/local-sites";
const CATEGORIES_PATH = "/endpoint/v1/settings/web-control/categories";
const TLS_PATH = "/endpoint/v1/settings/web-control/tls-decryption";

export interface LocalSite {
  id: string;
  url: string;
  tags?: string[];
  /** Set when the entry overrides the site's category rather than (or as well as) tagging it. */
  categoryId?: number;
  comment?: string;
}

export interface ClassicCategory {
  id: number;
  name: string;
  label: string;
}

export interface TlsDecryptionSettings {
  categories?: Array<{ id: number; name: string; label?: string; decryptionEnabled: boolean }>;
  excludedWebsites?: { itemsCount?: number; total?: number; items?: Array<Record<string, unknown>> };
}

export const listLocalSites = (api: TenantApi, tenantId: string) => listAllPages<LocalSite>(api, tenantId, LOCAL_SITES_PATH);

export async function listClassicCategories(api: TenantApi, tenantId: string): Promise<ClassicCategory[]> {
  const res = await api.tenantRequest<ClassicCategory[] | { items?: ClassicCategory[] }>(tenantId, CATEGORIES_PATH);
  return Array.isArray(res) ? res : res.items ?? [];
}

export const getTlsDecryption = (api: TenantApi, tenantId: string) => api.tenantRequest<TlsDecryptionSettings>(tenantId, TLS_PATH);

export const listTlsExcludedWebsites = (api: TenantApi, tenantId: string) =>
  listAllPages<Record<string, unknown>>(api, tenantId, `${TLS_PATH}/excluded-websites`, {}, 100);

// ---------- writes (drop 3: retiring tags and restoring them). ----------

export const getLocalSite = (api: TenantApi, tenantId: string, id: string) =>
  api.tenantRequest<LocalSite>(tenantId, `${LOCAL_SITES_PATH}/${encodeURIComponent(id)}`);

/** Needs tags or a categoryId; a duplicate URL gets 409. */
export const createLocalSite = (api: TenantApi, tenantId: string, body: { url: string; tags?: string[]; categoryId?: number; comment?: string }) =>
  api.tenantRequest<LocalSite>(tenantId, LOCAL_SITES_PATH, { method: "POST", body });

export const patchLocalSite = (api: TenantApi, tenantId: string, id: string, body: Record<string, unknown>) =>
  api.tenantRequest<LocalSite>(tenantId, `${LOCAL_SITES_PATH}/${encodeURIComponent(id)}`, { method: "PATCH", body });

export const deleteLocalSite = (api: TenantApi, tenantId: string, id: string) =>
  api.tenantRequest<{ deleted?: boolean }>(tenantId, `${LOCAL_SITES_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" });
