/**
 * One-click site list creation from clean-up results (the site list cleaner
 * and the clean-up step), with a dry run first and an undo. Each list is
 * sent once, read back, and audited; the ids are kept so undo deletes only
 * what this created.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { siteListsFrom, type CleanupResult, type SiteListOut } from "../domain/cleanup.js";
import { ReadOnlyApi, errorStatus, type TenantApi } from "../sophos/api/requester.js";
import { createSiteList, deleteSiteList, getSiteList, listSiteLists, listSites } from "../sophos/api/web-filters.js";
import { auditedCreate, sameSites } from "./build-service.js";
import { auditedWrite } from "./audit-log.js";
import { readBack } from "./write-check.js";
import { readText, saveFile } from "./safe-files.js";
import { SITE_LIST_LIMIT } from "../domain/design.js";

export interface ListsRecord {
  tenantId: string;
  scope: string;
  createdAt: string;
  /**
   * Each list as the create left it, or the undo after it: status "created", "failed" or "planned" (not sent), then
   * "deleted", "still there after delete", "not confirmed", "in use by a profile, left" or "delete failed". readBack is
   * what the read-back after the last write Sophos accepted found ("matches", how it differed, or "not read: " and why).
   */
  lists: Array<{ name: string; action: string; sites: number; id?: string; status: string; readBack?: string; error?: string }>;
}

function recordPath(dataDir: string, scope: string): string {
  if (!/^[a-z0-9-]{3,80}$/i.test(scope)) throw new Error("Bad scope.");
  return path.join(dataDir, "cleanup", `${scope}.lists.json`);
}

export async function lastListsRecord(dataDir: string, scope: string): Promise<ListsRecord | null> {
  const text = await readText(recordPath(dataDir, scope), "cleanup").catch(() => null);
  return text ? (JSON.parse(text) as ListsRecord) : null;
}

export interface ListsPlan {
  lists: SiteListOut[];
  problems: string[];
  leftOut: number;
}

export async function planLists(api: TenantApi, tenantId: string, results: CleanupResult[], prefix: string): Promise<ListsPlan> {
  const { lists, leftOut } = siteListsFrom(results, prefix);
  const existing = await listSiteLists(new ReadOnlyApi(api), tenantId);
  const problems: string[] = [];
  if (lists.length === 0) problems.push("There are no exceptions to put in a site list.");
  if (existing.length + lists.length > SITE_LIST_LIMIT) problems.push(`The account has ${existing.length} of ${SITE_LIST_LIMIT} site lists; ${lists.length} more won't fit.`);
  const taken = new Set(existing.map((l) => l.name.toLowerCase()));
  for (const l of lists) if (taken.has(l.name.toLowerCase())) problems.push(`A site list named "${l.name}" already exists.`);
  return { lists, problems, leftOut: leftOut.length };
}

export async function createLists(dataDir: string, api: TenantApi, tenantId: string, scope: string, results: CleanupResult[], prefix: string): Promise<ListsRecord> {
  const plan = await planLists(api, tenantId, results, prefix);
  if (plan.problems.length) throw new Error(plan.problems.join(" "));
  const record: ListsRecord = { tenantId, scope, createdAt: new Date().toISOString(), lists: [] };
  for (const l of plan.lists) {
    const row: ListsRecord["lists"][number] = { name: l.name, action: l.action, sites: l.sites.length, status: "planned" };
    record.lists.push(row);
    try {
      const { value } = await auditedCreate(
        tenantId,
        "site-list",
        () => createSiteList(api, tenantId, { name: l.name, description: `${l.action[0]!.toUpperCase()}${l.action.slice(1)} exceptions kept by the site list cleaner (Web Profiles Assistant, unofficial).`, sites: l.sites }),
        async () => (await listSiteLists(new ReadOnlyApi(api), tenantId)).find((x) => x.name === l.name) ?? null,
        "the site list",
        { where: "the tenant's site lists", found: `no site list named "${l.name}"` },
        { name: l.name, sites: l.sites.length, scope },
      );
      row.id = value.id;
      row.status = "created";
      // Made: a read-back that fails or differs leaves it unconfirmed, and the next list is still sent.
      const ro = new ReadOnlyApi(api);
      const back = await readBack(async () => {
        const got = await getSiteList(ro, tenantId, value.id);
        return got.sites ?? (await listSites(ro, tenantId, value.id)).map((x) => x.site);
      });
      if (!back.value) row.readBack = `not read: ${back.unread ?? "no read-back"}`;
      else if (sameSites(l.sites, back.value)) row.readBack = "matches";
      else row.readBack = back.value.length === l.sites.length ? "read back with other sites than were sent" : `read back ${back.value.length} ${back.value.length === 1 ? "site" : "sites"}, not the ${l.sites.length} sent`;
    } catch (err) {
      row.status = "failed";
      row.error = err instanceof Error ? err.message : String(err);
      break;
    }
  }
  const file = recordPath(dataDir, scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await saveFile(file, JSON.stringify(record, null, 2), { section: "cleanup", mode: 0o600 });
  return record;
}

/** Deletes the lists the last create made, by id. A list a profile uses is refused (409) and left. */
export async function undoLists(dataDir: string, api: TenantApi, scope: string): Promise<ListsRecord> {
  const record = await lastListsRecord(dataDir, scope);
  if (!record) throw new Error("Nothing to undo.");
  for (const row of record.lists.filter((r) => r.id && r.status === "created")) {
    try {
      await auditedWrite({ tenantId: record.tenantId }, "delete", "site-list", row.id!, () => deleteSiteList(api, record.tenantId, row.id!), { name: row.name, undo: scope });
      // Gone once a read answers 404. Any other answer is a read that failed, not proof it's still there.
      const gone = await readBack(async () => {
        try {
          await getSiteList(new ReadOnlyApi(api), record.tenantId, row.id!);
          return null;
        } catch (err) {
          if (errorStatus(err) === 404) return true;
          throw err;
        }
      });
      row.status = gone.value ? "deleted" : gone.unread ? "not confirmed" : "still there after delete";
      row.readBack = gone.value ? "404 on read-back" : gone.unread ? `not read: ${gone.unread}` : "still there";
    } catch (err) {
      row.status = errorStatus(err) === 409 ? "in use by a profile, left" : "delete failed";
      row.error = err instanceof Error ? err.message : String(err);
    }
  }
  await saveFile(recordPath(dataDir, scope), JSON.stringify(record, null, 2), { section: "cleanup", mode: 0o600 });
  return record;
}
