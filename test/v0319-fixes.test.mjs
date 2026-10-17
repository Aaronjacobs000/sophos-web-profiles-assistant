// v0.3.19: a write's outcome never claims more than its read-back confirmed
// (category C), in what the services record: a read-back that couldn't read
// is "not read" with why, never "differs", "still there" or a failure of a
// write Sophos accepted; a write Sophos accepted is kept as made, so the
// build, the clean-up's site lists and an Allow go on from it; a rollback
// reads Website Management back; and the snapshot comparison says which
// sections it couldn't compare. Also: the estate scan stops counting as
// running only once its last save has settled, and the dead code and styles
// left from the migration tool are gone. Each case runs against an in-memory
// tenant that answers as the case needs.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { initState } from "../backend/dist/state.js";
import { log } from "../backend/dist/log.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { startEstateScan } from "../backend/dist/services/estate.js";
import { moveWave, setPilotEnabled, undoWave } from "../backend/dist/services/promote-service.js";
import { activePilot, addAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { createLists, undoLists } from "../backend/dist/services/lists-service.js";
import { designFor, execute, getBuild, rollback } from "../backend/dist/services/build-service.js";
import { restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { runReadiness } from "../backend/dist/services/readiness.js";
import { compareToSnapshot } from "../backend/dist/domain/restore.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { device, wcPolicy } from "./fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = "00000000-0000-4000-a000-000000000001";
const P = "66666666-6666-4666-8666-666666666666";
const TOOL = { name: "web-profiles-assistant", version: "0.3.19" };
const UNAVAILABLE = "Sophos API error 503: ServiceUnavailable";

before(() => setReadBackDelays([0, 0]));

async function dataDirFor(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `wpa-v0319-${name}-`));
  await initState(dir, "0.3.19");
  return path.join(dir, "data");
}

/**
 * An in-memory tenant. refuse(method, pattern, status, when) makes matching
 * calls answer with an error while when() holds (always, by default). Every
 * call is kept in calls.
 */
