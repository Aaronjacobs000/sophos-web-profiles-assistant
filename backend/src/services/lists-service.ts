/**
 * One-click site list creation from clean-up results (the site list cleaner
 * and the clean-up step), with a dry run first and an undo. Each list is
 * sent once, read back, and audited; the ids are kept so undo deletes only
 * what this created. A delete the undo couldn't confirm can be sent again
 * (category D): one answered 404 was already gone, and one answered with a
 * 5xx or no answer is read back, as in a build rollback. So can a delete
 * Sophos refused, as a rollback sends one again. A list Sophos didn't confirm
 * was made has no id: undo looks for it by name first, as the next create
 * does, and deletes it by the id found.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { siteListsFrom, type CleanupResult, type SiteListOut } from "../domain/cleanup.js";
import { ReadOnlyApi, errorStatus, type TenantApi } from "../sophos/api/requester.js";
import { createSiteList, deleteSiteList, getSiteList, listSiteLists, listSites } from "../sophos/api/web-filters.js";
import { auditedCreate, foundByName, idsCreatedByTool, lookUpByName, sameSites } from "./build-service.js";
import { auditOrWarn } from "./audit-log.js";
import { UnreadAfterWriteError, isUnclearWrite, readBack, takenNameAdvice, unreadCreateFrom } from "./write-check.js";
import { readText, saveFile } from "./safe-files.js";
import { SITE_LIST_LIMIT } from "../domain/design.js";

export interface ListsRecord {
  tenantId: string;
  scope: string;
  createdAt: string;
  /**
   * Each list as the create left it, or the undo after it: status "created", "unconfirmed", "failed" or "planned" (not
   * sent), then "deleted", "still there after delete", "not confirmed", "in use by a profile, left" or "delete failed".
   * readBack is what the read-back after the last write Sophos accepted found ("matches", how it differed, or "not read: "
   * and why). deleteAnswer is set with a delete's read-back when Sophos didn't answer that delete with a success (a 5xx, a
   * 404, no answer in time or a dropped connection): what it said. Without it, Sophos accepted the delete.
   * unconfirmed: Sophos didn't answer the create with a success, and the tenant's site lists couldn't be read to look for
   * it by name after (answer, and "not read: " in readBack), so it may have been made. There's no id; the next create
   * looks for it by name first, and uses it if it's there (note). So does undo: lookedUp says what it found, "found"
   * (then deleted by its id, as status says), "not found" (status "not there") or "not read: " and why (still unconfirmed).
   */
  lists: Array<{ name: string; action: string; sites: number; id?: string; status: string; readBack?: string; answer?: string; note?: string; lookedUp?: string; deleteAnswer?: string; error?: string }>;
}

function recordPath(dataDir: string, scope: string): string {
  if (!/^[a-z0-9-]{3,80}$/i.test(scope)) throw new Error("Bad scope.");
  return path.join(dataDir, "cleanup", `${scope}.lists.json`);
}

export async function lastListsRecord(dataDir: string, scope: string): Promise<ListsRecord | null> {
  const text = await readText(recordPath(dataDir, scope), "cleanup").catch(() => null);
  if (!text) return null;
  const r = JSON.parse(text) as ListsRecord;
  // Before v0.3.24 a create Sophos didn't answer with a success, with the site lists unread after, was saved as failed
  // with no id: it's unconfirmed, so the next create and undo look for it by name. The file isn't changed.
  for (const row of r.lists) {
    const was = row.status === "failed" && !row.id ? unreadCreateFrom(row.error, "the tenant's site lists") : null;
    if (!was) continue;
    row.status = "unconfirmed";
    row.answer = was.answer;
    row.readBack = `not read: ${was.unread}`;
    delete row.error;
  }
  return r;
}

/** The ids on record that a list found by name for an unconfirmed create can't be: the last create's, and every build's. */
async function recordedIds(dataDir: string, tenantId: string, record: ListsRecord): Promise<Set<string | undefined>> {
  return new Set([...record.lists.map((r) => r.id), ...(await idsCreatedByTool(dataDir, tenantId))]);
}

export interface ListsPlan {
  lists: SiteListOut[];
  problems: string[];
  leftOut: number;
  /** Lists the last create asked for that Sophos didn't confirm (unconfirmed), found by name: used, not made again. */
  reuse: Array<{ name: string; id: string }>;
  notes: string[];
}

