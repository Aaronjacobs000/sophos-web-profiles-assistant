/**
 * The pilot: which build is the live pilot, and the narrow
 * Allow entry offered from the digest.
 *
 * A narrow Allow adds the exact host (never its parent domain) to a site list
 * kept for pilot allows. The first one creates that list, named after the
 * pilot, and links it to the pilot's profile with the highest site list
 * priority, so it wins over the profile's other lists ("Higher value takes
 * priority over lower", Web Filtering API). Later ones add a site to it. Each
 * write is previewed in a dry run, sent once, read back, and audited, and
 * each entry can be undone: undoing the last entry in the list unlinks the
 * list and deletes it. The list is added to the build record, so rolling the
 * build back deletes it too. A list Sophos made whose link to the profile
 * didn't go through is kept as partial and can be undone (category D), and
 * an undo that wasn't confirmed can be sent again.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../sophos/tenant-context.js";
import { ReadOnlyApi, errorStatus, type TenantApi } from "../sophos/api/requester.js";
import {
  addSite,
  createSiteList,
  deleteSite,
  deleteSiteList,
  getProfile,
  getSiteList,
  listSiteLists,
  listSites,
  replaceProfile,
  type WebProfile,
} from "../sophos/api/web-filters.js";
import { narrowAllow } from "../domain/digest.js";
import { broadness, parseSite } from "../domain/sites.js";
import { deviceEligibility } from "../domain/eligibility.js";
import { getPolicy } from "../sophos/api/policies.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import { SITE_LIST_LIMIT } from "../domain/design.js";
import { fitName } from "../domain/cleanup.js";
import { auditedWrite, auditOrWarn } from "./audit-log.js";
import { auditedCreate, getBuild, listBuilds, saveRecord, type BuildRecord, type BuildStep } from "./build-service.js";
import { foundNote, notFound, readBack, sendChecked, takenNameAdvice } from "./write-check.js";
import { readText, saveFile } from "./safe-files.js";

const SECTION = "pilot";
const LISTS_PER_PROFILE = 20;
const SITES_PER_LIST = 750;

export interface PilotInfo {
  buildId: string;
  buildStatus: BuildRecord["status"];
  policyId: string;
  policyName: string;
  enabledAtBuild: boolean;
  profileId: string;
  profileName: string;
  snapshotFile?: string;
  targets: BuildRecord["pilot"]["targets"];
  /** Set when a rollback of this build didn't finish: when it ran, why, and what it left in the tenant. */
  rollbackUnfinished?: { at?: string; reason?: string; left: Array<{ kind: BuildStep["kind"]; name: string }> };
}

/** The newest build whose pilot policy and profile still exist by this tool's record. */
export async function activePilot(dataDir: string, tenantId: string): Promise<PilotInfo | null> {
  // A delete that failed, or that read-only mode refused, left the object in the tenant.
  const there = (s: BuildStep) => !!s.id && (s.status === "created" || s.status === "delete-failed");
  for (const b of await listBuilds(dataDir, tenantId)) {
    if (!["built", "partial", "rollback-partial"].includes(b.status)) continue;
    const policy = b.steps.find((s) => s.kind === "policy" && there(s));
    const profile = b.steps.find((s) => s.kind === "profile" && there(s));
    if (!policy || !profile) continue;
    const failed = b.rollback?.steps.find((s) => s.error || s.status === "still there after delete");
    const rollbackUnfinished =
      b.status === "rollback-partial"
        ? {
            at: b.rollback?.at,
            reason: failed ? failed.error ?? `${failed.name} was still there after the delete.` : undefined,
            left: b.steps.filter((s) => s.id && s.status !== "deleted").map((s) => ({ kind: s.kind, name: s.name })),
          }
        : undefined;
    return {
      buildId: b.id,
      buildStatus: b.status,
      policyId: policy.id!,
      policyName: policy.name,
      enabledAtBuild: b.pilot.enabled,
      profileId: profile.id!,
      profileName: profile.name,
      snapshotFile: b.snapshotFile,
      targets: b.pilot.targets,
      rollbackUnfinished,
    };
  }
  return null;
}