class Tenant {
  constructor() {
    this.calls = [];
    this.rules = [];
    this.policies = new Map();
    this.profiles = new Map();
    this.lists = new Map();
    this.localSites = new Map();
    this.endpoints = [];
    this.writes = 0;
    /** Site lists made without their last site, so a read-back finds fewer than were sent. */
    this.dropLastSite = false;
    /** Website Management creates answered as made but not kept. */
    this.forgetLocalSites = false;
  }
  refuse(method, pattern, status = 503, when = () => true) {
    this.rules.push({ method, pattern, status, when });
  }
  err(status, msg) {
    return new Error(`Sophos API error ${status}: ${msg ?? (status === 404 ? "NotFound" : status === 503 ? "ServiceUnavailable" : "Forbidden")}`);
  }
  async tenantRequest(tenantId, p, o = {}) {
    const m = o.method ?? "GET";
    const body = o.body;
    this.calls.push(`${m} ${p}`);
    for (const r of this.rules) if (r.method === m && r.pattern.test(p) && r.when()) throw this.err(r.status);
    if (m !== "GET") this.writes++;
    let x;
    if (p === "/endpoint/v1/endpoints") return { items: this.endpoints, pages: {} };
    if (p === "/endpoint/v1/policies") {
      if (m === "GET") return { items: [...this.policies.values()].filter((y) => y.type === o.params?.policyType), pages: { total: 1 } };
      const id = randomUUID();
      this.policies.set(id, { ...structuredClone(body), id, priority: 1 });
      return structuredClone(this.policies.get(id));
    }
    if ((x = /^\/endpoint\/v1\/policies\/([^/]+)$/.exec(p))) {
      const pol = this.policies.get(x[1]);
      if (!pol) throw this.err(404);
      if (m === "GET") return structuredClone(pol);
      if (m === "PATCH") {
        if (body.appliesTo) pol.appliesTo = structuredClone(body.appliesTo);
        if (body.enabled !== undefined) pol.enabled = body.enabled;
        for (const [k, v] of Object.entries(body.settings ?? {})) pol.settings[k] = { value: structuredClone(v.value) };
        return structuredClone(pol);
      }
      if (m === "DELETE") return this.policies.delete(pol.id), {};
    }
    if (p === "/web-filters/v1/profiles") {
      if (m === "GET") return { items: [...this.profiles.values()], pages: { total: 1 } };
      const id = randomUUID();
      this.profiles.set(id, { ...structuredClone(body), id });
      return structuredClone(this.profiles.get(id));
    }
    if ((x = /^\/web-filters\/v1\/profiles\/([^/]+)$/.exec(p))) {
      const prof = this.profiles.get(x[1]);
      if (!prof) throw this.err(404);
      if (m === "GET") return structuredClone(prof);
      if (m === "PUT") return this.profiles.set(prof.id, { ...structuredClone(body), id: prof.id }), structuredClone(this.profiles.get(prof.id));
      if (m === "DELETE") return this.profiles.delete(prof.id), {};
    }
    if (p === "/web-filters/v1/site-lists") {
      if (m === "GET") return { items: [...this.lists.values()].map(({ sites, ...l }) => ({ ...l, numberOfSites: sites.length })), pages: { total: 1 } };
      const id = randomUUID();
      const sites = this.dropLastSite ? body.sites.slice(0, -1) : body.sites;
      this.lists.set(id, { id, name: body.name, description: body.description, sites: sites.map((s) => ({ id: randomUUID(), site: s })) });
      return { id, name: body.name, sites };
    }
    if ((x = /^\/web-filters\/v1\/site-lists\/([^/]+)(\/sites)?(?:\/([^/]+))?$/.exec(p))) {
      const list = this.lists.get(x[1]);
      if (!list) throw this.err(404);
      if (!x[2]) {
        if (m === "GET") return { id: list.id, name: list.name, sites: list.sites.map((s) => s.site) };
        if (m === "DELETE") {
          if ([...this.profiles.values()].some((pr) => (pr.siteListActions ?? []).some((a) => a.id === list.id))) throw this.err(409, "Conflict - in use");
          return this.lists.delete(list.id), {};
        }
      } else if (!x[3]) {
        if (m === "GET") return { items: structuredClone(list.sites), pages: { total: 1 } };
        if (m === "POST") {
          const s = { id: randomUUID(), site: body.site.toLowerCase() };
          list.sites.push(s);
          return s;
        }
      } else if (m === "DELETE") {
        list.sites = list.sites.filter((s) => s.id !== x[3]);
        return {};
      }
    }
    if (p === "/endpoint/v1/settings/web-control/local-sites") {
      if (m === "GET") return { items: [...this.localSites.values()].map((y) => structuredClone(y)), pages: { total: 1 } };
      const id = randomUUID();
      if (!this.forgetLocalSites) this.localSites.set(id, { id, ...structuredClone(body) });
      return { id, ...body };
    }
    if ((x = /^\/endpoint\/v1\/settings\/web-control\/local-sites\/([^/]+)$/.exec(p))) {
      const s = this.localSites.get(x[1]);
      if (!s) throw this.err(404);
      if (m === "GET") return structuredClone(s);
      if (m === "PATCH") return Object.assign(s, structuredClone(body)), structuredClone(s);
      if (m === "DELETE") return this.localSites.delete(s.id), {};
    }
    if (m !== "GET") throw new Error(`tenant: no route for ${m} ${p}`);
    return { items: [], pages: { total: 1 } };
  }
}

const ctxOf = (tenant) => ({ tenantId: T, client: tenant, summary: { displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" } });
const step = (order, kind, name, id) => ({ order, kind, key: kind === "policy" ? "pilot" : kind, name, method: "POST", path: "", summary: "", body: {}, status: "created", id, readBack: "matches" });

/** A built pilot in the tenant and on file: a site list, a profile that uses it, and the pilot policy on w1. */
function seedPilot(tenant, dataDir) {
  const listId = randomUUID();
  tenant.lists.set(listId, { id: listId, name: "Example Block", sites: [{ id: randomUUID(), site: "blocked.example.com" }] });
  const profileId = randomUUID();
  tenant.profiles.set(profileId, { id: profileId, name: "Example profile", filterByCategory: false, filterBySiteList: true, siteListActions: [{ id: listId, action: "block", priority: 1 }] });
  const policyId = randomUUID();
  tenant.policies.set(policyId, wcPolicy({ id: policyId, name: "WF pilot: Example profile", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] } }));
  tenant.endpoints = [device("w1", "windows", "2026.2.2.1.0"), device("w2", "windows", "2026.2.2.1.0")];
  const build = { id: randomUUID(), tenantId: T, tenantName: "Example Tenant", createdAt: new Date().toISOString(), status: "built", pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: ["w1"] } }, steps: [step(1, "site-list", "Example Block", listId), step(2, "profile", "Example profile", profileId), step(3, "policy", "WF pilot: Example profile", policyId)], checks: [] };
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  writeFileSync(path.join(dataDir, "builds", T, `${build.id}.json`), JSON.stringify(build));
  return { listId, profileId, policyId, build };
}

