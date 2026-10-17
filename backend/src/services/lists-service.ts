/**
 * One-click site list creation from clean-up results (the site list cleaner
 * and the clean-up step), with a dry run first and an undo. Each list is
 * sent once, read back, and audited; the ids are kept so undo deletes only
 * what this created. A delete the undo couldn't confirm can be sent again
 * (category D): one answered 404 was already gone, and one answered with a
 * 5xx or no answer is read back, as in a build rollback.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { siteListsFrom, type CleanupResult, type SiteListOut } from "../domain/cleanup.js";
import { ReadOnlyApi, errorStatus, type TenantApi } from "../sophos/api/requester.js";
import { createSiteList, deleteSiteList, getSiteList, listSiteLists, listSites } from "../sophos/api/web-filters.js";
import { auditedCreate, sameSites } from "./build-service.js";
import { auditOrWarn } from "./audit-log.js";
import { isUnclearWrite, readBack } from "./write-check.js";
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

/** The rows an undo sends a delete for: lists the create made, and deletes an earlier undo couldn't confirm. */
export const UNDO_LISTS_RETRY = ["created", "not confirmed", "still there after delete"];

/** Deletes the lists the last create made, by id. A list a profile uses is refused (409) and left. Run again, it sends the deletes it couldn't confirm again. */
export async function undoLists(dataDir: string, api: TenantApi, scope: string): Promise<ListsRecord> {
  const record = await lastListsRecord(dataDir, scope);
  if (!record) throw new Error("Nothing to undo.");
  const t = record.tenantId;
  for (const row of record.lists.filter((r) => r.id && UNDO_LISTS_RETRY.includes(r.status))) {
    const entry = { tenantId: t, action: "delete", resource: "site-list", resourceId: row.id!, detail: { name: row.name, undo: scope } };
    // Set when the delete got no clear answer (a 5xx, no answer in time, or a dropped connection), which can come back for a delete that went through.
    let unclear: string | undefined;
    // Set when Sophos answered 404: already gone, which a retry meets when the earlier delete went through.
    let answered404 = false;
    // Only this attempt's answer counts.
    delete row.error;
    try {
      await deleteSiteList(api, t, row.id!);
      await auditOrWarn({ ...entry, ok: true });
    } catch (err) {
      const status = errorStatus(err);
      const message = err instanceof Error ? err.message : String(err);
      if (isUnclearWrite(err) || (status !== undefined && status >= 500)) unclear = (isUnclearWrite(err) ? err.reason : message).replace(/\.$/, "");
      else if (status === 404) answered404 = true;
      else {
        await auditOrWarn({ ...entry, ok: false, error: message });
        row.status = status === 409 ? "in use by a profile, left" : "delete failed";
        row.error = message;
        continue;
      }
    }
    // Gone once a read answers 404. Any other answer is a read that failed, not proof it's still there.
    const gone = await readBack(async () => {
      try {
        await getSiteList(new ReadOnlyApi(api), t, row.id!);
        return null;
      } catch (err) {
        if (errorStatus(err) === 404) return true;
        throw err;
      }
    });
    if (gone.value) {
      row.status = "deleted";
      row.readBack = "404 on read-back";
      if (unclear || answered404) await auditOrWarn({ ...entry, ok: true, detail: { ...entry.detail, note: `${unclear ?? "Sophos answered 404, so it was already gone"}, then a read-back found it gone (404)` } });
    } else if (unclear && !gone.unread) {
      // No clear answer, and a read-back still found it: not deleted, as a rollback counts it. Undo sends it again only when Sophos took the delete.
      row.status = "delete failed";
      row.error = `${unclear}. A read-back still found it, so it wasn't deleted.`;
      await auditOrWarn({ ...entry, ok: false, error: row.error });
    } else {
      // Sophos accepted the delete (or gave no clear answer, or 404, and nothing could be read): not confirmed, so Undo sends it again.
      row.status = gone.unread ? "not confirmed" : "still there after delete";
      row.readBack = gone.unread ? `not read: ${gone.unread}` : "still there";
      if (unclear || answered404) await auditOrWarn({ ...entry, ok: false, error: `${unclear ?? "Sophos answered 404"}. ${gone.unread ? `A read-back couldn't read it (${gone.unread.replace(/\.$/, "")}), so it may still be there.` : "A read-back still found it."}` });
    }
  }
  await saveFile(recordPath(dataDir, scope), JSON.stringify(record, null, 2), { section: "cleanup", mode: 0o600 });
  return record;
}
