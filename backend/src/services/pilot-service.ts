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
 * an undo that wasn't confirmed can be sent again. A new list Sophos gave no
 * clear answer to, with the site lists unread after, is kept as unconfirmed:
 * the next Allow looks for it by name, and uses it if it's there. Each write
 * is marked as sending, and saved, before it goes, so a server that stops
 * while one is in flight leaves the entry not confirmed, as a build does. So
 * is each write of an undo: after a stop the undo is not confirmed, and Undo
 * again finishes it, or finds the site or the list already gone.
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
import { IN_FLIGHT, auditedCreate, foundByName, getBuild, idsCreatedByTool, listBuilds, lookUpByName, saveRecord, unreadLookUp, type BuildRecord, type BuildStep } from "./build-service.js";
import { UnreadAfterWriteError, foundNote, notFound, readBack, sendChecked, takenNameAdvice, unreadCreateFrom } from "./write-check.js";
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
            // A step Sophos didn't confirm was made, which the rollback couldn't look for by name, may be there too.
            left: b.steps.filter((s) => (s.id && s.status !== "deleted") || s.status === "unconfirmed").map((s) => ({ kind: s.kind, name: s.name })),
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
   * unconfirmed: Sophos didn't answer the new list's create with a success, and the tenant's site lists couldn't be read
   * to look for it by name after (answer, and "not read: " in readBack), so it may have been made. There's no list id;
   * the next Allow looks for the list by name first, and an Allow of the same site carries on this entry. Undo, and a
   * rollback of the build, look for it by name too, and delete it if it's there.
   */
  status: "added" | "partial" | "unconfirmed" | "failed" | "undone" | "undo-failed";
  /** Set on an unconfirmed entry when Undo couldn't read the site lists to look for its list by name: "not read: " and why. */
  undoLookUp?: string;
  /** Set when the Allow used a list it found by name, which an earlier Allow asked for (unconfirmed): says so. */
  note?: string;
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
  /**
   * Set, and saved, just before a write of this entry's Allow is sent (the new list's create, its link to the profile,
   * or the site's add to a list), and cleared once the Allow's outcome is recorded. An entry saved with it was in flight
   * when the server stopped, so the write may have gone through: it's read as not confirmed (loadPilotRecord).
   */
  sending?: boolean;
  /** The same for a write of an undo (the unlink, the list's delete or the site's). An entry saved with it is read as an undo not confirmed. */
  undoSending?: boolean;
}

interface PilotRecord {
  tenantId: string;
  allows: AllowEntry[];
}

function recordPath(dataDir: string, tenantId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(tenantId)) throw new Error("Not a tenant ID.");
  return path.join(dataDir, "pilot", `${tenantId}.json`);
}

/** The Allow entries that can be undone: added, partial, an undo that didn't finish, and one whose list Sophos didn't confirm (looked for by name). */
export const ALLOW_UNDOABLE: ReadonlyArray<AllowEntry["status"]> = ["added", "partial", "undo-failed", "unconfirmed"];

/** A partial Allow whose link Sophos didn't answer with a success, with no read of the profile after it: whether the list is linked isn't known. */
const linkUnknown = (a: AllowEntry) => a.status === "partial" && !!a.answer && /(^|; )profile not read: /.test(a.readBack ?? "");

