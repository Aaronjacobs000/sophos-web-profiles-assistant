/**
 * The build step and its rollback.
 *
 *   plan      site lists, then profiles, then the pilot policy at the top of
 *             the order, with the profile in it, logging on and Recommended
 *             file types, assigned through appliesTo when targets are chosen.
 *   dry run   checks the plan against the tenant as it is now: limits, names
 *             already taken, the coverage rule, targets that exist. Writes
 *             nothing.
 *   execute   saves a rollback snapshot first, then sends each write once,
 *             reads it back, and audits it. A build record keeps every id.
 *             A create Sophos gave no clear answer to, with nothing read
 *             after to look for it, is kept as unconfirmed; the next dry
 *             run looks for it by name, and the build uses it if it's there.
 *             So is a create still in flight when the server stopped: each
 *             step is marked as sending, and saved, before its create goes.
 *   rollback  deletes what the build created in reverse order (policy, then
 *             profiles, then site lists; the API refuses to delete a profile
 *             or list still in use), verifies each 404, and puts Website
 *             Management back from the snapshot. A delete with no clear
 *             answer (a 5xx, no answer in time, or a dropped connection)
 *             is read back too, since it can still go through, and audited
 *             with what the read-back found. So is a delete answered 404,
 *             which was already gone, so its entry matches the step.
 *             An unconfirmed step has no id, so the rollback first looks
 *             for it by name, as the next build does: found, it's deleted
 *             by that id; not there, there's nothing to remove; not read,
 *             the rollback isn't confirmed. So is an Allow's new list.
 *
 * Deletes go only to ids this tool recorded, or found by name for a create
 * Sophos didn't confirm that no record has the id of; never by name alone:
 * other tools can share a tenant.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../sophos/tenant-context.js";
import { ReadOnlyApi, errorStatus, type TenantApi } from "../sophos/api/requester.js";
import {
  createProfile,
  createSiteList,
  deleteProfile,
  deleteSiteList,
  getProfile,
  getSiteList,
  listProfiles,
  listSiteLists,
  listSites,
  getProfileMetadata,
} from "../sophos/api/web-filters.js";
import { createPolicy, deletePolicy, getPolicy, listPolicies, patchPolicy, type Policy } from "../sophos/api/policies.js";
import { createLocalSite, deleteLocalSite, getLocalSite, listLocalSites, patchLocalSite } from "../sophos/api/web-control.js";
import { findUsers, listEndpointGroups, listUserGroups } from "../sophos/api/directory.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import { catalogFrom, expand, expandPreset, type Catalog } from "../domain/categories.js";
import {
  buildDesign,
  checkProfileBody,
  pilotPolicyBody,
  PROFILE_LIMIT,
  SITE_LIST_LIMIT,
  type DesignPlan,
  type PilotTargets,
} from "../domain/design.js";
import { deviceEligibility } from "../domain/eligibility.js";
import { DESCRIPTION_MAX, NAME_MAX } from "../domain/cleanup.js";
import { readOnlyMode } from "../sophos/read-only-guard.js";
import { compareToSnapshot, planWebsiteManagementRestore, type RestoreStep } from "../domain/restore.js";
import { buildSnapshot, canonicalJson, type Snapshot } from "../domain/snapshot.js";
import { readInventory } from "./inventory-reader.js";
import { auditedWrite, auditOrWarn } from "./audit-log.js";
import { UnreadAfterWriteError, createChecked, foundNote, isUnclearWrite, readBack, sendChecked, takenNameAdvice, unreadCreateFrom, type ReadBackMiss, type UnclearWriteError } from "./write-check.js";
import { loadSnapshot } from "./snapshot-store.js";
import { runReadiness } from "./readiness.js";
import { readText, saveFile } from "./safe-files.js";
import { getRun, withDecisions } from "./cleanup-service.js";
import { log } from "../log.js";
import type { InventoryTenant } from "../domain/inventory.js";

const SECTION = "build";

export interface PilotOptions {
  profileKey: string;
  name?: string;
  enabled: boolean;
  targets: PilotTargets;
}

export type StepKind = "site-list" | "profile" | "policy";

export interface BuildStep {
  order: number;
  kind: StepKind;
  key: string;
  name: string;
  method: "POST";
  path: string;
  summary: string;
  body: Record<string, unknown>;
  /**
   * unconfirmed: Sophos didn't answer the create with a success (a 5xx, no answer in time or a dropped connection), and
   * the tenant couldn't be read to look for it by name after, so it may have been made; or the server stopped while it
   * was in flight (sending). There's no id; answer says what Sophos said, and readBackNote why nothing was read. The
   * next build looks for it by name first (found), and so does a rollback. not-found: an unconfirmed step a rollback
   * looked for by name and didn't find, so there was nothing to remove.
   */
  status: "planned" | "created" | "unconfirmed" | "failed" | "skipped" | "deleted" | "delete-failed" | "not-found";
  id?: string;
  /** Set on an unconfirmed step: what Sophos said to its create. */
  answer?: string;
  /**
   * Set, and saved, just before the step's create is sent, and cleared once its outcome is recorded. A step saved with
   * it and still planned was in flight when the server stopped, so it may have been made: it's read as unconfirmed.
   */
  sending?: boolean;
  /**
   * Set by a dry run on a step whose name is taken by an object an earlier build's unconfirmed step of the same kind and
   * name asked for, which no build has an id for: its id, and that build. The build uses it rather than making another.
   */
  found?: { id: string; build: string };
  /** What the read-back after the create found; readBackNote says how it differed, or why it couldn't be read. */
  readBack?: "matches" | "differs" | "not-read";
  readBackNote?: string;
  /**
   * Set on a delete-failed step when Sophos accepted the rollback's delete, or an Allow undo's delete of the pilot allows
   * list (or gave no clear answer and nothing could be read), but the read-back didn't confirm it gone: "still there",
   * or "not read: " and why.
   */
  deleteReadBack?: string;
  /**
   * Set with deleteReadBack when Sophos didn't answer that delete with a success (a 5xx, a 404, no answer in time or a
   * dropped connection): what it said. Without it, Sophos accepted the delete.
   */
  deleteAnswer?: string;
  /**
   * Set on a delete-failed step when an Allow undo's delete of the pilot allows list got no success from Sophos and a
   * read-back still found the list: what Sophos said and what was read, for the Detail line. A rollback clears it, and
   * keeps its own in rollback.
   */
  deleteError?: string;
  error?: string;
  note?: string;
  /** For a profile: its site lists by plan key, filled with real ids at build time. */
  listActions?: Array<{ listKey: string; action: "allow" | "block" | "warn"; priority: number }>;
}

