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
 * build back deletes it too.
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
import { auditedWrite } from "./audit-log.js";
import { auditedCreate, getBuild, listBuilds, saveRecord, type BuildRecord } from "./build-service.js";
import { readBack } from "./write-check.js";
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
}

/** The newest build whose pilot policy and profile still exist by this tool's record. */
export async function activePilot(dataDir: string, tenantId: string): Promise<PilotInfo | null> {
  for (const b of await listBuilds(dataDir, tenantId)) {
    if (!["built", "partial", "rollback-partial"].includes(b.status)) continue;
    const policy = b.steps.find((s) => s.kind === "policy" && s.id && s.status === "created");
    const profile = b.steps.find((s) => s.kind === "profile" && s.id && s.status === "created");
    if (!policy || !profile) continue;
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
    };
  }
  return null;
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
  status: "added" | "failed" | "undone" | "undo-failed";
  readBack?: string;
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

export async function loadPilotRecord(dataDir: string, tenantId: string): Promise<PilotRecord> {
  const text = await readText(recordPath(dataDir, tenantId), SECTION).catch(() => null);
  return text ? (JSON.parse(text) as PilotRecord) : { tenantId, allows: [] };
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
  const site = narrowAllow(host);
  const plan: AllowPlan = { pilot, host, site, steps: [], problems: [], notes: [] };
  if (!site) {
    plan.problems.push(`"${host}" isn't a single host a site list can allow narrowly.`);
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
  const policy = await getPolicy(ro, t, pilot.policyId).catch(() => null);
  if (policy?.type === "web-control" && policy.appliesTo?.endpoints?.length) {
    const servers = (await listAllEndpoints(ro, t)).filter((d) => policy.appliesTo!.endpoints!.includes(d.id) && deviceEligibility(d).kind === "server");
    if (servers.length) plan.notes.push(`The pilot is assigned to ${servers.length === 1 ? "a server" : "servers"} (${servers.map((d) => deviceEligibility(d).hostname).join(", ")}), which a Web Control policy doesn't apply to. Remove ${servers.length === 1 ? "it" : "them"} in Sophos Fusion; the tool won't add servers.`);
  }
  const broad = broadness(parseSite(site));
  if (broad.broad) plan.notes.push(`${site} ${broad.why ? `${broad.why}` : `is broad (${broad.reason})`}: an Allow lets through more than one organization's sites.`);
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
    if (lists.some((l) => l.name.toLowerCase() === name.toLowerCase())) plan.problems.push(`A site list named "${name}" already exists but isn't this pilot's; rename it first.`);
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
        const res = await auditedWrite({ tenantId: t }, "add-site", "site-list", step.listId, () => addSite(api, t, step.listId, site), { site, pilotBuild: plan.pilot.buildId });
        const back = await readBack(async () => (await listSites(ro, t, step.listId)).find((s) => s.site.toLowerCase() === site) ?? null);
        entry.siteId = back.value?.id ?? res?.id;
        entry.readBack = back.value ? "site listed" : back.unread ? `not read: ${back.unread}` : "not found";
      } else if (step.op === "create-list") {
        const body = { name: step.name, description: "Narrow Allow entries added from the pilot digest (Web Profiles Assistant, unofficial).", sites: [site] };
        const { value } = await auditedCreate(
          t,
          "site-list",
          () => createSiteList(api, t, body),
          async () => (await listSiteLists(ro, t)).find((l) => l.name === body.name) ?? null,
          "the pilot allows list",
          { where: "the tenant's site lists", found: `no site list named "${body.name}"` },
          { name: body.name, sites: 1, pilotBuild: plan.pilot.buildId },
        );
        entry.listId = value.id;
        entry.listName = step.name;
        entry.createdList = true;
        const back = await getSiteList(ro, t, value.id);
        entry.readBack = (back.sites ?? []).map((s) => s.toLowerCase()).includes(site) ? "list holds the site" : "list read back without the site";
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
        await auditedWrite({ tenantId: t }, "update", "profile", step.profileId, () => replaceProfile(api, t, step.profileId, body), { linkList: entry.listId, action: "allow", priority: step.priority });
        const back = await readBack(async () => {
          const p = await getProfile(ro, t, step.profileId);
          return (p.siteListActions ?? []).some((a) => a.id === entry.listId && a.action === "allow" && a.priority === step.priority) ? p : null;
        });
        entry.readBack = `${entry.readBack}; ${back.value ? "profile links it as allow" : "profile read back without the link"}`;
      }
    }
    entry.status = "added";
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
  }
  await savePilotRecord(dataDir, record);
  if (entry.status === "failed") throw new Error(`The Allow entry wasn't completed: ${entry.error}`);
  return { plan, entry };
}