/** The pilot policy as the Pilot page shows it. */
export interface PilotPolicyView {
  id: string;
  name: string;
  enabled: boolean;
  priority?: number;
  endpoints: string[];
  endpointGroups: string[];
  users: string[];
  userGroups: string[];
}

/**
 * Reads the pilot policy for the Pilot page. When Sophos answers 404 it's
 * gone (deleted in Sophos Fusion, or by a rollback Sophos answered unclearly),
 * and problem says so and what to do. Any other failed read (a 403, a 5xx, no
 * answer in time) doesn't show the policy is gone: unread says why it wasn't
 * read, and there's no problem.
 */
export async function readPilotPolicy(ctx: TenantContext, pilot: PilotInfo): Promise<{ policy: PilotPolicyView | null; problem?: string; unread?: string }> {
  try {
    const p = await getPolicy(new ReadOnlyApi(ctx.client), ctx.tenantId, pilot.policyId);
    return { policy: { id: p.id, name: p.name, enabled: p.enabled ?? true, priority: p.priority, endpoints: p.appliesTo?.endpoints ?? [], endpointGroups: p.appliesTo?.endpointGroups ?? [], users: p.appliesTo?.users ?? [], userGroups: p.appliesTo?.userGroups ?? [] } };
  } catch (err) {
    if (errorStatus(err) !== 404) return { policy: null, unread: err instanceof Error ? err.message : String(err) };
    return { policy: null, problem: `The pilot policy "${pilot.policyName}" is no longer in the tenant. Roll the build back on the Build page to remove what's left of it, or build a new pilot.` };
  }
}

export interface AllowEntry {
  id: string;
  at: string;
  host: string;
  site: string;
  buildId: string;
  profileId: string;
  listId?: string;
  listName: string;
  siteId?: string;
  createdList: boolean;
  /** The profile's site list settings before the list was linked, for the undo. */
  profileBefore?: { filterBySiteList?: boolean; siteListActions: NonNullable<WebProfile["siteListActions"]> };
  /**
   * partial: Sophos made the pilot allows list, but its link to the profile didn't go through, or Sophos didn't answer it
   * with a success and no read of the profile worked (answer, and "profile not read: " in readBack), so it can be undone.
   */
  status: "added" | "partial" | "failed" | "undone" | "undo-failed";
  /**
   * What the read-back found: the site ("site listed", "not found"), or a new list ("list holds the site", "list read back
   * without the site"), with "not read: " and why when no read worked. A new list adds what the profile read back after
   * the link, after "; ": "profile links it as allow", "profile read back without the link", or "profile not read: " and why.
   */
  readBack?: string;
  /** What the read-back after the last undo found, set only when Sophos accepted the undo, or gave no clear answer, but the read-back didn't confirm it. */
  undoReadBack?: string;
  /**
   * Set when Sophos didn't answer a write with a success (a 5xx, no answer in time or a dropped connection) and nothing
   * could be read back after it, or after a new list it answered that way was found by name but not read back holding
   * the site: what it said. answer is the Allow's (with readBack), undoAnswer the last undo's. Without it, Sophos
   * accepted the write.
   */
  answer?: string;
  undoAnswer?: string;
  error?: string;
  undoneAt?: string;
  undo?: string[];
}

interface PilotRecord {
  tenantId: string;
  allows: AllowEntry[];
}

function recordPath(dataDir: string, tenantId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(tenantId)) throw new Error("Not a tenant ID.");
  return path.join(dataDir, "pilot", `${tenantId}.json`);
}

/** The Allow entries that can be undone: added, partial, and an undo that didn't finish. */
export const ALLOW_UNDOABLE: ReadonlyArray<AllowEntry["status"]> = ["added", "partial", "undo-failed"];

