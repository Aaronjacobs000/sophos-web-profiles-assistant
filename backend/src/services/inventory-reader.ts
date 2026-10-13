/**
 * Reads one tenant's inventory through a read-only client. Each section is
 * read on its own, so a refused call (403 on an unlicensed feature, say)
 * marks that section unread and the rest still score.
 */

import { ReadOnlyApi, errorStatus, type TenantApi } from "../sophos/api/requester.js";
import { listPolicies, type Policy } from "../sophos/api/policies.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import { getTlsDecryption, listClassicCategories, listLocalSites, listTlsExcludedWebsites } from "../sophos/api/web-control.js";
import { listScanningExclusions } from "../sophos/api/exclusions.js";
import { getProfile, listProfiles, listSiteLists, listSites } from "../sophos/api/web-filters.js";
import { findUsers, listEndpointGroups, listUserGroups, type User } from "../sophos/api/directory.js";
import type { Inventory, InventoryTenant, Section } from "../domain/inventory.js";
import { mapPool } from "./pool.js";

async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (err) {
    const status = errorStatus(err);
    return { ok: false, ...(status ? { status } : {}), error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reads every section. `parallel` sections are read at once (default 3). */
export async function readInventory(
  client: TenantApi,
  tenant: InventoryTenant,
  opts: { parallel?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<Inventory> {
  const api = new ReadOnlyApi(client);
  const t = tenant.id;
  const started = Date.now();

  const tasks = {
    endpoints: () => section(() => listAllEndpoints(api, t)),
    webControlPolicies: () => section(() => listPolicies(api, t, "web-control")),
    serverWebControlPolicies: () => section(() => listPolicies(api, t, "server-web-control")),
    threatProtectionPolicies: () => section(() => listPolicies(api, t, "threat-protection")),
    serverThreatProtectionPolicies: () => section(() => listPolicies(api, t, "server-threat-protection")),
    localSites: () => section(() => listLocalSites(api, t)),
    classicCategories: () => section(() => listClassicCategories(api, t)),
    tlsDecryption: () =>
      section(async () => {
        const settings = await getTlsDecryption(api, t);
        const excluded = settings.excludedWebsites?.total ? await listTlsExcludedWebsites(api, t) : settings.excludedWebsites?.items ?? [];
        return { ...settings, excludedWebsiteItems: excluded };
      }),
    scanningExclusions: () => section(() => listScanningExclusions(api, t)),
    profiles: () =>
      section(async () => {
        const list = await listProfiles(api, t);
        return mapPool(list, 2, (p) => getProfile(api, t, p.id));
      }),
    siteLists: () =>
      section(async () => {
        const lists = await listSiteLists(api, t);
        return mapPool(lists, 2, async (l) => ({ ...l, sites: await listSites(api, t, l.id) }));
      }),
    endpointGroups: () => section(() => listEndpointGroups(api, t)),
    userGroups: () => section(() => listUserGroups(api, t)),
  } as const;

  type Key = keyof typeof tasks;
  const keys = Object.keys(tasks) as Key[];
  let done = 0;
  const total = keys.length + 1;
  const results = await mapPool(keys, opts.parallel ?? 3, async (key) => {
    const r = await tasks[key]();
    opts.onProgress?.(++done, total);
    return [key, r] as const;
  });
  const read = Object.fromEntries(results) as { [K in Key]: Awaited<ReturnType<(typeof tasks)[K]>> };

  // Users are looked up only when a Web Control policy names them.
  const policies: Policy[] = [
    ...(read.webControlPolicies.ok ? read.webControlPolicies.data : []),
    ...(read.serverWebControlPolicies.ok ? read.serverWebControlPolicies.data : []),
  ];
  const ids = [...new Set(policies.flatMap((p) => p.appliesTo?.users ?? []))];
  const noPolicies = !read.webControlPolicies.ok && !read.serverWebControlPolicies.ok;
  const referencedUsers: Section<{ ids: string[]; found: User[] }> = noPolicies
    ? { ok: false, error: "Not looked up: the Web Control policies that name users couldn't be read." }
    : await section(async () => ({ ids, found: ids.length ? await findUsers(api, t, ids) : [] }));
  opts.onProgress?.(++done, total);

  return {
    tenant,
    readAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    calls: api.calls,
    ...read,
    referencedUsers,
  };
}