/** Undoes one Allow entry. The last entry in a list this tool made takes the list with it. */
export async function undoAllow(dataDir: string, ctx: TenantContext, allowId: string): Promise<AllowEntry> {
  const t = ctx.tenantId;
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  const record = await loadPilotRecord(dataDir, t);
  const entry = record.allows.find((a) => a.id === allowId);
  if (!entry) throw new Error("No such Allow entry.");
  if (!["added", "undo-failed"].includes(entry.status) || !entry.listId) throw new Error(`This entry is ${entry.status}; there's nothing to undo.`);
  const listId = entry.listId;
  const notes: string[] = [];
  try {
    const sites = await listSites(ro, t, listId);
    const ownsList = record.allows.some((a) => a.listId === listId && a.createdList);
    const others = record.allows.filter((a) => a.listId === listId && a.status === "added" && a.id !== entry.id);
    if (ownsList && others.length === 0 && sites.every((s) => s.site.toLowerCase() === entry.site)) {
      // Unlink, then delete the list (the API refuses to delete a list in use).
      const creator = record.allows.find((a) => a.listId === listId && a.createdList)!;
      const p = await getProfile(ro, t, entry.profileId).catch((err) => (errorStatus(err) === 404 ? null : Promise.reject(err)));
      if (p && (p.siteListActions ?? []).some((a) => a.id === listId)) {
        const body = profilePutBody(p);
        body.siteListActions = (p.siteListActions ?? []).filter((a) => a.id !== listId);
        body.filterBySiteList = (body.siteListActions as unknown[]).length ? true : creator.profileBefore?.filterBySiteList ?? false;
        await auditedWrite({ tenantId: t }, "update", "profile", entry.profileId, () => replaceProfile(api, t, entry.profileId, body), { unlinkList: listId, undo: entry.id });
        const back = await readBack(async () => {
          const q = await getProfile(ro, t, entry.profileId);
          return (q.siteListActions ?? []).some((a) => a.id === listId) ? null : q;
        });
        notes.push(back.value ? "Profile read back without the list." : "Profile still shows the list.");
      }
      await auditedWrite({ tenantId: t }, "delete", "site-list", listId, () => deleteSiteList(api, t, listId), { name: entry.listName, undo: entry.id });
      const gone = await readBack(async () => {
        try {
          await getSiteList(ro, t, listId);
          return null;
        } catch (err) {
          return errorStatus(err) === 404 ? true : null;
        }
      });
      notes.push(gone.value ? "List deleted, 404 on read-back." : "List still there after delete.");
      const build = await getBuild(dataDir, t, entry.buildId).catch(() => null);
      const step = build?.steps.find((s) => s.id === listId);
      if (build && step) {
        step.status = gone.value ? "deleted" : "delete-failed";
        await saveRecord(dataDir, build);
      }
      if (!gone.value) throw new Error(notes.join(" "));
    } else {
      const siteId = entry.siteId ?? sites.find((s) => s.site.toLowerCase() === entry.site)?.id;
      if (!siteId) throw new Error(`${entry.site} isn't in the list any more.`);
      await auditedWrite({ tenantId: t }, "delete-site", "site-list", listId, () => deleteSite(api, t, listId, siteId), { site: entry.site, undo: entry.id });
      const back = await readBack(async () => ((await listSites(ro, t, listId)).some((s) => s.site.toLowerCase() === entry.site) ? null : true));
      notes.push(back.value ? "Site removed, confirmed on read-back." : "Site still listed after delete.");
      if (!back.value) throw new Error(notes.join(" "));
    }
    entry.status = "undone";
    entry.undoneAt = new Date().toISOString();
  } catch (err) {
    entry.status = "undo-failed";
    entry.error = err instanceof Error ? err.message : String(err);
  }
  entry.undo = notes;
  await savePilotRecord(dataDir, record);
  return entry;
}