/** True from the first write on: calls refused with this hold only once Sophos has accepted a write. */
const afterWrite = (tenant, from = tenant.writes) => () => tenant.writes > from;

// ---------- item 6: the estate scan ----------

/** A partner credential that reaches one tenant, whose every read Sophos refuses. */
function partner() {
  const client = { tenantRequest: async () => { throw new Error("Sophos API error 403: Forbidden"); } };
  return { client, identity: { id: P, idType: "partner" }, tenants: [{ id: T, name: "Example Tenant", apiHost: "https://api-us01.central.sophos.com", dataRegion: "us01" }] };
}

/**
 * Runs a scan with every file save slowed down, and looks at the data folder
 * the moment the scan stops counting as running: the estate view must be on
 * disk, saved as ended, with no save still writing.
 */
async function scanWithSlowSaves(dataDir) {
  const rename = fsp.rename;
  fsp.rename = async (...args) => {
    await new Promise((r) => setTimeout(r, 250));
    return rename(...args);
  };
  try {
    const run = await startEstateScan(dataDir, partner(), TOOL, 2);
    // Looked at within a few milliseconds of the scan ending: a save started then would still be writing (each takes 250 ms).
    for (let i = 0; i < 4000 && run.running; i++) await new Promise((r) => setTimeout(r, 5));
    const dir = path.join(dataDir, "estate");
    const files = readdirSync(dir);
    return { run, saved: JSON.parse(readFileSync(path.join(dir, `${P}.json`), "utf8")), temp: files.filter((f) => f.endsWith(".tmp")) };
  } finally {
    fsp.rename = rename;
  }
}

test("the estate scan stops counting as running only once its last save has settled", async () => {
  const dataDir = await dataDirFor("estate");
  try {
    const { run, saved, temp } = await scanWithSlowSaves(dataDir);
    assert.equal(run.running, false);
    assert.equal(saved.running, false, "the saved view says the scan ended");
    assert.ok(saved.finishedAt, "and when");
    assert.deepEqual(temp, [], "no save is still writing in the data folder");
  } finally {
    rmSync(path.dirname(dataDir), { recursive: true, force: true });
  }
});

test("an estate scan whose last step fails also ends only once its save has settled", async () => {
  const dataDir = await dataDirFor("estate-fail");
  const emit = log.emit;
  log.emit = function (level, section, message, opts) {
    if (/^Estate scan finished/.test(message)) throw new Error("injected: the scan's last step failed");
    return emit.call(this, level, section, message, opts);
  };
  try {
    const { saved, temp } = await scanWithSlowSaves(dataDir);
    assert.equal(saved.running, false);
    assert.deepEqual(temp, []);
  } finally {
    log.emit = emit;
    rmSync(path.dirname(dataDir), { recursive: true, force: true });
  }
});

// ---------- item 1 and the audit: promotion ----------

test("a wave Sophos accepted whose read-back couldn't read the policy is not confirmed, not 'read back without the new devices'", async () => {
  const dataDir = await dataDirFor("wave");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  tenant.refuse("GET", new RegExp(`/policies/${policyId}$`), 503, afterWrite(tenant));
  const w = await moveWave(dataDir, ctx, ["w2"], false);
  assert.deepEqual(tenant.policies.get(policyId).appliesTo.endpoints, ["w1", "w2"], "Sophos made the change");
  // From v0.3.20 (category D) such a wave is kept as unconfirmed, not failed, so it can be undone.
  assert.equal(w.status, "unconfirmed");
  assert.equal(w.readBack, `not read: ${UNAVAILABLE}`);
  assert.equal(w.error, "The tool couldn't read the pilot policy back, so the move isn't confirmed.");
});

test("turning the pilot on says 'not read' when the read-back couldn't read the policy, not 'differs'", async () => {
  const dataDir = await dataDirFor("toggle");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  tenant.refuse("GET", new RegExp(`/policies/${policyId}$`), 503, afterWrite(tenant));
  assert.deepEqual(await setPilotEnabled(dataDir, ctxOf(tenant), true), { enabled: true, readBack: `not read: ${UNAVAILABLE}` });
});