/** A partial Allow whose link Sophos didn't answer with a success, with no read of the profile after it: whether the list is linked isn't known. */
const linkUnknown = (a: AllowEntry) => a.status === "partial" && !!a.answer && /(^|; )profile not read: /.test(a.readBack ?? "");

export async function loadPilotRecord(dataDir: string, tenantId: string): Promise<PilotRecord> {
  const text = await readText(recordPath(dataDir, tenantId), SECTION).catch(() => null);
  const r = text ? (JSON.parse(text) as PilotRecord) : { tenantId, allows: [] };
  // Before v0.3.20 an Allow whose list Sophos made but whose link to the profile failed was saved as failed: the list is in the tenant.
  for (const a of r.allows) if (a.status === "failed" && a.createdList && a.listId) a.status = "partial";
  return r;
}

async function savePilotRecord(dataDir: string, r: PilotRecord): Promise<void> {
  const file = recordPath(dataDir, r.tenantId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await saveFile(file, JSON.stringify(r, null, 2), { section: SECTION, mode: 0o600 });
}

/** A profile as a PUT body: the whole object without the fields Sophos sets. A preset can't go with category overrides. */
export function profilePutBody(p: WebProfile): Record<string, unknown> {
  const { id, updatedAt, updatedBy, consumers, ...rest } = p;
  void id;
  void updatedAt;
  void updatedBy;
  void consumers;
  const body: Record<string, unknown> = { ...rest };
  if (body.preset) {
    delete body.categoryGroupActions;
    delete body.categoryActions;
  }
  return body;
}

export type AllowStep =
  | { op: "add-site"; listId: string; listName: string; site: string }
  | { op: "create-list"; name: string; site: string }
  | { op: "link-list"; profileId: string; profileName: string; priority: number };

export interface AllowPlan {
  pilot: PilotInfo;
  host: string;
  site: string | null;
  steps: AllowStep[];
  problems: string[];
  notes: string[];
}

function pilotListName(pilot: PilotInfo): string {
  return fitName(pilot.profileName.replace(/ profile$/i, ""), " pilot allows");
}

/** What adding a narrow Allow for host would do. Reads only. */
export async function planAllow(dataDir: string, ctx: TenantContext, host: string): Promise<AllowPlan> {
  const t = ctx.tenantId;
  const pilot = await activePilot(dataDir, t);
  if (!pilot) throw new Error("There's no pilot to add to. Build one in the Build step first.");
  const ro = new ReadOnlyApi(ctx.client);
  // A pilot policy that answers 404 is gone, so there's nothing to allow for: refuse the dry run and the write. Any other failed read doesn't show it's gone.
  const policy = await getPolicy(ro, t, pilot.policyId).catch((err) => {
    if (errorStatus(err) === 404) throw new Error(`Allow is off: the pilot policy "${pilot.policyName}" is no longer in the tenant. Roll the build back on the Build page, or build a new pilot.`);
    return null;
  });
  const site = narrowAllow(host);
  const plan: AllowPlan = { pilot, host, site, steps: [], problems: [], notes: [] };
  if (!site) {
    plan.problems.push(`"${host}" isn't a single host a site list can allow narrowly.`);
    return plan;
  }
  // A host from an event can be a whole top-level domain or a shared platform; allowing it would let far more than one site through.
  const broad = broadness(parseSite(site));
  if (broad.broad) {
    plan.problems.push(`${site} ${broad.why ?? `is broad (${broad.reason})`}: a narrow Allow takes one host. Add an entry this broad in Sophos Fusion if you mean it.`);
    return plan;
  }
  const profile = await getProfile(ro, t, pilot.profileId).catch((err) => {
    if (errorStatus(err) === 404) throw new Error("The pilot's profile no longer exists in the tenant.");
    throw err;
  });
  const record = await loadPilotRecord(dataDir, t);
  const ownIds = new Set(record.allows.filter((a) => a.status === "added" && a.createdList && a.profileId === pilot.profileId).map((a) => a.listId));
  const actions = profile.siteListActions ?? [];
  let own: { id: string; priority: number } | null = null;
  for (const a of actions) {
    const sites = (await listSites(ro, t, a.id)).map((s) => s.site.toLowerCase());
    if (ownIds.has(a.id)) {
      own = { id: a.id, priority: a.priority };
      if (sites.length >= SITES_PER_LIST) plan.problems.push(`The pilot allows list is full (${SITES_PER_LIST} sites).`);
    }
    if (!sites.includes(site)) continue;
    const listName = (await getSiteList(ro, t, a.id).catch(() => null))?.name ?? a.id;
    if (a.action === "allow") plan.problems.push(`${site} is already allowed in "${listName}".`);
    else plan.notes.push(`${site} is also in "${listName}" (${a.action}, priority ${a.priority}).`);
  }
  if (plan.problems.length) return plan;
  // The Allow writes no assignment, but a server on the computer pilot means the pilot isn't what it seems.
  if (policy?.type === "web-control" && policy.appliesTo?.endpoints?.length) {
    const servers = (await listAllEndpoints(ro, t)).filter((d) => policy.appliesTo!.endpoints!.includes(d.id) && deviceEligibility(d).kind === "server");
    if (servers.length) plan.notes.push(`The pilot is assigned to ${servers.length === 1 ? "a server" : "servers"} (${servers.map((d) => deviceEligibility(d).hostname).join(", ")}), which a Web Control policy doesn't apply to. Remove ${servers.length === 1 ? "it" : "them"} in Sophos Fusion; the tool won't add servers.`);
  }
  if (own) {
    const name = (await getSiteList(ro, t, own.id)).name;
    plan.steps.push({ op: "add-site", listId: own.id, listName: name, site });
    const higher = actions.filter((a) => a.priority > own!.priority && a.action !== "allow");
    if (higher.length) plan.notes.push(`${higher.length} block or warn lists have a higher priority than the pilot allows list; a site in one of them stays ${higher[0]!.action}ed.`);
  } else {
    const lists = await listSiteLists(ro, t);
    if (lists.length >= SITE_LIST_LIMIT) plan.problems.push(`The account has ${lists.length} of ${SITE_LIST_LIMIT} site lists, so a pilot allows list won't fit.`);
    if (actions.length >= LISTS_PER_PROFILE) plan.problems.push(`The profile already has ${LISTS_PER_PROFILE} site lists.`);
    const name = pilotListName(pilot);
    const taken = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
    // A list an earlier Allow made whose link didn't go through is this pilot's: undoing that Allow deletes it.
    const partial = taken && record.allows.find((x) => x.status === "partial" && x.listId === taken.id);
    if (partial) plan.problems.push(`The site list "${name}" from the Allow for ${partial.site} is in the tenant, but its link to the profile ${linkUnknown(partial) ? "isn't confirmed" : "didn't go through"}. Undo that Allow first, then allow this site again.`);
    else if (taken) plan.problems.push(`A site list named "${name}" already exists but isn't this pilot's; rename it first.`);
    const priority = Math.max(0, ...actions.map((a) => a.priority)) + 1;
    plan.steps.push({ op: "create-list", name, site }, { op: "link-list", profileId: pilot.profileId, profileName: pilot.profileName, priority });
    plan.notes.push(`The list gets priority ${priority}, above the profile's other lists, so the Allow wins over them.`);
  }
  return plan;
}

/** Adds the narrow Allow. Refuses when the plan found a problem. */
export async function addAllow(dataDir: string, ctx: TenantContext, host: string): Promise<{ plan: AllowPlan; entry: AllowEntry }> {
  const plan = await planAllow(dataDir, ctx, host);
  if (plan.problems.length || !plan.site) throw new Error(plan.problems.join(" ") || "Nothing to add.");
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  const t = ctx.tenantId;
  const site = plan.site;
  const record = await loadPilotRecord(dataDir, t);
  const entry: AllowEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    host,
    site,
    buildId: plan.pilot.buildId,
    profileId: plan.pilot.profileId,
    listName: "",
    createdList: false,
    status: "failed",
  };
  record.allows.unshift(entry);
  try {
    for (const step of plan.steps) {
      if (step.op === "add-site") {
        entry.listId = step.listId;
        entry.listName = step.listName;
        // A 5xx or no answer can still have gone through, so it's read back like a 2xx; a refusal is thrown.
        const { value: res, unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "add-site", "site-list", step.listId, () => addSite(api, t, step.listId, site), { site, pilotBuild: plan.pilot.buildId }));
        const back = await readBack(async () => (await listSites(ro, t, step.listId)).find((s) => s.site.toLowerCase() === site) ?? null);
        // No clear answer, and the list read back without the site: not added, so Allow can be tried again.
        if (unclear && !back.value && !back.unread) throw notFound(unclear, { where: `the site list "${step.listName}"`, found: `no ${site} in it`, advice: "Wait a minute or two, then allow it again: a site already in the list is refused as already allowed." });
        if (unclear && back.value) await auditOrWarn({ tenantId: t, action: "add-site", resource: "site-list", resourceId: step.listId, ok: true, detail: { site, note: foundNote(unclear, site, "in the list") } });
        entry.siteId = back.value?.id ?? res?.id;
        entry.readBack = back.value ? "site listed" : back.unread ? `not read: ${back.unread}` : "not found";
        // How Sophos answered when it wasn't a success: the page then doesn't say Sophos accepted the Allow.
        if (unclear && back.unread) entry.answer = unclear.reason.replace(/\.$/, "");
      } else if (step.op === "create-list") {
        const body = { name: step.name, description: "Narrow Allow entries added from the pilot digest (Web Profiles Assistant, unofficial).", sites: [site] };
        const { value, unclear } = await auditedCreate(
          t,
          "site-list",
          () => createSiteList(api, t, body),
          async () => (await listSiteLists(ro, t)).find((l) => l.name === body.name) ?? null,
          "the pilot allows list",
          { where: "the tenant's site lists", found: `no site list named "${body.name}"`, advice: takenNameAdvice(`the site list "${body.name}"`, "an undo", "allow the site again") },
          { name: body.name, sites: 1, pilotBuild: plan.pilot.buildId },
        );
        entry.listId = value.id;
        entry.listName = step.name;
        entry.createdList = true;
        // Made: a read-back that fails leaves the Allow unconfirmed, not failed, and the list is still the build's.
        const back = await readBack(async () => {
          const l = await getSiteList(ro, t, value.id);
          return l.sites ?? (await listSites(ro, t, value.id)).map((x) => x.site);
        });
        entry.readBack = back.value ? (back.value.map((x) => x.toLowerCase()).includes(site) ? "list holds the site" : "list read back without the site") : `not read: ${back.unread ?? "no read-back"}`;
        // Found by name after a 5xx says it was made, not what's in it: unless it read back holding the site, the page doesn't say Sophos accepted the Allow.
        if (unclear && entry.readBack !== "list holds the site") entry.answer = unclear.reason.replace(/\.$/, "");
        // The build owns the list from here, so rolling the build back deletes it.
        const build = await getBuild(dataDir, t, plan.pilot.buildId);
        build.steps.push({
          order: build.steps.length + 1,
          kind: "site-list",
          key: `pilot-allows-${value.id}`,
          name: step.name,
          method: "POST",
          path: "/web-filters/v1/site-lists",
          summary: "Narrow Allow entries from the pilot digest",
          body: {},
          status: "created",
          id: value.id,
          readBack: "matches",
        });
        await saveRecord(dataDir, build);
      } else {
        const current = await getProfile(ro, t, step.profileId);
        entry.profileBefore = { filterBySiteList: current.filterBySiteList, siteListActions: current.siteListActions ?? [] };
        const body = profilePutBody(current);
        body.filterBySiteList = true;
        body.siteListActions = [...(current.siteListActions ?? []), { id: entry.listId!, action: "allow", priority: step.priority }];
        // A 5xx or no answer can still have gone through, so it's read back like a 2xx; a refusal is thrown, and the list stays undoable.
        const { unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "update", "profile", step.profileId, () => replaceProfile(api, t, step.profileId, body), { linkList: entry.listId, action: "allow", priority: step.priority }));
        const back = await readBack(async () => {
          const p = await getProfile(ro, t, step.profileId);
          return (p.siteListActions ?? []).some((a) => a.id === entry.listId && a.action === "allow" && a.priority === step.priority) ? p : null;
        });
        // No clear answer, and the link didn't read back (or nothing could be read): not confirmed linked, so the entry is partial and its list can be undone.
        if (unclear && !back.value) {
          // Nothing read: the link may have gone through, so the entry keeps what Sophos said and why the profile wasn't read, and the page doesn't say it didn't.
          if (back.unread) {
            entry.readBack = `${entry.readBack}; profile not read: ${back.unread}`;
            entry.answer = unclear.reason.replace(/\.$/, "");
          }
          throw notFound(unclear, { where: `the profile "${step.profileName}"`, found: "no link to the list in it", advice: "Undo it from Allow entries, then allow the site again.", check: `the profile "${step.profileName}" in Sophos Fusion` }, back.unread);
        }
        if (unclear) await auditOrWarn({ tenantId: t, action: "update", resource: "profile", resourceId: step.profileId, ok: true, detail: { linkList: entry.listId, note: foundNote(unclear, "the link to the list", "in the profile") } });
        // A profile no read worked on says why it wasn't read, never that it read back without the link.
        entry.readBack = `${entry.readBack}; ${back.value ? "profile links it as allow" : back.unread ? `profile not read: ${back.unread}` : "profile read back without the link"}`;
      }
    }
    entry.status = "added";
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    // Sophos made the list, so it's in the tenant whatever went wrong after: the entry can be undone, which deletes it (category D).
    if (entry.createdList && entry.listId) entry.status = "partial";
  }
  await savePilotRecord(dataDir, record);
  if (entry.status === "failed") throw new Error(`The Allow entry wasn't completed: ${entry.error}`);
  return { plan, entry };
}