export async function loadPilotRecord(dataDir: string, tenantId: string): Promise<PilotRecord> {
  const text = await readText(recordPath(dataDir, tenantId), SECTION).catch(() => null);
  const r = text ? (JSON.parse(text) as PilotRecord) : { tenantId, allows: [] };
  // Before v0.3.20 an Allow whose list Sophos made but whose link to the profile failed was saved as failed: the list is in the tenant.
  for (const a of r.allows) if (a.status === "failed" && a.createdList && a.listId) a.status = "partial";
  // Before v0.3.24 an Allow whose new list Sophos didn't answer with a success, with the site lists unread after, was
  // saved as failed with no list: it's unconfirmed, so the next Allow, Undo and a rollback look for the list by name. It
  // asked for the pilot's list name, from its build's profile. The file isn't changed.
  for (const a of r.allows) {
    const was = a.status === "failed" && !a.listId && !a.createdList ? unreadCreateFrom(a.error, "the tenant's site lists") : null;
    const profile = was && (await getBuild(dataDir, tenantId, a.buildId).catch(() => null))?.steps.find((s) => s.kind === "profile");
    if (!was || !profile) continue;
    a.status = "unconfirmed";
    a.listName ||= pilotListName({ profileName: profile.name });
    a.answer = was.answer;
    a.readBack = `not read: ${was.unread}`;
    delete a.error;
  }
  // An Allow with a write in flight when the server stopped (sending) may have made it, so it's not confirmed, in the
  // state the same write is in when Sophos gives no clear answer and nothing can be read after. The file isn't changed.
  for (const a of r.allows) {
    if (!a.sending) continue;
    delete a.sending;
    a.answer = IN_FLIGHT.answer;
    if (!a.listId) {
      // The new list's create: the next Allow, Undo and a rollback look for the list by name.
      a.status = "unconfirmed";
      a.readBack = `not read: ${IN_FLIGHT.unread}`;
    } else if (a.createdList) {
      // The list was made, and its link to the profile was in flight or still to send: Undo removes the list.
      a.status = "partial";
      a.readBack = `${a.readBack ? `${a.readBack}; ` : ""}profile not read: ${IN_FLIGHT.unread}`;
    } else {
      // The site's add to a list: Undo removes the site if it's there.
      a.status = "added";
      a.readBack = `not read: ${IN_FLIGHT.unread}`;
    }
  }
  // An entry whose undo had a write in flight (undoSending) may be undone: the undo isn't confirmed, in the state an undo
  // Sophos gave no clear answer to is in when nothing could be read after, so Undo again reads the list first, and
  // finishes when the site or the list is already gone. The file isn't changed.
  for (const a of r.allows) {
    if (!a.undoSending) continue;
    delete a.undoSending;
    a.status = "undo-failed";
    a.undoAnswer = IN_FLIGHT.answer;
    a.undoReadBack = `not read: ${IN_FLIGHT.unread}`;
    a.error = "The tool couldn't read it back, so the undo isn't confirmed.";
  }
  return r;
}