test("a wave undo Sophos accepted but couldn't read back keeps that read-back apart, and a later undo that works clears it", async () => {
  const dataDir = await dataDirFor("undo");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const w = await moveWave(dataDir, ctx, ["w2"], false);
  assert.equal(w.status, "moved", w.error);
  let failReads = true;
  tenant.refuse("GET", new RegExp(`/policies/${policyId}$`), 503, (() => { const from = tenant.writes; return () => failReads && tenant.writes > from; })());
  const failed = await undoWave(dataDir, ctx, w.id);
  assert.deepEqual(tenant.policies.get(policyId).appliesTo.endpoints, ["w1"], "Sophos made the undo");
  assert.equal(failed.status, "undo-failed");
  assert.equal(failed.undoReadBack, `not read: ${UNAVAILABLE}`);
  assert.equal(failed.error, "The tool couldn't read the pilot policy back, so the undo isn't confirmed.");
  // A refused undo has nothing Sophos accepted to read back.
  failReads = false;
  tenant.policies.get(policyId).appliesTo = { endpoints: ["w1", "w2"], endpointGroups: [] };
  tenant.refuse("PATCH", new RegExp(`/policies/${policyId}$`), 403, () => !failReads && tenant.blockPatch);
  tenant.blockPatch = true;
  const refused = await undoWave(dataDir, ctx, w.id);
  assert.equal(refused.status, "undo-failed");
  assert.equal(refused.undoReadBack, undefined, "this undo wasn't accepted, so there's no read-back to keep");
  tenant.blockPatch = false;
  const undone = await undoWave(dataDir, ctx, w.id);
  assert.equal(undone.status, "undone", undone.error);
  assert.equal(undone.undoReadBack, undefined);
});

// ---------- the audit: the Allow ----------

test("an Allow whose new list couldn't be read back is kept as added, not confirmed, and its list stays the build's", async () => {
  const dataDir = await dataDirFor("allow");
  const tenant = new Tenant();
  const { profileId, build } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  // The new list's reads fail once it's made; the pilot's own list still reads.
  const lists = new Set(tenant.lists.keys());
  tenant.refuse("GET", /\/site-lists\/[^/]+(\/sites)?$/, 503, () => tenant.writes > 0 && ![...lists].some((id) => tenant.calls[tenant.calls.length - 1].includes(id)));
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  assert.equal(entry.status, "added", entry.error);
  assert.equal(entry.readBack, `not read: ${UNAVAILABLE}; profile links it as allow`);
  assert.ok(tenant.profiles.get(profileId).siteListActions.some((a) => a.id === entry.listId && a.action === "allow"), "the list was linked");
  const after = await getBuild(dataDir, T, build.id);
  assert.ok(after.steps.some((s) => s.id === entry.listId && s.status === "created"), "a rollback deletes the list");
});

test("an Allow undo whose list read-back failed says the delete isn't confirmed, not that the list is still there", async () => {
  const dataDir = await dataDirFor("allow-undo");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  assert.equal(entry.readBack, "list holds the site; profile links it as allow");
  tenant.refuse("GET", new RegExp(`/site-lists/${entry.listId}$`), 503, afterWrite(tenant));
  const undone = await undoAllow(dataDir, ctx, entry.id);
  assert.ok(!tenant.lists.has(entry.listId), "Sophos deleted the list");
  assert.equal(undone.status, "undo-failed");
  assert.equal(undone.undoReadBack, `not read: ${UNAVAILABLE}`);
  assert.deepEqual(undone.undo, ["Profile read back without the list.", "The list couldn't be read back, so the delete isn't confirmed."]);
});

// ---------- items 3 and 4: the clean-up's site lists ----------

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com"), result(2, "files.example.net"), result(3, "chat.example.org", "warn")];

test("a site list that read back with fewer sites than were sent is made but not confirmed, and says how it differed", async () => {
  const dataDir = await dataDirFor("lists");
  const tenant = new Tenant();
  tenant.dropLastSite = true;
  const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  assert.deepEqual(rec.lists.map((l) => [l.name, l.status, l.readBack]), [
    ["Example cleaned Block", "created", "read back 1 site, not the 2 sent"],
    ["Example cleaned Warn", "created", "read back 0 sites, not the 1 sent"],
  ]);
});

