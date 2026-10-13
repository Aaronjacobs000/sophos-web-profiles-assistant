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
 *   rollback  deletes what the build created in reverse order (policy, then
 *             profiles, then site lists; the API refuses to delete a profile
 *             or list still in use), verifies each 404, and puts Website
 *             Management back from the snapshot.
 *
 * Deletes go only to ids this tool recorded, never by name: other tools can
 * share a tenant.
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
import { createLocalSite, deleteLocalSite, listLocalSites, patchLocalSite } from "../sophos/api/web-control.js";
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
import { compareToSnapshot, planWebsiteManagementRestore, type RestoreStep } from "../domain/restore.js";
import { buildSnapshot, canonicalJson, type Snapshot } from "../domain/snapshot.js";
import { readInventory } from "./inventory-reader.js";
import { auditedWrite, auditOrWarn } from "./audit-log.js";
import { createChecked, readBack } from "./write-check.js";
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
  status: "planned" | "created" | "failed" | "skipped" | "deleted" | "delete-failed";
  id?: string;
  readBack?: "matches" | "differs" | "not-read";
  readBackNote?: string;
  error?: string;
  note?: string;
  /** For a profile: its site lists by plan key, filled with real ids at build time. */
  listActions?: Array<{ listKey: string; action: "allow" | "block" | "warn"; priority: number }>;
}

export interface Check {
  ok: boolean;
  level: "ok" | "warn" | "fail";
  text: string;
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
  rollback?: { at: string; steps: Array<{ kind: StepKind | "website-management"; name: string; id?: string; status: string; error?: string }> };
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
    if (text) out.push(JSON.parse(text) as BuildRecord);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getBuild(dataDir: string, tenantId: string, id: string): Promise<BuildRecord> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Not a build ID.");
  const text = await readText(path.join(buildsDir(dataDir, tenantId), `${id}.json`), SECTION);
  if (!text) throw new Error("No such build.");
  return JSON.parse(text) as BuildRecord;
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