/** The ids on record that a list found by name for an unconfirmed Allow can't be: every build's, and every Allow's. */
async function recordedListIds(dataDir: string, tenantId: string, record: PilotRecord): Promise<Set<string | undefined>> {
  return new Set([...(await idsCreatedByTool(dataDir, tenantId)), ...record.allows.map((x) => x.listId)]);
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
  /** The list an unconfirmed Allow (allowId, for site) asked for, found by name: that entry takes it, as if it had made it. */
  | { op: "use-list"; listId: string; name: string; site: string; allowId: string }
  | { op: "link-list"; profileId: string; profileName: string; priority: number };

export interface AllowPlan {
  pilot: PilotInfo;
  host: string;
  site: string | null;
  steps: AllowStep[];
  problems: string[];
  notes: string[];
}

function pilotListName(pilot: Pick<PilotInfo, "profileName">): string {
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
    const name = pilotListName(pilot);
    const taken = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
    // A list an earlier Allow made whose link didn't go through is this pilot's: undoing that Allow deletes it.
    const partial = taken && record.allows.find((x) => x.status === "partial" && x.listId === taken.id);
    // An earlier Allow whose create of the list Sophos didn't confirm (unconfirmed) may have made it: a list by that name
    // that no record has an id for is that one, and this Allow uses it. The entry for this site goes first.
    const asked = record.allows.filter((x) => x.status === "unconfirmed" && !x.listId && x.buildId === pilot.buildId && x.listName.toLowerCase() === name.toLowerCase());
    const there = taken && !partial && asked.length ? foundByName(lists, name, await recordedListIds(dataDir, t, record)) : undefined;
    const by = there ? asked.find((x) => x.site === site) ?? asked[0] : undefined;
    // A list found by name for an earlier Allow is already in the account.
    if (lists.length >= SITE_LIST_LIMIT && !by) plan.problems.push(`The account has ${lists.length} of ${SITE_LIST_LIMIT} site lists, so a pilot allows list won't fit.`);
    if (actions.length >= LISTS_PER_PROFILE) plan.problems.push(`The profile already has ${LISTS_PER_PROFILE} site lists.`);
    if (partial) plan.problems.push(`The site list "${name}" from the Allow for ${partial.site} is in the tenant, but its link to the profile ${linkUnknown(partial) ? "isn't confirmed" : "didn't go through"}. Undo that Allow first, then allow this site again.`);
    else if (taken && !by) plan.problems.push(`A site list named "${name}" already exists but isn't this pilot's; rename it first.`);
    const priority = Math.max(0, ...actions.map((a) => a.priority)) + 1;
    if (taken && by) {
      plan.steps.push({ op: "use-list", listId: taken.id, name: taken.name, site: by.site, allowId: by.id }, { op: "link-list", profileId: pilot.profileId, profileName: pilot.profileName, priority });
      if (by.site !== site) plan.steps.push({ op: "add-site", listId: taken.id, listName: taken.name, site });
      plan.notes.push(`The site list "${taken.name}" from the Allow for ${by.site} is in the tenant. Sophos didn't confirm it was made, so this Allow uses it rather than making another.`);
    } else plan.steps.push({ op: "create-list", name, site }, { op: "link-list", profileId: pilot.profileId, profileName: pilot.profileName, priority });
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
  // The same site again after an Allow that wasn't confirmed (unconfirmed) carries on that entry, so the site has one.
  const again = record.allows.find((a) => a.status === "unconfirmed" && a.site === site && a.buildId === plan.pilot.buildId);
  if (again) record.allows.splice(record.allows.indexOf(again), 1);
  const entry: AllowEntry = {
    id: again?.id ?? randomUUID(),
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
  // The entry that holds a new list: this one, or an earlier unconfirmed Allow whose list was found by name (use-list).
  let holder = entry;
  // What the profile read back after the link, which an Allow that adds its site to another entry's list carries too.
  let linked: string | undefined;
  /**
   * Marks the entry a write is about to go for, and saves the record before it goes, so a server that stops before the
   * outcome is recorded leaves it as sent (loadPilotRecord). This Allow's own entry is saved once a write of its own goes.
   */
  const sending = async (a: AllowEntry): Promise<void> => {
    a.sending = true;
    await savePilotRecord(dataDir, { ...record, allows: record.allows.filter((x) => x !== entry || x.sending) });
  };
  try {
    for (const step of plan.steps) {
      if (step.op === "use-list") {
        holder = record.allows.find((a) => a.id === step.allowId) ?? entry;
        holder.listId = step.listId;
        holder.listName = step.name;
        holder.createdList = true;
        // On record as the list's holder, with its link still to send, before the build takes the list.
        await sending(holder);
        // The build owns the list from here, as one the Allow made, so rolling the build back deletes it.
        await ownedByBuild(dataDir, t, plan.pilot.buildId, step.listId, step.name);
        entry.note = `The site list "${step.name}" was found by name and used, not made again.`;
        await auditOrWarn({ tenantId: t, action: "reuse", resource: "site-list", resourceId: step.listId, ok: true, detail: { name: step.name, pilotBuild: plan.pilot.buildId, allow: holder.id, note: "Found by name after an Allow's create Sophos didn't confirm; used, not made again" } });
        const back = await readBack(async () => {
          const l = await getSiteList(ro, t, step.listId);
          return l.sites ?? (await listSites(ro, t, step.listId)).map((x) => x.site);
        });
        holder.readBack = back.value ? (back.value.map((x) => x.toLowerCase()).includes(holder.site) ? "list holds the site" : "list read back without the site") : `not read: ${back.unread ?? "no read-back"}`;
        // Found by name says it was made, not what's in it: what Sophos said to the create stays unless it read back holding the site.
        if (holder.readBack === "list holds the site") delete holder.answer;
      } else if (step.op === "add-site") {
        entry.listId = step.listId;
        entry.listName = step.listName;
        await sending(entry);
        // A 5xx or no answer can still have gone through, so it's read back like a 2xx; a refusal is thrown.
        const { value: res, unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "add-site", "site-list", step.listId, () => addSite(api, t, step.listId, site), { site, pilotBuild: plan.pilot.buildId }));
        const back = await readBack(async () => (await listSites(ro, t, step.listId)).find((s) => s.site.toLowerCase() === site) ?? null);
        // No clear answer, and the list read back without the site: not added, so Allow can be tried again.
        if (unclear && !back.value && !back.unread) throw notFound(unclear, { where: `the site list "${step.listName}"`, found: `no ${site} in it`, advice: "Wait a minute or two, then allow it again: a site already in the list is refused as already allowed." });
        if (unclear && back.value) await auditOrWarn({ tenantId: t, action: "add-site", resource: "site-list", resourceId: step.listId, ok: true, detail: { site, note: foundNote(unclear, site, "in the list") } });
        entry.siteId = back.value?.id ?? res?.id;
        entry.readBack = back.value ? "site listed" : back.unread ? `not read: ${back.unread}` : "not found";
        // Added to a list this Allow linked for an earlier entry: the link is part of this Allow too.
        if (linked) entry.readBack = `${entry.readBack}; ${linked}`;
        // How Sophos answered when it wasn't a success: the page then doesn't say Sophos accepted the Allow.
        if (unclear && back.unread) entry.answer = unclear.reason.replace(/\.$/, "");
      } else if (step.op === "create-list") {
        const body = { name: step.name, description: "Narrow Allow entries added from the pilot digest (Web Profiles Assistant, unofficial).", sites: [site] };
        // Saved with the list's name, so after a stop the next Allow, Undo and a rollback look for it by name.
        entry.listName = step.name;
        await sending(entry);
        const made = await auditedCreate(
          t,
          "site-list",
          () => createSiteList(api, t, body),
          async () => (await listSiteLists(ro, t)).find((l) => l.name === body.name) ?? null,
          "the pilot allows list",
          { where: "the tenant's site lists", found: `no site list named "${body.name}"`, advice: takenNameAdvice(`the site list "${body.name}"`, "an undo", "allow the site again") },
          { name: body.name, sites: 1, pilotBuild: plan.pilot.buildId },
        ).catch((err: unknown) => {
          if (!(err instanceof UnreadAfterWriteError)) throw err;
          // No clear answer, and the site lists couldn't be read to look for it by name: it may have been made. There's no
          // id, so nothing here can undo it; the next Allow looks for it by name first, and uses it if it's there.
          entry.listName = step.name;
          entry.status = "unconfirmed";
          entry.answer = err.answer;
          entry.readBack = `not read: ${err.unread}`;
          return null;
        });
        if (!made) break;
        const { value, unclear } = made;
        entry.listId = value.id;
        entry.listName = step.name;
        entry.createdList = true;
        // On record with the list's id, its link still to send, before the build takes the list.
        await sending(entry);
        // The build owns the list from here, so rolling the build back deletes it.
        await ownedByBuild(dataDir, t, plan.pilot.buildId, value.id, step.name);
        // Made: a read-back that fails leaves the Allow unconfirmed, not failed, and the list is still the build's.
        const back = await readBack(async () => {
          const l = await getSiteList(ro, t, value.id);
          return l.sites ?? (await listSites(ro, t, value.id)).map((x) => x.site);
        });
        entry.readBack = back.value ? (back.value.map((x) => x.toLowerCase()).includes(site) ? "list holds the site" : "list read back without the site") : `not read: ${back.unread ?? "no read-back"}`;
        // Found by name after a 5xx says it was made, not what's in it: unless it read back holding the site, the page doesn't say Sophos accepted the Allow.
        if (unclear && entry.readBack !== "list holds the site") entry.answer = unclear.reason.replace(/\.$/, "");
      } else {
        // The link is the holder's: the entry whose list it is.
        const current = await getProfile(ro, t, step.profileId);
        holder.profileBefore = { filterBySiteList: current.filterBySiteList, siteListActions: current.siteListActions ?? [] };
        const body = profilePutBody(current);
        body.filterBySiteList = true;
        body.siteListActions = [...(current.siteListActions ?? []), { id: holder.listId!, action: "allow", priority: step.priority }];
        await sending(holder);
        // A 5xx or no answer can still have gone through, so it's read back like a 2xx; a refusal is thrown, and the list stays undoable.
        const { unclear } = await sendChecked(() => auditedWrite({ tenantId: t }, "update", "profile", step.profileId, () => replaceProfile(api, t, step.profileId, body), { linkList: holder.listId, action: "allow", priority: step.priority }));
        const back = await readBack(async () => {
          const p = await getProfile(ro, t, step.profileId);
          return (p.siteListActions ?? []).some((a) => a.id === holder.listId && a.action === "allow" && a.priority === step.priority) ? p : null;
        });
        // No clear answer, and the link didn't read back (or nothing could be read): not confirmed linked, so the entry is partial and its list can be undone.
        if (unclear && !back.value) {
          // Nothing read: the link may have gone through, so the entry keeps what Sophos said and why the profile wasn't read, and the page doesn't say it didn't.
          if (back.unread) {
            holder.readBack = `${holder.readBack}; profile not read: ${back.unread}`;
            holder.answer = unclear.reason.replace(/\.$/, "");
          }
          throw notFound(unclear, { where: `the profile "${step.profileName}"`, found: "no link to the list in it", advice: "Undo it from Allow entries, then allow the site again.", check: `the profile "${step.profileName}" in Sophos Fusion` }, back.unread);
        }
        if (unclear) await auditOrWarn({ tenantId: t, action: "update", resource: "profile", resourceId: step.profileId, ok: true, detail: { linkList: holder.listId, note: foundNote(unclear, "the link to the list", "in the profile") } });
        // A profile no read worked on says why it wasn't read, never that it read back without the link.
        linked = back.value ? "profile links it as allow" : back.unread ? `profile not read: ${back.unread}` : "profile read back without the link";
        holder.readBack = `${holder.readBack}; ${linked}`;
        // An earlier entry whose list this Allow found and linked is added now, whatever happens to this Allow's own site.
        if (holder !== entry) holder.status = "added";
        // The link's outcome is recorded: the holder has no write in flight.
        delete holder.sending;
      }
    }
    if (entry.status !== "unconfirmed") entry.status = "added";
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    // Sophos made the list, so it's in the tenant whatever went wrong after: the entry can be undone, which deletes it (category D).
    if (entry.createdList && entry.listId) entry.status = "partial";
    // So does an earlier entry whose list this Allow found by name, when the link didn't finish.
    if (holder !== entry && holder.status !== "added") {
      holder.status = "partial";
      holder.error = entry.error;
    }
  }
  // The outcome is recorded: nothing is in flight.
  delete entry.sending;
  delete holder.sending;
  await savePilotRecord(dataDir, record);
  if (entry.status === "failed") throw new Error(`The Allow entry wasn't completed: ${entry.error}`);
  return { plan, entry };
}

/** What a read-back says when it confirms an Allow: the site in the list, and a new list linked to the profile (the page uses the same). */
const CONFIRMED_PARTS = new Set(["site listed", "list holds the site", "profile links it as allow"]);
const allowConfirmed = (readBack: string | undefined) => !!readBack && readBack.split("; ").every((part) => CONFIRMED_PARTS.has(part));

/** What Undo, or a rollback of the build, says of an unconfirmed Allow's list it looked for by name (the page uses the same). */
const FOUND_LIST = "The list was found by name.";
const NOTHING_TO_REMOVE = "No list by that name in the tenant, so there was nothing to remove.";

/** Adds the pilot allows list to the build record, so rolling the build back deletes it. */
async function ownedByBuild(dataDir: string, tenantId: string, buildId: string, listId: string, name: string): Promise<void> {
  const build = await getBuild(dataDir, tenantId, buildId);
  // A rollback that couldn't look for this list by name left a step for it with no id: it takes the id.
  const asked = build.steps.find((s) => s.kind === "site-list" && s.status === "unconfirmed" && !s.id && s.name.toLowerCase() === name.toLowerCase());
  if (asked) {
    Object.assign(asked, { status: "created", id: listId, readBack: "matches" });
    delete asked.answer;
    delete asked.readBackNote;
    await saveRecord(dataDir, build);
    return;
  }
  build.steps.push({
    order: build.steps.length + 1,
    kind: "site-list",
    key: `pilot-allows-${listId}`,
    name,
    method: "POST",
    path: "/web-filters/v1/site-lists",
    summary: "Narrow Allow entries from the pilot digest",
    body: {},
    status: "created",
    id: listId,
    readBack: "matches",
  });
  await saveRecord(dataDir, build);
}

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
  // Only this attempt's lookup counts.
  delete entry.undoLookUp;
  let lookedUp: string | undefined;
  if (entry.status === "unconfirmed" && !entry.listId) {
    // Sophos didn't confirm the new list was made, so there's no id: look for it by name, as the next Allow does.
    const look = await lookUpByName(api, t, "site-list", entry.listName, await recordedListIds(dataDir, t, record));
    if (look.unread !== undefined) {
      // Not read: it may or may not be there, so the entry stays unconfirmed, and Undo looks again.
      entry.undoLookUp = `not read: ${look.unread}`;
      entry.undo = [unreadLookUp("site-list", look.unread)];
      await savePilotRecord(dataDir, record);
      return entry;
    }
    if (!look.found) {
      entry.status = "undone";
      entry.undoneAt = new Date().toISOString();
      entry.undo = [NOTHING_TO_REMOVE];
      await savePilotRecord(dataDir, record);
      return entry;
    }
    // Found: the entry holds it, as if the Allow had made it, and so does the build; the undo below deletes it.
    entry.listId = look.found.id;
    entry.createdList = true;
    await ownedByBuild(dataDir, t, entry.buildId, look.found.id, entry.listName);
    lookedUp = FOUND_LIST;
  }
  if (!ALLOW_UNDOABLE.includes(entry.status) || !entry.listId) throw new Error(`This entry is ${entry.status}; there's nothing to undo.`);
  const listId = entry.listId;
  const notes: string[] = lookedUp ? [lookedUp] : [];
  // An undo sent again, or one of an Allow that wasn't confirmed, may meet what an earlier write already did: the list gone, or the site not in it.
  const retry = !(entry.status === "added" && allowConfirmed(entry.readBack));
  // Only this attempt's read-back counts.
  delete entry.undoReadBack;
  delete entry.undoAnswer;
  /** Marks a write of the undo about to go, and saves the record before it goes, so a server that stops before the outcome is recorded leaves the undo as sent (loadPilotRecord). */
  const sending = async (): Promise<void> => {
    entry.undoSending = true;
    await savePilotRecord(dataDir, record);
  };
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
        await sending();
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
      await sending();
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
      await sending();
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
  // The outcome is recorded: nothing is in flight.
  delete entry.undoSending;
  await savePilotRecord(dataDir, record);
  return entry;
}