/** What a read-back says when it confirms an Allow: the site in the list, and a new list linked to the profile (the page uses the same). */
const CONFIRMED_PARTS = new Set(["site listed", "list holds the site", "profile links it as allow"]);
const allowConfirmed = (readBack: string | undefined) => !!readBack && readBack.split("; ").every((part) => CONFIRMED_PARTS.has(part));

/**
 * Marks the pilot allows list in the build record as deleted, or as a delete that didn't finish, so a rollback knows.
 * A delete that wasn't confirmed keeps its read-back ("still there", or "not read: " and why), and what Sophos said when
 * it didn't answer with a success, as a rollback keeps them, so the Build page shows it as not confirmed, not failed.
 * One that failed keeps why (error), for the Build page's Detail line.
 */
async function markListDeleted(dataDir: string, tenantId: string, buildId: string, listId: string, outcome: { gone: boolean; readBack?: string; answer?: string; error?: string }): Promise<void> {
  const build = await getBuild(dataDir, tenantId, buildId).catch(() => null);
  const step = build?.steps.find((s) => s.id === listId);
  if (!build || !step) return;
  step.status = outcome.gone ? "deleted" : "delete-failed";
  if (outcome.readBack) step.deleteReadBack = outcome.readBack;
  else delete step.deleteReadBack;
  if (outcome.readBack && outcome.answer) step.deleteAnswer = outcome.answer;
  else delete step.deleteAnswer;
  if (!outcome.gone && !outcome.readBack && outcome.error) step.deleteError = outcome.error;
  else delete step.deleteError;
  await saveRecord(dataDir, build);
}