test("a site list Sophos made whose read-back failed stays made, not confirmed, and the next list is still sent", async () => {
  const dataDir = await dataDirFor("lists-unread");
  const tenant = new Tenant();
  tenant.refuse("GET", /\/site-lists\/[^/]+(\/sites)?$/, 503, () => tenant.writes === 1);
  const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  assert.deepEqual(rec.lists.map((l) => [l.status, l.readBack]), [["created", `not read: ${UNAVAILABLE}`], ["created", "matches"]]);
  assert.ok(rec.lists.every((l) => l.id), "both are on record, so Undo deletes both");
  assert.equal(tenant.lists.size, 2);
});

test("an undo of the site lists says why a delete wasn't confirmed or was refused", async () => {
  const dataDir = await dataDirFor("lists-undo");
  const tenant = new Tenant();
  const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  const [block, warn] = rec.lists;
  tenant.refuse("GET", new RegExp(`/site-lists/${block.id}$`), 503, afterWrite(tenant));
  tenant.refuse("DELETE", new RegExp(`/site-lists/${warn.id}$`), 403);
  const undone = await undoLists(dataDir, tenant, T);
  assert.deepEqual(undone.lists.map((l) => [l.status, l.readBack, l.error]), [
    ["not confirmed", `not read: ${UNAVAILABLE}`, undefined],
    ["delete failed", "matches", "Sophos API error 403: Forbidden"],
  ]);
  assert.ok(!tenant.lists.has(block.id), "Sophos deleted the first");
});

// ---------- the audit: the build and its rollback ----------

/** A classic policy with a tag and an entry for it, so the design has a site list, a profile and the pilot. */
function classicTenant() {
  const tenant = new Tenant();
  const pol = wcPolicy({ id: randomUUID(), name: "Sales", priority: 1, settings: { "endpoint.web-control.tags.settings": { value: [{ tag: "staff", action: "block" }] } } });
  tenant.policies.set(pol.id, pol);
  const id = randomUUID();
  tenant.localSites.set(id, { id, url: "blocked.example.com", tags: ["staff"] });
  tenant.endpoints = [device("w1", "windows", "2026.2.2.1.0")];
  return tenant;
}

test("a build step Sophos made whose read-back failed is not read, and the build goes on from it", async () => {
  const dataDir = await dataDirFor("build");
  const tenant = classicTenant();
  const ctx = ctxOf(tenant);
  const { design } = await designFor(dataDir, ctx);
  const profile = design.profiles.find((p) => p.siteLists.length);
  assert.ok(profile, JSON.stringify(design.profiles));
  // Once the site list is made, its reads fail.
  tenant.refuse("GET", /\/site-lists\/[^/]+(\/sites)?$/, 503, () => tenant.lists.size > 0);
  const rec = await execute(dataDir, ctx, { profileKey: profile.key, enabled: false, targets: { endpoints: ["w1"] } }, TOOL);
  assert.equal(rec.status, "built", JSON.stringify(rec.steps.map((s) => [s.kind, s.status, s.error])));
  assert.deepEqual(rec.steps.map((s) => [s.kind, s.status, s.readBack]), [["site-list", "created", "not-read"], ["profile", "created", "matches"], ["policy", "created", "matches"]]);
  assert.equal(rec.steps[0].readBackNote, UNAVAILABLE);
});

test("a rollback delete Sophos accepted whose read-back couldn't read it is not confirmed, kept apart from a refused one", async () => {
  const dataDir = await dataDirFor("rollback");
  const tenant = new Tenant();
  const { policyId, profileId, listId, build } = seedPilot(tenant, dataDir);
  tenant.refuse("GET", new RegExp(`/policies/${policyId}$`), 503, afterWrite(tenant));
  tenant.refuse("DELETE", new RegExp(`/site-lists/${listId}$`), 403);
  const done = await rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false });
  assert.equal(done.status, "rollback-partial");
  assert.deepEqual(done.rollback.steps.map((s) => [s.kind, s.status]), [["policy", "not confirmed"], ["profile", "deleted, 404 on read-back"], ["site-list", "failed"]]);
  assert.match(done.rollback.steps[0].error, /^A read-back couldn't read it \(Sophos API error 503: ServiceUnavailable\), so it may still be there\.$/);
  const steps = Object.fromEntries(done.steps.map((s) => [s.kind, s]));
  assert.equal(steps.policy.status, "delete-failed");
  assert.equal(steps.policy.deleteReadBack, `not read: ${UNAVAILABLE}`, "accepted, not confirmed");
  assert.equal(steps["site-list"].deleteReadBack, undefined, "refused, so nothing to read back");
  assert.ok(!tenant.policies.has(policyId) && !tenant.profiles.has(profileId));
});