export interface Check {
  ok: boolean;
  level: "ok" | "warn" | "fail";
  /** Plain words; what Sophos or the tool answered goes in detail, which the page shows on its own line. */
  text: string;
  detail?: string;
}

export interface BuildRecord {
  id: string;
  tenantId: string;
  tenantName: string;
  createdAt: string;
  finishedAt?: string;
  status: "dry-run" | "built" | "partial" | "failed" | "rolled-back" | "rollback-partial";
  snapshotFile?: string;
  pilot: PilotOptions & { name: string };
  steps: BuildStep[];
  checks: Check[];
  /**
   * answer is set on a Website Management step Sophos didn't answer with a success (a 5xx, no answer in time or a
   * dropped connection) that nothing could be read back after: what it said. lookedUp is set on an unconfirmed step the
   * rollback looked for by name: "found" (then deleted by its id, as status says), "not found" (status "not there") or
   * "not read" (status "not confirmed", and why in error).
   */
  rollback?: { at: string; steps: Array<{ kind: StepKind | "website-management"; name: string; id?: string; status: string; error?: string; answer?: string; lookedUp?: "found" | "not found" | "not read" }> };
}

const PATHS: Record<StepKind, string> = {
  "site-list": "/web-filters/v1/site-lists",
  profile: "/web-filters/v1/profiles",
  policy: "/endpoint/v1/policies",
};

function buildsDir(dataDir: string, tenantId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(tenantId)) throw new Error("Not a tenant ID.");
  return path.join(dataDir, "builds", tenantId);
}

export async function saveRecord(dataDir: string, record: BuildRecord): Promise<void> {
  const dir = buildsDir(dataDir, record.tenantId);
  await fs.mkdir(dir, { recursive: true });
  await saveFile(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), { section: SECTION, mode: 0o600 });
}

export async function listBuilds(dataDir: string, tenantId: string): Promise<BuildRecord[]> {
  const dir = buildsDir(dataDir, tenantId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: BuildRecord[] = [];
  for (const n of names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))) {
    const text = await readText(path.join(dir, n), SECTION);
    if (text) out.push(asRead(JSON.parse(text) as BuildRecord));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBuild(dataDir: string, tenantId: string, id: string): Promise<BuildRecord> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Not a build ID.");
  const text = await readText(path.join(buildsDir(dataDir, tenantId), `${id}.json`), SECTION);
  if (!text) throw new Error("No such build.");
  return asRead(JSON.parse(text) as BuildRecord);
}

/** What each kind's name lookup reads, in the words a create's error uses. */
const LOOKUP_WHERE: Record<StepKind, string> = { "site-list": "the tenant's site lists", profile: "the tenant's profiles", policy: "the tenant's Web Control policies" };

/** What an unconfirmed step that was in flight when the server stopped says Sophos answered, and why nothing was read. */
const IN_FLIGHT = { answer: "The tool stopped before it saved what Sophos answered", unread: "none was saved" };

/**
 * A build record as saved, read the way v0.3.25 sees it. Before v0.3.24 a create Sophos didn't answer with a success,
 * whose name lookup couldn't be read after, was saved as failed with no id: it's unconfirmed, with what Sophos said and
 * why nothing was read, so the next build and a rollback look for it by name, and the build it stopped didn't fail.
 * Before v0.3.25 a rollback skipped an unconfirmed step: a build with one left isn't rolled back, so it can be again.
 * A step whose create was in flight when the server stopped (sending) is unconfirmed too: Sophos may have made it.
 * The file isn't changed.
 */
function asRead(r: BuildRecord): BuildRecord {
  for (const s of r.steps) {
    if (s.status === "planned" && s.sending && !s.id) {
      s.status = "unconfirmed";
      s.answer = IN_FLIGHT.answer;
      s.readBack = "not-read";
      s.readBackNote = IN_FLIGHT.unread;
      delete s.sending;
      continue;
    }
    const was = s.status === "failed" && !s.id ? unreadCreateFrom(s.error, LOOKUP_WHERE[s.kind]) : null;
    if (!was) continue;
    s.status = "unconfirmed";
    s.answer = was.answer;
    s.readBack = "not-read";
    s.readBackNote = was.unread;
    delete s.error;
    if (r.status === "failed") r.status = "partial";
  }
  if (r.status === "rolled-back" && r.steps.some((s) => s.status === "unconfirmed" && !s.id)) r.status = "rollback-partial";
  return r;
}

/** Why a server can't go on the pilot: it's a Web Control policy, which applies to computers. */
export function serverRefusal(names: string[], kind: "device" | "device group"): string {
  const list = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
  return `${list} ${names.length === 1 ? `is a server ${kind}` : `are server ${kind}s`}. The pilot is a Web Control policy, which applies to computers; servers need a server Web Control policy. The API accepts the assignment anyway, so the tool refuses it before the write.`;
}