/** Undoes one Allow entry. The last entry in a list this tool made takes the list with it. Sent again, it finishes what an earlier undo couldn't confirm. */
export async function undoAllow(dataDir: string, ctx: TenantContext, allowId: string): Promise<AllowEntry> {
  const t = ctx.tenantId;
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  const record = await loadPilotRecord(dataDir, t);
  const entry = record.allows.find((a) => a.id === allowId);
  if (!entry) throw new Error("No such Allow entry.");
  if (!ALLOW_UNDOABLE.includes(entry.status) || !entry.listId) throw new Error(`This entry is ${entry.status}; there's nothing to undo.`);
  const listId = entry.listId;
  const notes: string[] = [];
  // An undo sent again, or one of an Allow that wasn't confirmed, may meet what an earlier write already did: the list gone, or the site not in it.
  const retry = !(entry.status === "added" && allowConfirmed(entry.readBack));
  // Only this attempt's read-back counts.
  delete entry.undoReadBack;
  delete entry.undoAnswer;
  try {
    const sites = await listSites(ro, t, listId).catch((err: unknown) => {
      if (retry && errorStatus(err) === 404) return null;
      throw err;
    });
    const ownsList = record.allows.some((a) => a.listId === listId && a.createdList);
    const others = record.allows.filter((a) => a.listId === listId && a.status === "added" && a.id !== entry.id);
    if (!sites) {
      // The list answers 404: an earlier delete went through, so the site is gone with it.
      notes.push(ownsList ? "List deleted, 404 on read-back." : "Site removed, confirmed on read-back.");
      if (ownsList) await markListDeleted(dataDir, t, entry.buildId, listId, { gone: true });
    } else if (ownsList && others.length === 0 && sites.every((s) => s.site.toLowerCase() === entry.site)) {
      // Unlink, then delete the list (the API refuses to delete a list in use).
      const creator = record.allows.find((a) => a.listId === listId && a.createdList)!;
      const p = await getProfile(ro, t, entry.profileId).catch((err) => (errorStatus(err) === 404 ? null : Promise.reject(err)));
      if (p && (p.siteListActions ?? []).some((a) => a.id === listId)) {
        const body = profilePutBody(p);
        body.siteListActions = (p.siteListActions ?? []).filter((a) => a.id !== listId);
        body.filterBySiteList = (body.siteListActions as unknown[]).length ? true : creator.profileBefore?.filterBySiteList ?? false;
        // A 5xx or no answer can still have gone through, so it's read back like a 2xx; a refusal is thrown.
        const { unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "update", "profile", entry.profileId, () => replaceProfile(api, t, entry.profileId, body), { unlinkList: listId, undo: entry.id }));
        const back = await readBack(async () => {
          const q = await getProfile(ro, t, entry.profileId);
          return (q.siteListActions ?? []).some((a) => a.id === listId) ? null : q;
        });
        // No clear answer, and the profile still links the list: not unlinked, so the list can't be deleted yet.
        if (unclear && !back.value && !back.unread) throw new Error(`${unclear.reason.replace(/\.$/, "")}. A read-back found the profile still linking the list, so it wasn't unlinked. Undo again in a minute or two.`);
        if (unclear && back.value) await auditOrWarn({ tenantId: t, action: "update", resource: "profile", resourceId: entry.profileId, ok: true, detail: { unlinkList: listId, undo: entry.id, note: foundNote(unclear, "the profile without the list", "in the tenant") } });
        // A read that failed doesn't show the list is still linked, only that the unlink isn't confirmed.
        notes.push(back.value ? "Profile read back without the list." : back.unread ? "The profile couldn't be read back, so the unlink isn't confirmed." : "Profile still shows the list.");
        if (unclear && back.unread) entry.undoAnswer = unclear.reason.replace(/\.$/, "");
      }
      // A 404 was already gone; a 5xx or no answer can still have gone through. The read-back settles both, as in a rollback.
      const { unclear } = await sendChecked(() =>
        auditedWrite({ tenantId: t }, "delete", "site-list", listId, () => deleteSiteList(api, t, listId), { name: entry.listName, undo: entry.id }).catch((err: unknown) => {
          if (errorStatus(err) !== 404) throw err;
        }),
      );
      // Any answer but a 404 is a read that failed, not proof the list is still there.
      const gone = await readBack(async () => {
        try {
          await getSiteList(ro, t, listId);
          return null;
        } catch (err) {
          if (errorStatus(err) === 404) return true;
          throw err;
        }
      });
      notes.push(gone.value ? "List deleted, 404 on read-back." : gone.unread ? "The list couldn't be read back, so the delete isn't confirmed." : "List still there after delete.");
      // Not confirmed gone after a delete Sophos accepted, or one it gave no clear answer to and nothing could be read: kept, as a rollback keeps it.
      const kept = gone.value || (unclear && !gone.unread) ? undefined : gone.unread ? `not read: ${gone.unread}` : "still there";
      // No clear answer, and a read-back still found it: not deleted, as a rollback counts it, and the build step says why.
      const stillThere = unclear && !gone.value && !gone.unread ? `${unclear.reason.replace(/\.$/, "")}. A read-back still found the list, so it wasn't deleted.` : undefined;
      await markListDeleted(dataDir, t, entry.buildId, listId, { gone: !!gone.value, readBack: kept, answer: unclear?.reason.replace(/\.$/, ""), error: stillThere });
      if (unclear && gone.value) await auditOrWarn({ tenantId: t, action: "delete", resource: "site-list", resourceId: listId, ok: true, detail: { undo: entry.id, note: `${unclear.status ? `Sophos answered ${unclear.status}` : "Sophos gave no clear answer"}, then a read-back found it gone (404)` } });
      if (stillThere) throw new Error(`${stillThere} Undo again in a minute or two.`);
      if (!gone.value) {
        entry.undoReadBack = gone.unread ? `not read: ${gone.unread}` : "list still there";
        if (unclear) entry.undoAnswer ??= unclear.reason.replace(/\.$/, "");
        throw new Error(notes.join(" "));
      }
    } else if (retry && !sites.some((s) => s.site.toLowerCase() === entry.site)) {
      // Not in the list: an earlier delete went through, or the Allow never landed. Either way there's nothing to remove.
      notes.push("Site removed, confirmed on read-back.");
    } else {
      const siteId = entry.siteId ?? sites.find((s) => s.site.toLowerCase() === entry.site)?.id;
      if (!siteId) throw new Error(`${entry.site} isn't in the list any more.`);
      // A 5xx or no answer can still have gone through: the read-back settles it.
      const { unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "delete-site", "site-list", listId, () => deleteSite(api, t, listId, siteId), { site: entry.site, undo: entry.id }));
      const back = await readBack(async () => ((await listSites(ro, t, listId)).some((s) => s.site.toLowerCase() === entry.site) ? null : true));
      notes.push(back.value ? "Site removed, confirmed on read-back." : back.unread ? "The list couldn't be read back, so the removal isn't confirmed." : "Site still listed after delete.");
      if (unclear && back.value) await auditOrWarn({ tenantId: t, action: "delete-site", resource: "site-list", resourceId: listId, ok: true, detail: { site: entry.site, undo: entry.id, note: foundNote(unclear, `${entry.site} gone`, "from the list") } });
      if (unclear && !back.value && !back.unread) throw new Error(`${unclear.reason.replace(/\.$/, "")}. A read-back still found ${entry.site} in the list, so it wasn't removed. Undo again in a minute or two.`);
      if (!back.value) {
        entry.undoReadBack = back.unread ? `not read: ${back.unread}` : "site still listed";
        if (unclear) entry.undoAnswer = unclear.reason.replace(/\.$/, "");
        throw new Error(notes.join(" "));
      }
    }
    entry.status = "undone";
    entry.undoneAt = new Date().toISOString();
    // An earlier undo that failed is over now: the entry no longer carries its error (the audit log keeps both).
    delete entry.error;
  } catch (err) {
    entry.status = "undo-failed";
    entry.error = err instanceof Error ? err.message : String(err);
  }
  entry.undo = notes;
  await savePilotRecord(dataDir, record);
  return entry;
}