/** The note on a list the last create asked for, found by name. */
const FOUND_NOTE = "Found by name: the last create asked for it and Sophos didn't confirm it, so it's used, not made again.";

/**
 * The dry run. With last (where this create keeps its record), a name that's taken by a list the last create asked for
 * and Sophos didn't confirm, which no record has an id for, isn't a problem: the create uses that list (reuse).
 */
export async function planLists(api: TenantApi, tenantId: string, results: CleanupResult[], prefix: string, last?: { dataDir: string; scope: string }): Promise<ListsPlan> {
  const { lists, leftOut } = siteListsFrom(results, prefix);
  const existing = await listSiteLists(new ReadOnlyApi(api), tenantId);
  const problems: string[] = [];
  const notes: string[] = [];
  const reuse: ListsPlan["reuse"] = [];
  const before = last ? await lastListsRecord(last.dataDir, last.scope) : null;
  const asked = before?.tenantId === tenantId ? before.lists.filter((r) => r.status === "unconfirmed" && !r.id).map((r) => r.name.toLowerCase()) : [];
  const recorded = asked.length ? await recordedIds(last!.dataDir, tenantId, before!) : new Set<string | undefined>();
  const taken = lists.flatMap((l) => {
    const there = existing.find((x) => x.name.toLowerCase() === l.name.toLowerCase());
    return there ? [{ name: l.name, id: there.id }] : [];
  });
  for (const x of taken) if (asked.includes(x.name.toLowerCase()) && foundByName(existing, x.name, recorded)) reuse.push(x);
  const adding = lists.length - reuse.length;
  if (lists.length === 0) problems.push("There are no exceptions to put in a site list.");
  if (existing.length + adding > SITE_LIST_LIMIT) problems.push(`The account has ${existing.length} of ${SITE_LIST_LIMIT} site lists; ${adding} more won't fit.`);
  for (const x of taken) {
    if (reuse.includes(x)) notes.push(`"${x.name}" is in the tenant. The last create asked for it and Sophos didn't confirm it was made, so this one uses it rather than making another.`);
    else problems.push(`A site list named "${x.name}" already exists.`);
  }
  return { lists, problems, leftOut: leftOut.length, reuse, notes };
}