/** The key a rollback gives the step it adds for an unconfirmed Allow's list (askedAllowLists). */
const ASKED_KEY = "pilot-allows-asked-";

/**
 * For a rollback of a build: an Allow of it whose new list Sophos didn't confirm (unconfirmed, no list id) left no id to
 * delete, so the rollback looks for that list by name, with the ids the next Allow leaves alone (recorded). Each name the
 * build has no step for yet comes back as an unconfirmed step for the rollback to add.
 */
export async function askedAllowLists(dataDir: string, tenantId: string, build: BuildRecord): Promise<{ steps: BuildStep[]; recorded: Set<string | undefined> }> {
  const record = await loadPilotRecord(dataDir, tenantId);
  const steps: BuildStep[] = [];
  for (const a of record.allows) {
    if (a.status !== "unconfirmed" || a.listId || a.buildId !== build.id || !a.listName) continue;
    // One step a name: a rollback before this one that couldn't look may have added it already, or one that stopped
    // before it settled the entry may have found the list (the step has its id), and this one deletes it by that id.
    if ([...build.steps, ...steps].some((s) => s.kind === "site-list" && s.name.toLowerCase() === a.listName.toLowerCase() && ((s.status === "unconfirmed" && !s.id) || (s.key.startsWith(ASKED_KEY) && !!s.id)))) continue;
    const order = build.steps.length + steps.length + 1;
    steps.push({
      order,
      kind: "site-list",
      key: `${ASKED_KEY}${order}`,
      name: a.listName,
      method: "POST",
      path: "/web-filters/v1/site-lists",
      summary: "Narrow Allow entries from the pilot digest",
      body: {},
      status: "unconfirmed",
      ...(a.answer ? { answer: a.answer } : {}),
      readBack: "not-read",
      readBackNote: (a.readBack ?? "").replace(/^not read: /, ""),
    });
  }
  const asked = steps.length || build.steps.some((s) => s.key.startsWith(ASKED_KEY) && s.status === "unconfirmed");
  return { steps, recorded: asked ? await recordedListIds(dataDir, tenantId, record) : new Set() };
}