  const newLists = steps.filter((s) => s.kind === "site-list").length;
  checks.push(
    profiles.length + 1 <= PROFILE_LIMIT
      ? { ok: true, level: "ok", text: `Profiles: ${profiles.length} in the account, 1 to add, limit ${PROFILE_LIMIT}.` }
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
    if (taken.has(s.name.toLowerCase())) checks.push({ ok: false, level: "fail", text: `A ${s.kind.replace("-", " ")} named "${s.name}" already exists. Rename or remove it first.` });
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
    checks.push({ ok: false, level: "fail", text: `Couldn't check the targets: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (!(tg.users?.length || tg.userGroups?.length || tg.endpoints?.length || tg.endpointGroups?.length)) {
    checks.push({ ok: true, level: "warn", text: "No pilot targets chosen: the policy is created unassigned. Assign it here later or in Sophos Fusion." });
  }
  if (!design.cleanedUp) checks.push({ ok: true, level: "warn", text: "The clean-up step hasn't run, so the site lists hold every entry the policy uses." });
  for (const w of design.warnings) checks.push({ ok: true, level: "warn", text: w });
  checks.push({ ok: true, level: "ok", text: "Write access is confirmed by the first create; a refusal stops the build before anything else is sent." });

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

/** A create that is sent once, read back by name when Sophos gives no clear answer, and audited with the id it made. */
export async function auditedCreate<T extends { id: string }>(
  tenantId: string,
  resource: string,
  create: () => Promise<T>,
  find: () => Promise<T | null>,
  what: string,
  miss: { where: string; found: string },
  detail: Record<string, unknown>,
): Promise<{ value: T; note?: string }> {
  try {
    const r = await createChecked(create, find, what, miss);
    await auditOrWarn({ tenantId, action: "create", resource, resourceId: r.value.id, ok: true, detail: { ...detail, ...(r.note ? { note: r.note } : {}) } });
    return r;
  } catch (err) {
    await auditOrWarn({ tenantId, action: "create", resource, ok: false, error: err instanceof Error ? err.message : String(err), detail });
    throw err;
  }
}

function sameSites(sent: string[], got: string[]): boolean {
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
    record.checks.push({ ok: false, level: "fail", text: `No rollback snapshot could be saved, so nothing was built. ${readiness.snapshotError ?? ""}`.trim() });
    await saveRecord(dataDir, record);
    return record;
  }
  record.status = "partial";
  await saveRecord(dataDir, record);

  const listIds: Record<string, string> = {};
  let profileId: string | null = null;
  try {
    for (const step of record.steps) {
      if (step.kind === "site-list") {
        const body = step.body as { name: string; description?: string; sites: string[] };
        const { value, note } = await auditedCreate(
          t,
          "site-list",
          () => createSiteList(api, t, body),
          async () => (await listSiteLists(new ReadOnlyApi(api), t)).find((l) => l.name === body.name) ?? null,
          "the site list",
          { where: "the tenant's site lists", found: `no site list named "${body.name}"` },
          { name: body.name, sites: body.sites.length, buildId: record.id },
        );
        step.id = value.id;
        step.note = note;
        listIds[step.key] = value.id;
        step.status = "created";
        const back = await getSiteList(new ReadOnlyApi(api), t, value.id).catch(() => null);
        const sites = back?.sites ?? (await listSites(new ReadOnlyApi(api), t, value.id)).map((s) => s.site);
        step.readBack = back && back.name === body.name && sameSites(body.sites, sites) ? "matches" : "differs";
        if (step.readBack === "differs") step.readBackNote = `Read back ${sites.length} sites named "${back?.name}".`;
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
        const { value, note } = await auditedCreate(
          t,
          "profile",
          () => createProfile(api, t, body),
          async () => (await listProfiles(new ReadOnlyApi(api), t)).find((p) => p.name === body.name) ?? null,
          "the profile",
          { where: "the tenant's profiles", found: `no profile named "${String(body.name)}"` },
          { name: body.name, buildId: record.id },
        );
        step.id = value.id;
        step.note = note;
        profileId = value.id;
        step.status = "created";
        const back = await getProfile(new ReadOnlyApi(api), t, value.id).catch(() => null);
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
        step.readBack = same ? "matches" : "differs";
      } else {
        if (!profileId) throw new Error("No profile was created, so the pilot policy wasn't sent.");
        const body = pilotPolicyBody(record.pilot.name, profileId, record.pilot.targets, record.pilot.enabled);
        step.body = body;
        const { value, note } = await auditedCreate(
          t,
          "policy",
          () => createPolicy(api, t, body),
          async () => (await listPolicies(new ReadOnlyApi(api), t, "web-control")).find((p) => p.name === body.name) ?? null,
          "the pilot policy",
          { where: "the tenant's Web Control policies", found: `no policy named "${String(body.name)}"` },
          { name: body.name, appliesTo: body.appliesTo, buildId: record.id },
        );
        step.id = value.id;
        step.note = note;
        step.status = "created";
        const back = await getPolicy(new ReadOnlyApi(api), t, value.id).catch(() => null);
        step.readBack = back && policyMatches(body, back) ? "matches" : "differs";
        if (back && step.readBack === "differs") step.readBackNote = "Settings or assignment read back differently.";
        if (back) step.note = [step.note, `Read back at priority ${back.priority}.`].filter(Boolean).join(" ");
      }
      await saveRecord(dataDir, record);
    }
    record.status = "built";
  } catch (err) {
    const step = record.steps.find((s) => s.status === "planned");
    if (step) {
      step.status = "failed";
      step.error = err instanceof Error ? err.message : String(err);
    }
    record.status = record.steps.some((s) => s.status === "created") ? "partial" : "failed";
    log.emit("error", SECTION, `Build stopped: ${step?.error ?? String(err)}`, { tenant: t });
  }
  record.finishedAt = new Date().toISOString();
  await saveRecord(dataDir, record);
  return record;
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
export async function rollback(dataDir: string, ctx: TenantContext, buildId: string, opts: { dryRun: boolean }): Promise<BuildRecord & { restorePlan?: RestoreStep[] }> {
  const record = await getBuild(dataDir, ctx.tenantId, buildId);
  const api: TenantApi = ctx.client;
  const ro = new ReadOnlyApi(api);
  const t = ctx.tenantId;
  const created = record.steps.filter((s) => s.id && s.status !== "deleted");
  const order: StepKind[] = ["policy", "profile", "site-list"];
  const toDelete = order.flatMap((k) => created.filter((s) => s.kind === k).reverse());
  let restorePlan: RestoreStep[] = [];
  let snapshot: Snapshot | null = null;
  if (record.snapshotFile) {
    const loaded = await loadSnapshot(dataDir, t, record.snapshotFile);
    snapshot = loaded.snapshot;
    if (snapshot.objects.websiteManagement) {
      restorePlan = planWebsiteManagementRestore(snapshot.objects.websiteManagement, await listLocalSites(ro, t));
    }
  }
  if (opts.dryRun) return { ...record, restorePlan };

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
  for (const s of toDelete) {
    try {
      await auditedWrite({ tenantId: t }, "delete", s.kind, s.id!, () => deleter[s.kind](s.id!), { name: s.name, rollbackOf: record.id });
    } catch (err) {
      if (errorStatus(err) !== 404) {
        s.status = "delete-failed";
        out.push({ kind: s.kind, name: s.name, id: s.id, status: "failed", error: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
    // Confirm it's gone: GET by id answers 404 at once (retested 13/10/2026).
    const gone = await readBack(async () => {
      try {
        await getter[s.kind](s.id!);
        return null;
      } catch (err) {
        return errorStatus(err) === 404 ? true : null;
      }
    });
    s.status = gone.value ? "deleted" : "delete-failed";
    out.push({ kind: s.kind, name: s.name, id: s.id, status: gone.value ? "deleted, 404 on read-back" : "still there after delete" });
  }
  for (const step of restorePlan) {
    try {
      if (step.op === "create") await auditedWrite({ tenantId: t }, "restore-create", "local-site", undefined, () => createLocalSite(api, t, step.body), { url: step.url });
      else if (step.op === "patch") await auditedWrite({ tenantId: t }, "restore-patch", "local-site", step.id, () => patchLocalSite(api, t, step.id, step.body), { url: step.url, was: step.was });
      else await auditedWrite({ tenantId: t }, "restore-delete", "local-site", step.id, () => deleteLocalSite(api, t, step.id), { url: step.url });
      out.push({ kind: "website-management", name: `${step.op} ${step.url}`, status: "done" });
    } catch (err) {
      out.push({ kind: "website-management", name: `${step.op} ${step.url}`, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  record.rollback = { at: new Date().toISOString(), steps: out };
  record.status = out.every((o) => o.status !== "failed" && o.status !== "still there after delete") ? "rolled-back" : "rollback-partial";
  await saveRecord(dataDir, record);
  return { ...record, restorePlan };
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