export async function createLists(dataDir: string, api: TenantApi, tenantId: string, scope: string, results: CleanupResult[], prefix: string): Promise<ListsRecord> {
  const plan = await planLists(api, tenantId, results, prefix, { dataDir, scope });
  if (plan.problems.length) throw new Error(plan.problems.join(" "));
  const record: ListsRecord = { tenantId, scope, createdAt: new Date().toISOString(), lists: [] };
  for (const l of plan.lists) {
    const row: ListsRecord["lists"][number] = { name: l.name, action: l.action, sites: l.sites.length, status: "planned" };
    record.lists.push(row);
    const found = plan.reuse.find((r) => r.name === l.name);
    try {
      if (found) {
        // Found by name in the dry run just read: no create is sent, and the audit log says it was used.
        row.note = FOUND_NOTE;
        await auditOrWarn({ tenantId, action: "reuse", resource: "site-list", resourceId: found.id, ok: true, detail: { name: l.name, scope, note: FOUND_NOTE } });
      }
      const value = found
        ? { id: found.id }
        : (
            await auditedCreate(
              tenantId,
              "site-list",
              () => createSiteList(api, tenantId, { name: l.name, description: `${l.action[0]!.toUpperCase()}${l.action.slice(1)} exceptions kept by the site list cleaner (Web Profiles Assistant, unofficial).`, sites: l.sites }),
              async () => (await listSiteLists(new ReadOnlyApi(api), tenantId)).find((x) => x.name === l.name) ?? null,
              "the site list",
              { where: "the tenant's site lists", found: `no site list named "${l.name}"`, advice: takenNameAdvice(`the site list "${l.name}"`, "Undo last lists", "create the lists again") },
              { name: l.name, sites: l.sites.length, scope },
            )
          ).value;
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
      if (err instanceof UnreadAfterWriteError) {
        // No clear answer, and the site lists couldn't be read to look for it by name: it may have been made. Not
        // confirmed, not failed; there's no id, so the next create looks for it by name first.
        row.status = "unconfirmed";
        row.answer = err.answer;
        row.readBack = `not read: ${err.unread}`;
      } else {
        row.status = "failed";
        row.error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
  }
  const file = recordPath(dataDir, scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await saveFile(file, JSON.stringify(record, null, 2), { section: "cleanup", mode: 0o600 });
  return record;
}

/**
 * The rows an undo sends a delete for: lists the create made, deletes an earlier undo couldn't confirm, and deletes
 * Sophos refused (a list a profile uses, or a refusal), which a rollback also sends again.
 */
export const UNDO_LISTS_RETRY = ["created", "not confirmed", "still there after delete", "delete failed", "in use by a profile, left"];

/** Deletes the lists the last create made, by id. A list a profile uses is refused (409) and left. Run again, it sends every delete that didn't finish again. */
export async function undoLists(dataDir: string, api: TenantApi, scope: string): Promise<ListsRecord> {
  const record = await lastListsRecord(dataDir, scope);
  if (!record) throw new Error("Nothing to undo.");
  const t = record.tenantId;
  // A list Sophos didn't confirm was made has no id: it's looked for by name first, as the next create does. Found, it's
  // deleted below by that id; not there, there's nothing to remove; not read, it stays unconfirmed for Undo again.
  const asked = record.lists.filter((r) => r.status === "unconfirmed" && !r.id);
  const recorded = asked.length ? await recordedIds(dataDir, t, record) : new Set<string | undefined>();
  for (const row of asked) {
    const look = await lookUpByName(api, t, "site-list", row.name, recorded);
    if (look.unread !== undefined) row.lookedUp = `not read: ${look.unread}`;
    else if (!look.found) Object.assign(row, { status: "not there", lookedUp: "not found" });
    else Object.assign(row, { id: look.found.id, lookedUp: "found" });
  }
  for (const row of record.lists.filter((r) => r.id && (UNDO_LISTS_RETRY.includes(r.status) || r.status === "unconfirmed"))) {
    const entry = { tenantId: t, action: "delete", resource: "site-list", resourceId: row.id!, detail: { name: row.name, undo: scope } };
    // Set when the delete got no clear answer (a 5xx, no answer in time, or a dropped connection), which can come back for a delete that went through.
    let unclear: string | undefined;
    // Set when Sophos answered 404 (what it said): already gone, which a retry meets when the earlier delete went through.
    let answered404: string | undefined;
    // Only this attempt's answer counts.
    delete row.error;
    delete row.deleteAnswer;
    try {
      await deleteSiteList(api, t, row.id!);
      await auditOrWarn({ ...entry, ok: true });
    } catch (err) {
      const status = errorStatus(err);
      const message = err instanceof Error ? err.message : String(err);
      if (isUnclearWrite(err) || (status !== undefined && status >= 500)) unclear = (isUnclearWrite(err) ? err.reason : message).replace(/\.$/, "");
      else if (status === 404) answered404 = message.replace(/\.$/, "");
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
      // No clear answer, and a read-back still found it: not deleted, as a rollback counts it. Undo sends it again, as a rollback does.
      row.status = "delete failed";
      row.error = `${unclear}. A read-back still found it, so it wasn't deleted.`;
      await auditOrWarn({ ...entry, ok: false, error: row.error });
    } else {
      // Sophos accepted the delete (or gave no clear answer, or 404, and nothing could be read): not confirmed, so Undo sends it again.
      row.status = gone.unread ? "not confirmed" : "still there after delete";
      row.readBack = gone.unread ? `not read: ${gone.unread}` : "still there";
      // How Sophos answered when it wasn't a success: the page then doesn't say Sophos accepted the delete.
      if (unclear || answered404) row.deleteAnswer = unclear ?? answered404;
      if (unclear || answered404) await auditOrWarn({ ...entry, ok: false, error: `${unclear ?? "Sophos answered 404"}. ${gone.unread ? `A read-back couldn't read it (${gone.unread.replace(/\.$/, "")}), so it may still be there.` : "A read-back still found it."}` });
    }
  }
  await saveFile(recordPath(dataDir, scope), JSON.stringify(record, null, 2), { section: "cleanup", mode: 0o600 });
  return record;
}