/**
 * After a rollback of the build looked for those lists by name: an entry whose list it found and deleted, or found
 * nothing for, is undone, saying which. One whose list it found but didn't confirm deleted holds the list (partial), so
 * Undo deletes it, as the next rollback does. One it couldn't look for stays unconfirmed.
 */
export async function settleAllowLists(dataDir: string, tenantId: string, build: BuildRecord): Promise<void> {
  const record = await loadPilotRecord(dataDir, tenantId);
  let changed = false;
  for (const a of record.allows) {
    if (a.status !== "unconfirmed" || a.listId || a.buildId !== build.id) continue;
    // The latest step for its list name: the one this rollback looked for.
    const s = [...build.steps].reverse().find((x) => x.key.startsWith(ASKED_KEY) && x.name.toLowerCase() === a.listName.toLowerCase());
    if (!s || s.status === "unconfirmed") continue;
    changed = true;
    if (s.id) {
      a.listId = s.id;
      a.createdList = true;
    }
    if (s.status === "deleted" || s.status === "not-found") {
      a.status = "undone";
      a.undoneAt = new Date().toISOString();
      a.undo = s.status === "deleted" ? [FOUND_LIST, "List deleted with the build, 404 on read-back."] : [NOTHING_TO_REMOVE];
    } else {
      a.status = "partial";
      a.error = "The rollback found the list by name, but didn't confirm it deleted. Undo, or roll the build back again.";
    }
  }
  if (changed) await savePilotRecord(dataDir, record);
}