/** A snapshot with one Website Management entry, then the entry gone, and a build that used that snapshot. */
async function wmBuild(tenant, dataDir) {
  const id = randomUUID();
  tenant.localSites.set(id, { id, url: "kept.example.com", tags: ["staff"] });
  const r = await runReadiness(dataDir, tenant, { id: T, name: "Example Tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, TOOL);
  tenant.localSites.clear();
  const b = { id: randomUUID(), tenantId: T, tenantName: "Example Tenant", createdAt: new Date().toISOString(), status: "built", snapshotFile: r.snapshot.file, pilot: { profileKey: "k", name: "p", enabled: false, targets: {} }, steps: [], checks: [] };
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  writeFileSync(path.join(dataDir, "builds", T, `${b.id}.json`), JSON.stringify(b));
  return b;
}

test("a rollback reads Website Management back after restoring it: rolled back only when it matches the snapshot", async () => {
  const dataDir = await dataDirFor("rollback-wm");
  const good = new Tenant();
  const a = await wmBuild(good, dataDir);
  const done = await rollback(dataDir, ctxOf(good), a.id, { dryRun: false });
  assert.equal(done.status, "rolled-back", JSON.stringify(done.rollback.steps));
  assert.deepEqual(done.rollback.steps.map((s) => [s.name, s.status]), [["create kept.example.com", "done"], ["Website Management read back", "matches the snapshot"]]);

  // Sophos answers the create as made, but the entry never shows.
  const lost = new Tenant();
  const dir2 = await dataDirFor("rollback-wm2");
  const b = await wmBuild(lost, dir2);
  lost.forgetLocalSites = true;
  const partial = await rollback(dir2, ctxOf(lost), b.id, { dryRun: false });
  assert.equal(partial.status, "rollback-partial");
  assert.deepEqual(partial.rollback.steps.map((s) => [s.name, s.status]), [["create kept.example.com", "done"], ["Website Management read back", "not confirmed"]]);
  assert.match(partial.rollback.steps[1].error, /didn't read back as the snapshot has it/);
});

// ---------- the audit: retiring tags and the restore ----------

/** A tenant with a classic policy that uses one tag, two entries with it, and a rollback snapshot. */
async function retireTenant(dataDir) {
  const tenant = new Tenant();
  const pol = wcPolicy({ id: randomUUID(), name: "Sales", settings: { "endpoint.web-control.tags.settings": { value: [{ tag: "old", action: "allow" }, { tag: "keep", action: "block" }] } } });
  tenant.policies.set(pol.id, pol);
  for (const [url, tags] of [["a.example.com", ["old"]], ["b.example.com", ["old", "keep"]]]) {
    const id = randomUUID();
    tenant.localSites.set(id, { id, url, tags });
  }
  await runReadiness(dataDir, tenant, { id: T, name: "Example Tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, TOOL);
  return { tenant, pol };
}

test("a retire step Sophos accepted whose read-back couldn't read it is 'not read' with a plain reason, not 'tags differ'", async () => {
  const dataDir = await dataDirFor("retire");
  const { tenant, pol } = await retireTenant(dataDir);
  tenant.refuse("GET", new RegExp(`/policies/${pol.id}$`), 503, afterWrite(tenant));
  const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
  // From v0.3.20 (category D) the step is kept as unconfirmed and the retire goes on.
  assert.equal(rec.status, "partial");
  assert.deepEqual([rec.steps[0].status, rec.steps[0].readBack, rec.steps[0].error], ["unconfirmed", `not read: ${UNAVAILABLE}`, "The tool couldn't read it back, so the change isn't confirmed."]);
  assert.deepEqual(tenant.policies.get(pol.id).settings["endpoint.web-control.tags.settings"].value, [{ tag: "keep", action: "block" }], "Sophos made the change");
});

test("a retired entry whose read-back after the delete answers other than 404 is 'not read', not 'still there'", async () => {
  const dataDir = await dataDirFor("retire-del");
  const { tenant } = await retireTenant(dataDir);
  tenant.refuse("GET", /\/local-sites\/[^/]+$/, 503, () => tenant.calls.some((c) => c.startsWith("DELETE ")));
  const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
  const del = rec.steps.find((s) => s.op === "delete-entry");
  assert.deepEqual([del.status, del.readBack, del.error], ["unconfirmed", `not read: ${UNAVAILABLE}`, "The tool couldn't read it back, so the change isn't confirmed."]);
});

test("a restore keeps only its own read-back: a re-created entry it couldn't read back is not confirmed, not failed with the read's error", async () => {
  const dataDir = await dataDirFor("restore");
  const { tenant } = await retireTenant(dataDir);
  const ctx = ctxOf(tenant);
  const rec = await retire(dataDir, ctx, ["old"], true, TOOL);
  assert.equal(rec.status, "retired", JSON.stringify(rec.steps));
  const writes = tenant.writes;
  tenant.refuse("GET", /\/local-sites\/[^/]+$/, 503, () => tenant.writes > writes);
  const back = await restoreRetire(dataDir, ctx, rec.id);
  const del = back.steps.find((s) => s.op === "delete-entry");
  assert.deepEqual([del.status, del.readBack, del.error], ["restore-failed", `not read: ${UNAVAILABLE}`, "The tool couldn't read it back, so the restore isn't confirmed."]);
  assert.ok([...tenant.localSites.values()].some((s) => s.url === "a.example.com"), "Sophos re-created it");
  const pol = back.steps.find((s) => s.op === "policy-tags");
  assert.deepEqual([pol.status, pol.readBack, pol.error], ["restored", "tags match", undefined]);
});

// ---------- the audit: Compare with snapshot ----------

test("the snapshot comparison names the sections it couldn't compare, so a match isn't claimed for them", async () => {
  const dataDir = await dataDirFor("diff");
  const tenant = new Tenant();
  const id = randomUUID();
  tenant.localSites.set(id, { id, url: "kept.example.com", tags: ["staff"] });
  const r = await runReadiness(dataDir, tenant, { id: T, name: "Example Tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, TOOL);
  const snap = JSON.parse(readFileSync(path.join(dataDir, "snapshots", T, r.snapshot.file), "utf8"));
  const same = compareToSnapshot(snap, snap);
  assert.deepEqual([same.matches, same.identical, same.unread], [true, true, []]);
  const unread = structuredClone(snap);
  unread.objects.websiteManagement = null;
  unread.objects.webScanningExclusions = null;
  const d = compareToSnapshot(snap, unread);
  assert.deepEqual(d.unread, ["websiteManagement", "webScanningExclusions"]);
  assert.equal(d.othersCount, 0, "a section not read isn't counted as removed by someone else");
});

// ---------- item 5: dead code and styles ----------

test("the migration tool's dead page helpers and styles are gone, and every class the styles name is one a page renders", () => {
  const ui = readFileSync(path.join(root, "frontend/js/ui.js"), "utf8");
  for (const name of ["stackBar", "onDestCell", "ON_DEST_HEADER", "rowMenu", "wireRowMenus", "outcomeOf", "notesOf", "countOutcomes", "export function tag("]) assert.ok(!ui.includes(name), name);
  const css = ["base.css", "app.css", "components.css"].map((f) => readFileSync(path.join(root, "frontend/css", f), "utf8")).join("\n");
  assert.doesNotMatch(css, /\.job-status-cell|\.ep-error|\.migrate-grid|\.lane-|\.monitor-|\.pal-|\.compare-pill|\.row-menu|\.stack-bar/);
  const pages = [...readdirSync(path.join(root, "frontend")).filter((f) => f.endsWith(".html")).map((f) => path.join(root, "frontend", f)), ...readdirSync(path.join(root, "frontend/js")).map((f) => path.join(root, "frontend/js", f))].map((f) => readFileSync(f, "utf8")).join("\n");
  // Built from a variable: toast-${variant}, banner-${variant} and sev-${group}.
  const built = /^(toast-(ok|warn|err|info)|banner-err|sev-(fix|plan|info))$/;
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^{}]*\}/g, "{}").replace(/\[[^\]]*\]/g, "");
  const names = new Set([...selectors.matchAll(/[.#](-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const unrendered = [...names].filter((n) => !built.test(n) && !new RegExp(`(?<![\\w-])${n}(?![\\w-])`).test(pages));
  assert.deepEqual(unrendered, []);
});