function many(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Reads what the design needs and builds it, using the tenant's clean-up results when there are any. */
export async function designFor(dataDir: string, ctx: TenantContext, genAi?: Record<string, "allow" | "block" | "warn">): Promise<{ design: DesignPlan; catalog: Catalog }> {
  const api = new ReadOnlyApi(ctx.client);
  const t = ctx.tenantId;
  const [localSites, wc, swc, metadata, profiles, lists] = await Promise.all([
    listLocalSites(api, t),
    listPolicies(api, t, "web-control"),
    listPolicies(api, t, "server-web-control"),
    getProfileMetadata(api, t).catch(() => null),
    listProfiles(api, t),
    listSiteLists(api, t),
  ]);
  const catalog = catalogFrom(metadata);
  const run = await getRun(dataDir, t);
  const cleanup = run && !run.running && run.results.length ? withDecisions(run) : null;
  const design = buildDesign(catalog, [...wc, ...swc], localSites, cleanup, {
    date: today(),
    existingProfiles: profiles.length,
    existingSiteLists: lists.length,
    genAi,
  });
  return { design, catalog };
}

function planSteps(design: DesignPlan, pilot: PilotOptions & { name: string }): BuildStep[] {
  const steps: BuildStep[] = [];
  let order = 1;
  const profile = design.profiles.find((p) => p.key === pilot.profileKey);
  if (!profile) throw new Error("Choose a profile for the pilot policy.");
  const neededLists = new Set(profile.siteLists.map((l) => l.listKey));
  for (const l of design.siteLists.filter((x) => neededLists.has(x.key))) {
    steps.push({
      order: order++,
      kind: "site-list",
      key: l.key,
      name: l.name,
      method: "POST",
      path: PATHS["site-list"],
      summary: `${l.sites.length} ${l.sites.length === 1 ? "site" : "sites"}, ${l.action}`,
      body: { name: l.name, description: l.description, sites: l.sites },
      status: "planned",
    });
  }
  steps.push({
    order: order++,
    kind: "profile",
    key: profile.key,
    name: profile.name,
    method: "POST",
    path: PATHS.profile,
    summary: `${profile.mode === "preset" ? `Preset ${profile.preset}` : profile.mode === "custom" ? "Custom categories" : "Site lists only"}, ${profile.siteLists.length} site ${profile.siteLists.length === 1 ? "list" : "lists"}`,
    body: profile.body,
    listActions: profile.siteLists,
    status: "planned",
  });
  const t = pilot.targets;
  const count = (t.users?.length ?? 0) + (t.userGroups?.length ?? 0) + (t.endpoints?.length ?? 0) + (t.endpointGroups?.length ?? 0);
  steps.push({
    order: order++,
    kind: "policy",
    key: "pilot",
    name: pilot.name,
    method: "POST",
    path: PATHS.policy,
    summary: `Web Control, top of the order, ${pilot.enabled ? "enabled" : "disabled"}, logging on, Recommended file types, ${count ? `assigned to ${count} ${t.endpoints?.length || t.endpointGroups?.length ? "device" : "user"} ${count === 1 ? "target" : "targets"}` : "not assigned"}`,
    body: pilotPolicyBody(pilot.name, "<profile id>", pilot.targets, pilot.enabled),
    status: "planned",
  });
  return steps;
}

/** Plans the build and checks it against the tenant as it is now. Writes nothing. */
export async function dryRun(dataDir: string, ctx: TenantContext, pilotIn: PilotOptions): Promise<BuildRecord> {
  const { design, catalog } = await designFor(dataDir, ctx);
  const profile = design.profiles.find((p) => p.key === pilotIn.profileKey);
  const pilot = { ...pilotIn, name: (pilotIn.name?.trim() || `WF pilot: ${profile?.name ?? "profile"}`).slice(0, 100) };
  const steps = planSteps(design, pilot);
  const api = new ReadOnlyApi(ctx.client);
  const t = ctx.tenantId;
  const checks: Check[] = [];
  const [profiles, lists, policies] = await Promise.all([listProfiles(api, t), listSiteLists(api, t), listPolicies(api, t, "web-control")]);

  // An earlier build's create that Sophos didn't confirm, with nothing read after to look for it, may have been made:
  // a step of the same kind and name uses what's in the tenant by that name, when no build has its id.
  const asked = (await listBuilds(dataDir, t)).flatMap((b) => b.steps.filter((s) => s.status === "unconfirmed" && !s.id).map((s) => ({ kind: s.kind, name: s.name.toLowerCase(), build: b.id })));
  const recorded = asked.length ? await idsCreatedByTool(dataDir, t) : new Set<string>();
  const inTenant: Record<StepKind, Array<{ id: string; name: string }>> = { "site-list": lists, profile: profiles, policy: policies };
  for (const s of steps) {
    const by = asked.find((a) => a.kind === s.kind && a.name === s.name.toLowerCase());
    const there = by && foundByName(inTenant[s.kind], s.name, recorded);
    if (!by || !there) continue;
    s.found = { id: there.id, build: by.build };
    s.note = FOUND_NOTE;
  }

  const newLists = steps.filter((s) => s.kind === "site-list" && !s.found).length;
  const newProfiles = steps.some((s) => s.kind === "profile" && s.found) ? 0 : 1;
  checks.push(
    profiles.length + newProfiles <= PROFILE_LIMIT
      ? { ok: true, level: "ok", text: `Profiles: ${profiles.length} in the account, ${newProfiles} to add, limit ${PROFILE_LIMIT}.` }
      : { ok: false, level: "fail", text: `No room for another profile: ${profiles.length} of ${PROFILE_LIMIT} used.` },
  );
  checks.push(
    lists.length + newLists <= SITE_LIST_LIMIT
      ? { ok: true, level: "ok", text: `Site lists: ${lists.length} in the account, ${newLists} to add, limit ${SITE_LIST_LIMIT}.` }
      : { ok: false, level: "fail", text: `Not enough room for ${newLists} site lists: ${lists.length} of ${SITE_LIST_LIMIT} used.` },
  );
  const takenLists = new Set(lists.map((l) => l.name.toLowerCase()));
  const takenProfiles = new Set(profiles.map((p) => p.name.toLowerCase()));
  const takenPolicies = new Set(policies.map((p) => p.name.toLowerCase()));
  for (const s of steps) {
    const taken = s.kind === "site-list" ? takenLists : s.kind === "profile" ? takenProfiles : takenPolicies;
    if (s.found) checks.push({ ok: true, level: "warn", text: `The ${s.kind.replace("-", " ")} "${s.name}" is in the tenant. An earlier build asked for it and Sophos didn't confirm it was made, so this build uses it rather than making another.` });
    else if (taken.has(s.name.toLowerCase())) checks.push({ ok: false, level: "fail", text: `A ${s.kind.replace("-", " ")} named "${s.name}" already exists. Rename or remove it first.` });
    const max = s.kind === "policy" ? 100 : NAME_MAX;
    if (s.name.length > max) checks.push({ ok: false, level: "fail", text: `The ${s.kind.replace("-", " ")} name "${s.name}" is ${s.name.length} characters; the API takes ${max}.` });
    const desc = typeof s.body.description === "string" ? s.body.description : "";
    if (desc.length > DESCRIPTION_MAX) checks.push({ ok: false, level: "fail", text: `The description of "${s.name}" is ${desc.length} characters; the API takes ${DESCRIPTION_MAX}.` });
    if (s.kind === "site-list") {
      const sites = (s.body.sites as string[]) ?? [];
      if (sites.length === 0) checks.push({ ok: false, level: "fail", text: `Site list "${s.name}" has no sites; the API needs at least one.` });
      if (sites.length > 750) checks.push({ ok: false, level: "fail", text: `Site list "${s.name}" has ${sites.length} sites; the limit is 750.` });
    }
    if (s.kind === "profile") {
      for (const p of checkProfileBody(catalog, s.body)) checks.push({ ok: false, level: "fail", text: `Profile "${s.name}": ${p}` });
    }
  }
  // Targets exist and devices can use profiles.
  const tg = pilot.targets;
  try {
    if (tg.users?.length) {
      const found = new Set((await findUsers(api, t, tg.users)).map((u) => u.id));
      const missing = tg.users.filter((id) => !found.has(id));
      checks.push(missing.length ? { ok: false, level: "fail", text: `${missing.length} chosen users don't exist.` } : { ok: true, level: "ok", text: `${many(tg.users.length, "user")} found.` });
    }
    if (tg.userGroups?.length) {
      const groups = new Set((await listUserGroups(api, t)).map((g) => g.id));
      const missing = tg.userGroups.filter((id) => !groups.has(id));
      checks.push(missing.length ? { ok: false, level: "fail", text: `${missing.length} chosen user groups don't exist.` } : { ok: true, level: "ok", text: `${many(tg.userGroups.length, "user group")} found.` });
    }
    if (tg.endpointGroups?.length) {
      const all = await listEndpointGroups(api, t);
      const groups = new Set(all.map((g) => g.id));
      const missing = tg.endpointGroups.filter((id) => !groups.has(id));
      // The API accepts a server group on a computer policy (retested 13/10/2026), so the tool refuses it.
      const serverGroups = all.filter((g) => tg.endpointGroups!.includes(g.id) && g.type === "server");
      if (serverGroups.length) checks.push({ ok: false, level: "fail", text: serverRefusal(serverGroups.map((g) => g.name), "device group") });
      checks.push(missing.length ? { ok: false, level: "fail", text: `${missing.length} chosen device groups don't exist.` } : { ok: true, level: "ok", text: `${many(tg.endpointGroups.length, "device group")} found; sent with an empty endpoints list, the shape the API accepts.` });
    }
    if (tg.endpoints?.length) {
      const devices = new Map((await listAllEndpoints(api, t)).map((d) => [d.id, d]));
      const missing = tg.endpoints.filter((id) => !devices.has(id));
      const servers = tg.endpoints.filter((id) => devices.has(id) && deviceEligibility(devices.get(id)!).kind === "server");
      if (servers.length) checks.push({ ok: false, level: "fail", text: serverRefusal(servers.map((id) => deviceEligibility(devices.get(id)!).hostname), "device") });
      const old = tg.endpoints.filter((id) => devices.has(id) && !servers.includes(id) && !deviceEligibility(devices.get(id)!).eligible);
      checks.push(missing.length ? { ok: false, level: "fail", text: `${missing.length} chosen devices don't exist.` } : { ok: true, level: "ok", text: `${many(tg.endpoints.length, "device")} found.` });
      if (old.length) checks.push({ ok: true, level: "warn", text: `${old.length} chosen devices can't use profiles yet (not Windows on 2026.1 or later); they fall back to the next policy.` });
    }
  } catch (err) {
    checks.push({ ok: false, level: "fail", text: "Couldn't check the targets.", detail: err instanceof Error ? err.message : String(err) });
  }
  if (!(tg.users?.length || tg.userGroups?.length || tg.endpoints?.length || tg.endpointGroups?.length)) {
    checks.push({ ok: true, level: "warn", text: "No pilot targets chosen: the policy is created unassigned. Assign it here later or in Sophos Fusion." });
  }
  if (!design.cleanedUp) checks.push({ ok: true, level: "warn", text: "The clean-up step hasn't run, so the site lists hold every entry the policy uses." });
  for (const w of design.warnings) checks.push({ ok: true, level: "warn", text: w });
  checks.push(
    readOnlyMode()
      ? { ok: true, level: "warn", text: "Read-only mode is on (READ_ONLY=1): this dry run reads only, and Create would be refused before anything is sent." }
      : { ok: true, level: "ok", text: "Write access is confirmed by the first create; a refusal stops the build before anything else is sent." },
  );

  return {
    id: randomUUID(),
    tenantId: t,
    tenantName: ctx.summary.displayName,
    createdAt: new Date().toISOString(),
    status: "dry-run",
    pilot,
    steps,
    checks,
  };
}

/** The note on a step the dry run found by name (see BuildStep.found). */
const FOUND_NOTE = "Found by name: an earlier build asked for it and Sophos didn't confirm it, so it's used, not made again.";

/**
 * What a create Sophos didn't confirm (unconfirmed, no id) asked for, found by name in what was read of the tenant: the
 * object of that name, in any case, unless a record has its id, since then it's another run's. The next build, Allow
 * and Create site lists use it; a rollback or an undo deletes it by that id.
 */
export function foundByName<T extends { id: string; name: string }>(inTenant: T[], name: string, recorded: ReadonlySet<string | undefined>): T | undefined {
  const there = inTenant.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return there && !recorded.has(there.id) ? there : undefined;
}

/** What each kind's lookup by name reads, as the next build reads it. */
const READ_ALL: Record<StepKind, (api: ReadOnlyApi, t: string) => Promise<Array<{ id: string; name: string }>>> = {
  "site-list": (api, t) => listSiteLists(api, t),
  profile: (api, t) => listProfiles(api, t),
  policy: (api, t) => listPolicies(api, t, "web-control"),
};

/**
 * Looks for what an unconfirmed create asked for by name, for a rollback or an undo (foundByName): found, with its id;
 * not there (found undefined); or, when the tenant couldn't be read, why (unread), since that shows neither.
 */
export async function lookUpByName(api: TenantApi, tenantId: string, kind: StepKind, name: string, recorded: ReadonlySet<string | undefined>): Promise<{ found?: { id: string; name: string }; unread?: string }> {
  try {
    return { found: foundByName(await READ_ALL[kind](new ReadOnlyApi(api), tenantId), name, recorded) };
  } catch (err) {
    return { unread: err instanceof Error ? err.message : String(err) };
  }
}

/** What a rollback or an undo couldn't look for by name: the reason it gives, for a Detail line. */
export function unreadLookUp(kind: StepKind, why: string): string {
  const what = { "site-list": "site lists", profile: "profiles", policy: "Web Control policies" }[kind];
  return `The tool couldn't read the tenant's ${what} to look for it by name (${why.replace(/\.$/, "")}), so it may be in the tenant.`;
}

/** A create that is sent once, read back by name when Sophos gives no clear answer (then kept in unclear), and audited with the id it made. */
export async function auditedCreate<T extends { id: string }>(
  tenantId: string,
  resource: string,
  create: () => Promise<T>,
  find: () => Promise<T | null>,
  what: string,
  miss: ReadBackMiss,
  detail: Record<string, unknown>,
): Promise<{ value: T; note?: string; unclear?: UnclearWriteError }> {
  try {
    const r = await createChecked(create, find, what, miss);
    await auditOrWarn({ tenantId, action: "create", resource, resourceId: r.value.id, ok: true, detail: { ...detail, ...(r.note ? { note: r.note } : {}) } });
    return r;
  } catch (err) {
    await auditOrWarn({ tenantId, action: "create", resource, ok: false, error: err instanceof Error ? err.message : String(err), detail });
    throw err;
  }
}

/** The same sites, whatever the order, case or repeats. */
export function sameSites(sent: string[], got: string[]): boolean {
  const norm = (xs: string[]) => [...new Set(xs.map((s) => s.trim().toLowerCase()))].sort();
  return canonicalJson(norm(sent)) === canonicalJson(norm(got));
}

/** Runs the plan. Refuses when the dry run found a failure. */
export async function execute(
  dataDir: string,
  ctx: TenantContext,
  pilotIn: PilotOptions,
  tool: { name: string; version: string },
): Promise<BuildRecord> {
  const record = await dryRun(dataDir, ctx, pilotIn);
  if (record.checks.some((c) => !c.ok)) {
    record.status = "failed";
    return record;
  }
  const api: TenantApi = ctx.client;
  const t = ctx.tenantId;
  const tenant: InventoryTenant = { id: t, name: ctx.summary.displayName, region: ctx.summary.region, apiHost: ctx.summary.apiHost, credentialType: ctx.summary.credentialType };
  const { catalog } = await designFor(dataDir, ctx);

  // Rollback snapshot first.
  const readiness = await runReadiness(dataDir, ctx.client, tenant, tool, { parallel: 3 });
  record.snapshotFile = readiness.snapshot?.file;
  if (!record.snapshotFile) {
    record.status = "failed";
    record.checks.push({ ok: false, level: "fail", text: "No rollback snapshot could be saved, so nothing was built.", ...(readiness.snapshotError ? { detail: readiness.snapshotError } : {}) });
    await saveRecord(dataDir, record);
    return record;
  }
  record.status = "partial";
  await saveRecord(dataDir, record);

  const listIds: Record<string, string> = {};
  let profileId: string | null = null;
  /** A step the dry run found by name: no create is sent, and the audit log says it was used. Its note stays. */
  const use = async (step: BuildStep & { found: NonNullable<BuildStep["found"]> }): Promise<{ value: { id: string }; note?: string }> => {
    await auditOrWarn({ tenantId: t, action: "reuse", resource: step.kind, resourceId: step.found.id, ok: true, detail: { name: step.name, buildId: record.id, askedBy: step.found.build, note: FOUND_NOTE } });
    return { value: { id: step.found.id }, note: step.note };
  };
  /** Marks a create about to be sent, and saves the record before it goes, so a server that stops before its outcome is recorded leaves it as sent (asRead). */
  const sending = async (step: BuildStep): Promise<void> => {
    if (step.found) return;
    step.sending = true;
    await saveRecord(dataDir, record);
  };
  try {
    for (const step of record.steps) {
      if (step.kind === "site-list") {
        const body = step.body as { name: string; description?: string; sites: string[] };
        await sending(step);
        const { value, note } = step.found
          ? await use({ ...step, found: step.found })
          : await auditedCreate(
              t,
              "site-list",
              () => createSiteList(api, t, body),
              async () => (await listSiteLists(new ReadOnlyApi(api), t)).find((l) => l.name === body.name) ?? null,
              "the site list",
              { where: "the tenant's site lists", found: `no site list named "${body.name}"`, advice: takenNameAdvice(`the site list "${body.name}"`, "a rollback", "build again") },
              { name: body.name, sites: body.sites.length, buildId: record.id },
            );
        step.id = value.id;
        step.note = note;
        listIds[step.key] = value.id;
        step.status = "created";
        // Made: a read-back that fails leaves the step unconfirmed, and the build goes on with its id.
        const read = await readOnce(async () => {
          const back = await getSiteList(new ReadOnlyApi(api), t, value.id);
          return { name: back.name, sites: back.sites ?? (await listSites(new ReadOnlyApi(api), t, value.id)).map((s) => s.site) };
        });
        if ("unread" in read) notRead(step, read.unread);
        else {
          step.readBack = read.value.name === body.name && sameSites(body.sites, read.value.sites) ? "matches" : "differs";
          if (step.readBack === "differs") step.readBackNote = `Read back ${read.value.sites.length} sites named "${read.value.name}".`;
        }
      } else if (step.kind === "profile") {
        const body: Record<string, unknown> = { ...step.body };
        if (step.listActions?.length) {
          body.filterBySiteList = true;
          body.siteListActions = step.listActions.map((l) => {
            const id = listIds[l.listKey];
            if (!id) throw new Error(`Site list ${l.listKey} wasn't created, so the profile wasn't sent.`);
            return { id, action: l.action, priority: l.priority };
          });
        }
        step.body = body;
        await sending(step);
        const { value, note } = step.found
          ? await use({ ...step, found: step.found })
          : await auditedCreate(
              t,
              "profile",
              () => createProfile(api, t, body),
              async () => (await listProfiles(new ReadOnlyApi(api), t)).find((p) => p.name === body.name) ?? null,
              "the profile",
              { where: "the tenant's profiles", found: `no profile named "${String(body.name)}"`, advice: takenNameAdvice(`the profile "${String(body.name)}"`, "a rollback", "build again") },
              { name: body.name, buildId: record.id },
            );
        step.id = value.id;
        step.note = note;
        profileId = value.id;
        step.status = "created";
        const read = await readOnce(() => getProfile(new ReadOnlyApi(api), t, value.id));
        const back = "unread" in read ? null : read.value;
        let same = !!back && back.name === body.name;
        if (back && same && body.filterByCategory === true) {
          const want = body.preset ? expandPreset(catalog, String(body.preset)) : expand(catalog, body as never);
          const got = back.preset ? expandPreset(catalog, back.preset) : expand(catalog, back as never);
          same = canonicalJson(want) === canonicalJson(got);
        }
        if (back && same) {
          const want = ((body.siteListActions as Array<{ id: string; action: string; priority: number }>) ?? []).map((x) => `${x.id}:${x.action}:${x.priority}`).sort();
          const got = (back.siteListActions ?? []).map((x) => `${x.id}:${x.action}:${x.priority}`).sort();
          same = canonicalJson(want) === canonicalJson(got);
        }
        if ("unread" in read) notRead(step, read.unread);
        else step.readBack = same ? "matches" : "differs";
      } else {
        if (!profileId) throw new Error("No profile was created, so the pilot policy wasn't sent.");
        const body = pilotPolicyBody(record.pilot.name, profileId, record.pilot.targets, record.pilot.enabled);
        step.body = body;
        await sending(step);
        const { value, note } = step.found
          ? await use({ ...step, found: step.found })
          : await auditedCreate(
              t,
              "policy",
              () => createPolicy(api, t, body),
              async () => (await listPolicies(new ReadOnlyApi(api), t, "web-control")).find((p) => p.name === body.name) ?? null,
              "the pilot policy",
              { where: "the tenant's Web Control policies", found: `no policy named "${String(body.name)}"`, advice: takenNameAdvice(`the policy "${String(body.name)}"`, "a rollback", "build again") },
              { name: body.name, appliesTo: body.appliesTo, buildId: record.id },
            );
        step.id = value.id;
        step.note = note;
        step.status = "created";
        const read = await readOnce(() => getPolicy(new ReadOnlyApi(api), t, value.id));
        if ("unread" in read) notRead(step, read.unread);
        else {
          const back = read.value;
          step.readBack = policyMatches(body, back) ? "matches" : "differs";
          if (step.readBack === "differs") step.readBackNote = "Settings or assignment read back differently.";
          step.note = [step.note, `Read back at priority ${back.priority}.`].filter(Boolean).join(" ");
        }
      }
      delete step.sending;
      await saveRecord(dataDir, record);
    }
    record.status = "built";
  } catch (err) {
    const step = record.steps.find((s) => s.status === "planned");
    if (step) delete step.sending;
    if (step && err instanceof UnreadAfterWriteError) {
      // Sophos didn't answer the create with a success, and the tenant couldn't be read to look for it by name: it may
      // have been made. Not confirmed, not failed; there's no id, so the next build looks for it by name first.
      step.status = "unconfirmed";
      step.answer = err.answer;
      step.readBack = "not-read";
      step.readBackNote = err.unread;
    } else if (step) {
      step.status = "failed";
      step.error = err instanceof Error ? err.message : String(err);
    }
    record.status = record.steps.some((s) => s.status === "created" || s.status === "unconfirmed") ? "partial" : "failed";
    log.emit("error", SECTION, `Build stopped: ${step?.error ?? (err instanceof Error ? err.message : String(err))}`, { tenant: t });
  }
  record.finishedAt = new Date().toISOString();
  await saveRecord(dataDir, record);
  return record;
}

/** One read after a create: what it found, or why it failed. */
async function readOnce<T>(read: () => Promise<T>): Promise<{ value: T } | { unread: string }> {
  try {
    return { value: await read() };
  } catch (err) {
    return { unread: err instanceof Error ? err.message : String(err) };
  }
}

/** A step Sophos made whose read-back failed: not confirmed, with why (what Sophos answered) kept for its Detail line. */
function notRead(step: BuildStep, why: string): void {
  step.readBack = "not-read";
  step.readBackNote = why;
}

export function policyMatches(sent: Record<string, unknown>, got: Policy): boolean {
  const settings = sent.settings as Record<string, { value: unknown }>;
  for (const [k, v] of Object.entries(settings)) {
    if (canonicalJson(got.settings?.[k]?.value) !== canonicalJson(v.value)) return false;
  }
  if ((got.enabled ?? true) !== sent.enabled) return false;
  const want = sent.appliesTo as Record<string, string[]>;
  for (const [k, ids] of Object.entries(want)) {
    const have = ((got.appliesTo as Record<string, string[]> | undefined)?.[k] ?? []).slice().sort();
    if (canonicalJson(have) !== canonicalJson([...ids].sort())) return false;
  }
  return true;
}

/** Undoes a build: policy, then profiles, then site lists, each confirmed gone; then Website Management from the snapshot. */
export async function rollback(
  dataDir: string,
  ctx: TenantContext,
  buildId: string,
  opts: { dryRun: boolean },
): Promise<BuildRecord & { restorePlan?: RestoreStep[]; restoreRefused?: string }> {
  const record = await getBuild(dataDir, ctx.tenantId, buildId);
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  const t = ctx.tenantId;
  // An Allow of this build whose new list Sophos didn't confirm left no id either: the list is looked for by name too,
  // as a step of the build. pilot-service imports this module, so it's loaded here, when it's needed.
  const { askedAllowLists, settleAllowLists } = await import("./pilot-service.js");
  const allows = await askedAllowLists(dataDir, t, record);
  record.steps.push(...allows.steps);
  // An unconfirmed step has no id: it's looked for by name in its place in the order, then deleted by the id found.
  const created = record.steps.filter((s) => (s.id && s.status !== "deleted") || (s.status === "unconfirmed" && !s.id));
  const order: StepKind[] = ["policy", "profile", "site-list"];
  const toDelete = order.flatMap((k) => created.filter((s) => s.kind === k).reverse());
  let restorePlan: RestoreStep[] = [];
  let restoreRefused: string | undefined;
  let snapshot: Snapshot | null = null;
  if (record.snapshotFile) {
    const loaded = await loadSnapshot(dataDir, t, record.snapshotFile);
    snapshot = loaded.snapshot;
    // A snapshot edited after it was saved doesn't say what the tenant was, so nothing is written from it.
    if (!loaded.intact) {
      restoreRefused = `The snapshot ${record.snapshotFile} was changed after it was saved (its SHA-256 doesn't match), so Website Management isn't restored from it. Check Website Management in Sophos Fusion.`;
    } else if (snapshot.objects.websiteManagement) {
      restorePlan = planWebsiteManagementRestore(snapshot.objects.websiteManagement, await listLocalSites(ro, t));
    }
  }
  const refused = restoreRefused ? { restoreRefused } : {};
  if (opts.dryRun) return { ...record, restorePlan, ...refused };

  const out: NonNullable<BuildRecord["rollback"]>["steps"] = [];
  const getter: Record<StepKind, (id: string) => Promise<unknown>> = {
    policy: (id) => getPolicy(ro, t, id),
    profile: (id) => getProfile(ro, t, id),
    "site-list": (id) => getSiteList(ro, t, id),
  };
  const deleter: Record<StepKind, (id: string) => Promise<unknown>> = {
    policy: (id) => deletePolicy(api, t, id),
    profile: (id) => deleteProfile(api, t, id),
    "site-list": (id) => deleteSiteList(api, t, id),
  };
  // The ids the next build leaves alone when it looks for a step by name; an Allow's list has its own (allows.recorded).
  let builtIds: Set<string> | undefined;
  for (const s of toDelete) {
    // Set when the step had no id and was found by name: what the rollback says of it.
    let found: { lookedUp?: "found" } = {};
    if (!s.id) {
      const recorded = s.key.startsWith("pilot-allows-") ? allows.recorded : (builtIds ??= await idsCreatedByTool(dataDir, t));
      const look = await lookUpByName(api, t, s.kind, s.name, recorded);
      if (look.unread !== undefined) {
        // Not read: it may or may not be there, so the rollback isn't confirmed, and the step stays unconfirmed.
        out.push({ kind: s.kind, name: s.name, status: "not confirmed", lookedUp: "not read", error: unreadLookUp(s.kind, look.unread) });
        continue;
      }
      if (!look.found) {
        s.status = "not-found";
        out.push({ kind: s.kind, name: s.name, status: "not there", lookedUp: "not found" });
        continue;
      }
      s.id = look.found.id;
      s.note = "Found by name by the rollback: Sophos didn't confirm it was made.";
      found = { lookedUp: "found" };
    }
    const entry = { tenantId: t, action: "delete", resource: s.kind, resourceId: s.id, detail: { name: s.name, rollbackOf: record.id, ...(found.lookedUp ? { foundByName: true } : {}) } };
    // Set when the delete got no clear answer (a 5xx, no answer in time, or a dropped connection), which can come back for a delete that went through.
    let unclear: { said: string; reason: string } | undefined;
    // Set when Sophos answered 404, so the object was already gone. Audited below, with what the read-back found, to match the step.
    let answered404: string | undefined;
    // What an Allow undo found before is over: this rollback's outcome is in out.
    delete s.deleteError;
    try {
      await deleter[s.kind](s.id!);
      await auditOrWarn({ ...entry, ok: true });
    } catch (err) {
      const status = errorStatus(err);
      const message = err instanceof Error ? err.message : String(err);
      if (isUnclearWrite(err) || (status !== undefined && status >= 500)) {
        // Audited below, with what the read-back found.
        const reason = (isUnclearWrite(err) ? err.reason : message).replace(/\.$/, "");
        unclear = { said: status !== undefined && status >= 500 ? `Sophos answered ${status}` : reason, reason };
      } else if (status === 404) {
        answered404 = message.replace(/\.$/, "");
      } else {
        await auditOrWarn({ ...entry, ok: false, error: message });
        s.status = "delete-failed";
        // Refused: this delete wasn't accepted, so there's no read-back to keep.
        delete s.deleteReadBack;
        delete s.deleteAnswer;
        out.push({ kind: s.kind, name: s.name, id: s.id, status: "failed", error: message, ...found });
        continue;
      }
    }
    // Confirm it's gone: GET by id answers 404 at once (retested 13/10/2026). A read that fails another way is a miss.
    const gone = await readBack(async () => {
      try {
        await getter[s.kind](s.id!);
        return null;
      } catch (err) {
        if (errorStatus(err) === 404) return true;
        throw err;
      }
    });
    s.status = gone.value ? "deleted" : "delete-failed";
    const read = gone.unread ? `A read-back couldn't read it (${gone.unread.replace(/\.$/, "")}), so it may still be there.` : "A read-back still found it, so it wasn't deleted.";
    // Not confirmed gone after a delete Sophos accepted, or one it gave no clear answer to and nothing could be read: kept for the step's row.
    if (gone.value || (unclear !== undefined && !gone.unread)) delete s.deleteReadBack;
    else s.deleteReadBack = gone.unread ? `not read: ${gone.unread}` : "still there";
    // How Sophos answered when it wasn't a success, kept with that read-back: the row then doesn't say Sophos accepted the delete.
    const answer = unclear?.reason ?? answered404;
    if (s.deleteReadBack && answer !== undefined) s.deleteAnswer = answer;
    else delete s.deleteAnswer;
    if (unclear === undefined) {
      // A read that failed doesn't show it's still there, only that the delete isn't confirmed.
      out.push(gone.value || !gone.unread ? { kind: s.kind, name: s.name, id: s.id, status: gone.value ? "deleted, 404 on read-back" : "still there after delete", ...found } : { kind: s.kind, name: s.name, id: s.id, status: "not confirmed", error: read, ...found });
      if (answered404 !== undefined) {
        await auditOrWarn(gone.value ? { ...entry, ok: true, detail: { ...entry.detail, note: "Sophos answered 404, so it was already gone, and a read-back found it gone (404)" } } : { ...entry, ok: false, error: `${answered404}. ${read}` });
      }
    } else if (gone.value) {
      const note = `${unclear.said}, then a read-back found it gone (404)`;
      await auditOrWarn({ ...entry, ok: true, detail: { ...entry.detail, note } });
      out.push({ kind: s.kind, name: s.name, id: s.id, status: `deleted: ${note}`, ...found });
    } else {
      const error = `${unclear.reason}. ${read}`;
      await auditOrWarn({ ...entry, ok: false, error });
      // Found still there, it failed. Not read, it may have gone through: not confirmed either way.
      out.push({ kind: s.kind, name: s.name, id: s.id, status: gone.unread ? "not confirmed" : "failed", error, ...found });
    }
  }
  // An Allow whose list was looked for here: done with the build, or holding the list found until it's deleted.
  if (record.steps.some((s) => s.key.startsWith("pilot-allows-asked-"))) await settleAllowLists(dataDir, t, record);
  // Whether a Website Management step reads back as the snapshot has it: an entry re-created or patched back, or one deleted gone (404).
  const restoredNow = async (step: RestoreStep): Promise<true | null> => {
    if (step.op === "delete") {
      try {
        await getLocalSite(ro, t, step.id);
        return null;
      } catch (err) {
        if (errorStatus(err) === 404) return true;
        throw err;
      }
    }
    const want = (snapshot?.objects.websiteManagement ?? []).filter((x) => x.url === step.url);
    return want.length && planWebsiteManagementRestore(want, await listLocalSites(ro, t)).length === 0 ? true : null;
  };
  for (const step of restorePlan) {
    const name = `${step.op} ${step.url}`;
    try {
      // A 5xx or no answer can still have gone through, so it's read back, as a delete is; a refusal is thrown.
      const { unclear } = await sendChecked<unknown>(() =>
        step.op === "create"
          ? auditedWrite({ tenantId: t }, "restore-create", "local-site", undefined, () => createLocalSite(api, t, step.body), { url: step.url })
          : step.op === "patch"
            ? auditedWrite({ tenantId: t }, "restore-patch", "local-site", step.id, () => patchLocalSite(api, t, step.id, step.body), { url: step.url, was: step.was })
            : auditedWrite({ tenantId: t }, "restore-delete", "local-site", step.id, () => deleteLocalSite(api, t, step.id), { url: step.url }),
      );
      if (!unclear) {
        out.push({ kind: "website-management", name, status: "done" });
        continue;
      }
      const back = await readBack(() => restoredNow(step));
      const said = unclear.reason.replace(/\.$/, "");
      if (back.value) {
        await auditOrWarn({ tenantId: t, action: `restore-${step.op}`, resource: "local-site", resourceId: step.op === "create" ? undefined : step.id, ok: true, detail: { url: step.url, note: foundNote(unclear, "it as the snapshot has it", "in Website Management") } });
        out.push({ kind: "website-management", name, status: "done" });
      } else if (!back.unread) {
        // No clear answer, and a read-back found it not as the snapshot has it: not made, as a rollback counts a delete still found.
        out.push({ kind: "website-management", name, status: "failed", error: `${said}. A read-back found it not as the snapshot has it, so it wasn't made.` });
      } else {
        // Nothing could be read: it may have gone through, so it's not confirmed, with what Sophos said.
        out.push({ kind: "website-management", name, status: "not confirmed", answer: said, error: `${said}. A read-back couldn't read Website Management (${back.unread.replace(/\.$/, "")}), so the change isn't confirmed.` });
      }
    } catch (err) {
      out.push({ kind: "website-management", name, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (restoreRefused) out.push({ kind: "website-management", name: "Website Management from the snapshot", status: "failed", error: restoreRefused });
  // Website Management read back once the restore is sent: confirmed when the snapshot's entries all read back as it has them.
  const snapshotSites = snapshot?.objects.websiteManagement;
  if (snapshotSites && out.some((o) => o.kind === "website-management" && o.status === "done")) {
    const back = await readBack(async () => (planWebsiteManagementRestore(snapshotSites, await listLocalSites(ro, t)).length === 0 ? true : null));
    const name = "Website Management read back";
    out.push(
      back.value
        ? { kind: "website-management", name, status: "matches the snapshot" }
        : {
            kind: "website-management",
            name,
            status: "not confirmed",
            error: back.unread
              ? `A read-back couldn't read Website Management (${back.unread.replace(/\.$/, "")}), so the restore isn't confirmed.`
              : "Website Management didn't read back as the snapshot has it. Compare with the snapshot to see what differs.",
          },
    );
  }
  record.rollback = { at: new Date().toISOString(), steps: out };
  record.status = out.every((o) => !["failed", "still there after delete", "not confirmed"].includes(o.status)) ? "rolled-back" : "rollback-partial";
  await saveRecord(dataDir, record);
  return { ...record, restorePlan, ...refused };
}

/** Every id this tool deleted in a tenant, from the audit log. */
export async function idsDeletedByTool(dataDir: string, tenantId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const text = await readText(path.join(dataDir, "audit.log"), SECTION).catch(() => null);
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { tenantId?: string; action?: string; ok?: boolean; resourceId?: string };
      if (e.tenantId === tenantId && e.ok && e.resourceId && /delete/.test(e.action ?? "")) ids.add(e.resourceId);
    } catch {
      // A damaged line says nothing.
    }
  }
  return ids;
}

/** Every id this tool created in a tenant, from its build records, for the snapshot diff. */
export async function idsCreatedByTool(dataDir: string, tenantId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const b of await listBuilds(dataDir, tenantId)) for (const s of b.steps) if (s.id) ids.add(s.id);
  return ids;
}

export { patchPolicy };

/** Reads the tenant now and compares it with a saved snapshot. */
export async function diffWithSnapshot(
  dataDir: string,
  ctx: TenantContext,
  snapshotFile: string,
  tool: { name: string; version: string },
): Promise<import("../domain/restore.js").SnapshotDiff & { snapshotFile: string; readAt: string; intact: boolean }> {
  const loaded = await loadSnapshot(dataDir, ctx.tenantId, snapshotFile);
  const tenant: InventoryTenant = { id: ctx.tenantId, name: ctx.summary.displayName, region: ctx.summary.region, apiHost: ctx.summary.apiHost, credentialType: ctx.summary.credentialType };
  const inventory = await readInventory(ctx.client, tenant, { parallel: 3 });
  const after = buildSnapshot(inventory, tool);
  const diff = compareToSnapshot(loaded.snapshot, after, await idsCreatedByTool(dataDir, ctx.tenantId), await idsDeletedByTool(dataDir, ctx.tenantId));
  return { ...diff, snapshotFile, readAt: inventory.readAt, intact: loaded.intact };
}
