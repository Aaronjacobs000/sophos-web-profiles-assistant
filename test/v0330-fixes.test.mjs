// v0.3.30, in what the services record. A wave's Undo and an Allow's Undo
// saved only after their write, so a server that stopped mid-write left the
// row as it was (Moved, Added) though the undo went through, and the next Undo
// errored: the wave's said the assignment had changed, the Allow's got a 404.
// A build rollback saved only once it was done, and a retire's Restore after
// each write, so a stop left the build Built and the retire Retired. Each
// write is now marked as sending, and saved, before it goes, as a build step
// is (v0.3.27), and read back as not confirmed: the next Undo, rollback or
// Restore looks first, and records the work as done when it finds it done.
// The server stopping is a write held in flight that never answers, with the
// records read from disk as a server started again would read them. Each
// case runs against an in-memory tenant (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { ALREADY_BEFORE, moveWave, promotionView, undoWave } from "../backend/dist/services/promote-service.js";
import { addAllow, loadPilotRecord, undoAllow } from "../backend/dist/services/pilot-service.js";
import { getBuild, rollback } from "../backend/dist/services/build-service.js";
import { listRecords, restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { runReadiness } from "../backend/dist/services/readiness.js";
import { T, TOOL, Tenant, afterWrite, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";

const POLICY = /\/policies\/[^/]+$/;
const PROFILE = /\/profiles\/[^/]+$/;
const LIST = /\/site-lists\/[^/]+$/;
const LISTS = /\/site-lists$/;
const SITE = /\/site-lists\/[^/]+\/sites\/[^/]+$/;
const ENTRIES = /\/local-sites$/;
const ANSWER = "The tool stopped before it saved what Sophos answered";
const UNREAD = "not read: none was saved";

before(() => setReadBackDelays([0, 0]));

/**
 * The first write of method that matches is made (or not, with made false) and never answered, as when the server stops
 * while it's in flight. Resolves once it's held. Other writes go through.
 */
function hold(tenant, method, pattern, { made = true } = {}) {
  let held;
  const holding = new Promise((resolve) => (held = resolve));
  const real = tenant.tenantRequest.bind(tenant);
  let on = true;
  tenant.tenantRequest = async (tenantId, p, o = {}) => {
    if (!on || (o.method ?? "GET") !== method || !pattern.test(p)) return real(tenantId, p, o);
    on = false;
    if (made) await real(tenantId, p, o);
    else tenant.calls.push(`${method} ${p}`);
    held();
    return new Promise(() => {});
  };
  return holding;
}

const count = (tenant, method, pattern) => tenant.calls.filter((c) => c.startsWith(`${method} `) && pattern.test(c.slice(method.length + 1))).length;

// ---------- item 1: a wave's Undo ----------

const rawWaves = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, "promote", `${T}.json`), "utf8")).waves;
const UNDO_IN_FLIGHT = { status: "undo-failed", readBack: "assignment matches", undoAnswer: ANSWER, undoReadBack: UNREAD, error: "The tool couldn't read the pilot policy back, so the undo isn't confirmed.", undoSending: undefined };
const waveRow = (w) => ({ status: w.status, readBack: w.readBack, undoAnswer: w.undoAnswer, undoReadBack: w.undoReadBack, error: w.error, undoSending: w.undoSending });

/** A built pilot on w1, w2 moved onto it, and the wave's Undo stopped while its assignment change is held. */
async function stoppedWaveUndo(name, opts) {
  const dataDir = await dataDirFor(name);
  const tenant = new Tenant();
  const seeded = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const wave = await moveWave(dataDir, ctx, ["w2"], false);
  assert.equal(wave.status, "moved");
  const holding = hold(tenant, "PATCH", POLICY, opts);
  // Never answers: the server stopped while the change was out.
  void undoWave(dataDir, ctx, wave.id);
  await holding;
  return { dataDir, tenant, ctx, wave, ...seeded };
}

test("Wave Undo: marked and saved before its change goes; read back, the undo is not confirmed, and Undo is offered again", async () => {
  const s = await stoppedWaveUndo("v0330-wave-mark");
  assert.deepEqual(rawWaves(s.dataDir).map((w) => [w.status, w.undoSending ?? false]), [["moved", true]], "saved before the change went");
  const view = await promotionView(s.dataDir, s.ctx, null);
  assert.deepEqual(view.waves.map(waveRow), [UNDO_IN_FLIGHT]);
});

test("Wave Undo: an undo in flight when the server stopped, which Sophos made, is finished by Undo again: it reads the devices back, records the wave undone and says so, with nothing sent", async () => {
  const s = await stoppedWaveUndo("v0330-wave-made");
  assert.deepEqual(s.tenant.policies.get(s.policyId).appliesTo.endpoints, ["w1"], "Sophos put it back");
  const sent = count(s.tenant, "PATCH", POLICY);
  const again = await undoWave(s.dataDir, s.ctx, s.wave.id);
  assert.deepEqual([again.status, again.readBack, again.error], ["undone", ALREADY_BEFORE, undefined]);
  assert.equal(count(s.tenant, "PATCH", POLICY), sent, "nothing sent");
  assert.deepEqual(rawWaves(s.dataDir).map((w) => [w.status, "undoSending" in w]), [["undone", false]]);
});

test("Wave Undo: an undo in flight when the server stopped, which Sophos didn't make, is not confirmed, and Undo again moves the devices back", async () => {
  const s = await stoppedWaveUndo("v0330-wave-unmade", { made: false });
  assert.deepEqual(s.tenant.policies.get(s.policyId).appliesTo.endpoints, ["w1", "w2"]);
  assert.deepEqual((await promotionView(s.dataDir, s.ctx, null)).waves.map(waveRow), [UNDO_IN_FLIGHT]);
  const sent = count(s.tenant, "PATCH", POLICY);
  const again = await undoWave(s.dataDir, s.ctx, s.wave.id);
  assert.deepEqual([again.status, again.readBack], ["undone", "assignment back as before the wave"]);
  assert.equal(count(s.tenant, "PATCH", POLICY), sent + 1);
  assert.deepEqual(s.tenant.policies.get(s.policyId).appliesTo.endpoints, ["w1"]);
});

test("Wave Undo: once its outcome is recorded, the record keeps no undo mark: undone, refused, or not confirmed after a 5xx", async () => {
  const runs = {};
  for (const how of ["undone", "refused", "unclear"]) {
    const dataDir = await dataDirFor(`v0330-wave-clear-${how}`);
    const tenant = new Tenant();
    seedPilot(tenant, dataDir);
    const ctx = ctxOf(tenant);
    const wave = await moveWave(dataDir, ctx, ["w2"], false);
    if (how === "refused") tenant.refuse("PATCH", POLICY, 403);
    if (how === "unclear") {
      tenant.unclear("PATCH", POLICY);
      tenant.refuse("GET", POLICY, 503, afterWrite(tenant));
    }
    runs[how] = (await undoWave(dataDir, ctx, wave.id)).status;
    assert.deepEqual(rawWaves(dataDir).filter((w) => "undoSending" in w), [], `${how}: no undo mark left`);
  }
  assert.deepEqual(runs, { undone: "undone", refused: "undo-failed", unclear: "undo-failed" });
});

// ---------- item 2: an Allow's Undo ----------

const rawAllows = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, "pilot", `${T}.json`), "utf8")).allows;
const allowRow = (a) => ({ site: a.site, status: a.status, undoAnswer: a.undoAnswer, undoReadBack: a.undoReadBack, undoSending: a.undoSending });
const ALLOW_UNDO_IN_FLIGHT = { status: "undo-failed", undoAnswer: ANSWER, undoReadBack: UNREAD, undoSending: undefined };

/**
 * A built pilot with an Allow of chat.example.org (which made the pilot allows list), and video.example.net added to it
 * when site is true. Then an Undo, of video.example.net or of chat.example.org, stopped while the write that matches is held.
 */
async function stoppedAllowUndo(name, method, pattern, { site = false, made = true } = {}) {
  const dataDir = await dataDirFor(name);
  const tenant = new Tenant();
  const seeded = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const first = (await addAllow(dataDir, ctx, "chat.example.org")).entry;
  const entry = site ? (await addAllow(dataDir, ctx, "video.example.net")).entry : first;
  const holding = hold(tenant, method, pattern, { made });
  // Never answers: the server stopped while the write was out.
  void undoAllow(dataDir, ctx, entry.id);
  await holding;
  return { ...seeded, dataDir, tenant, ctx, entry, list: tenant.lists.get(first.listId), listId: first.listId };
}

test("Allow Undo: marked and saved before its write goes; read back, the undo is not confirmed, and Undo is offered again", async () => {
  const s = await stoppedAllowUndo("v0330-allow-mark", "DELETE", SITE, { site: true });
  assert.deepEqual(rawAllows(s.dataDir).map((a) => [a.site, a.status, a.undoSending ?? false]), [["video.example.net", "added", true], ["chat.example.org", "added", false]], "saved before the delete went");
  const rec = await loadPilotRecord(s.dataDir, T);
  assert.deepEqual(rec.allows.map(allowRow), [{ site: "video.example.net", ...ALLOW_UNDO_IN_FLIGHT }, { site: "chat.example.org", status: "added", undoAnswer: undefined, undoReadBack: undefined, undoSending: undefined }]);
});

test("Allow Undo: a site's removal in flight when the server stopped, which Sophos made, is finished by Undo again: it finds the site gone, records the entry undone and says so, with no 404", async () => {
  const s = await stoppedAllowUndo("v0330-allow-site", "DELETE", SITE, { site: true });
  assert.deepEqual(s.list.sites.map((x) => x.site), ["chat.example.org"], "Sophos removed it");
  const sent = count(s.tenant, "DELETE", SITE);
  const again = await undoAllow(s.dataDir, s.ctx, s.entry.id);
  assert.deepEqual([again.status, again.undo, again.error], ["undone", ["Site removed, confirmed on read-back."], undefined]);
  assert.equal(count(s.tenant, "DELETE", SITE), sent, "nothing sent");
});

test("Allow Undo: the list's delete in flight when the server stopped, which Sophos made, is finished by Undo again: it finds the list gone (404), records the entry and the build's step, and says so", async () => {
  const s = await stoppedAllowUndo("v0330-allow-list", "DELETE", LIST);
  assert.equal(s.tenant.lists.has(s.listId), false, "Sophos deleted it");
  assert.deepEqual((await loadPilotRecord(s.dataDir, T)).allows.map(allowRow), [{ site: "chat.example.org", ...ALLOW_UNDO_IN_FLIGHT }]);
  const again = await undoAllow(s.dataDir, s.ctx, s.entry.id);
  assert.deepEqual([again.status, again.undo, again.error], ["undone", ["List deleted, 404 on read-back."], undefined]);
  assert.equal((await getBuild(s.dataDir, T, s.build.id)).steps.find((x) => x.id === s.listId)?.status, "deleted");
});

test("Allow Undo: the list's unlink from the profile in flight when the server stopped is not confirmed, and Undo again deletes the list", async () => {
  const s = await stoppedAllowUndo("v0330-allow-unlink", "PUT", PROFILE);
  assert.ok(!(s.tenant.profiles.get(s.profileId).siteListActions ?? []).some((a) => a.id === s.listId), "Sophos unlinked it");
  assert.deepEqual((await loadPilotRecord(s.dataDir, T)).allows.map(allowRow), [{ site: "chat.example.org", ...ALLOW_UNDO_IN_FLIGHT }]);
  const again = await undoAllow(s.dataDir, s.ctx, s.entry.id);
  assert.deepEqual([again.status, again.undo], ["undone", ["List deleted, 404 on read-back."]]);
  assert.equal(s.tenant.lists.has(s.listId), false);
});

test("Allow Undo: once its outcome is recorded, the record keeps no undo mark: undone, refused, or not confirmed after a 5xx", async () => {
  const runs = {};
  for (const how of ["undone", "refused", "unclear"]) {
    const dataDir = await dataDirFor(`v0330-allow-clear-${how}`);
    const tenant = new Tenant();
    seedPilot(tenant, dataDir);
    const ctx = ctxOf(tenant);
    await addAllow(dataDir, ctx, "chat.example.org");
    const { entry } = await addAllow(dataDir, ctx, "video.example.net");
    if (how === "refused") tenant.refuse("DELETE", SITE, 403);
    if (how === "unclear") {
      tenant.unclear("DELETE", SITE);
      tenant.refuse("GET", /\/sites$/, 503, afterWrite(tenant));
    }
    runs[how] = (await undoAllow(dataDir, ctx, entry.id)).status;
    assert.deepEqual(rawAllows(dataDir).filter((a) => "undoSending" in a), [], `${how}: no undo mark left`);
  }
  assert.deepEqual(runs, { undone: "undone", refused: "undo-failed", unclear: "undo-failed" });
});

// ---------- other undo paths: a build rollback ----------

const rawBuild = (dataDir, id) => JSON.parse(readFileSync(path.join(dataDir, "builds", T, `${id}.json`), "utf8"));
const DELETE_IN_FLIGHT = `${ANSWER}. A read-back couldn't read it (none was saved), so it may still be there.`;

/** A built pilot, and its rollback stopped while the profile's delete (after the policy's) is held. */
async function stoppedRollback(name, opts) {
  const dataDir = await dataDirFor(name);
  const tenant = new Tenant();
  const seeded = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const holding = hold(tenant, "DELETE", PROFILE, opts);
  void rollback(dataDir, ctx, seeded.build.id, { dryRun: false });
  await holding;
  return { dataDir, tenant, ctx, ...seeded };
}

test("Rollback: each delete is marked, and the rollback saved, before it goes; read back, the one in flight is not confirmed, what was deleted is on record, and the rollback didn't finish", async () => {
  const s = await stoppedRollback("v0330-rollback-mark");
  const raw = rawBuild(s.dataDir, s.build.id);
  assert.equal(raw.status, "rollback-partial");
  assert.deepEqual(raw.steps.map((x) => [x.kind, x.status, x.sending ?? false]), [["site-list", "created", false], ["profile", "created", true], ["policy", "deleted", false]], "saved before the delete went");
  const b = await getBuild(s.dataDir, T, s.build.id);
  assert.equal(b.status, "rollback-partial");
  assert.deepEqual(b.steps.map((x) => [x.kind, x.status, x.deleteReadBack ?? null, x.deleteAnswer ?? null, "sending" in x]), [
    ["site-list", "created", null, null, false],
    ["profile", "delete-failed", UNREAD, ANSWER, false],
    ["policy", "deleted", null, null, false],
  ]);
  assert.deepEqual(b.rollback.steps.map((x) => [x.kind, x.status, x.error ?? null]), [["policy", "deleted, 404 on read-back", null], ["profile", "not confirmed", DELETE_IN_FLIGHT]]);
});

test("Rollback: a delete in flight when the server stopped, which Sophos made, is found gone (404) when it's rolled back again, which records it and finishes", async () => {
  const s = await stoppedRollback("v0330-rollback-made");
  assert.equal(s.tenant.profiles.has(s.profileId), false, "Sophos deleted it");
  const again = await rollback(s.dataDir, s.ctx, s.build.id, { dryRun: false });
  assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback.steps));
  assert.deepEqual(again.rollback.steps.map((x) => [x.kind, x.status]), [["profile", "deleted, 404 on read-back"], ["site-list", "deleted, 404 on read-back"]]);
  assert.deepEqual(again.steps.map((x) => x.status), ["deleted", "deleted", "deleted"]);
  const audit = readFileSync(path.join(s.dataDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(audit.findLast((e) => e.resourceId === s.profileId)?.detail?.note, "Sophos answered 404, so it was already gone, and a read-back found it gone (404)");
});

test("Rollback: a delete in flight when the server stopped, which Sophos didn't make, is sent again when it's rolled back again", async () => {
  const s = await stoppedRollback("v0330-rollback-unmade", { made: false });
  assert.equal(s.tenant.profiles.has(s.profileId), true);
  assert.equal((await getBuild(s.dataDir, T, s.build.id)).steps[1].status, "delete-failed");
  const again = await rollback(s.dataDir, s.ctx, s.build.id, { dryRun: false });
  assert.equal(again.status, "rolled-back");
  assert.equal(s.tenant.profiles.has(s.profileId), false);
});

/** A snapshot with one Website Management entry, then the entry gone, and a build that used that snapshot. */
async function wmBuild(name) {
  const dataDir = await dataDirFor(name);
  const tenant = new Tenant();
  const id = randomUUID();
  tenant.localSites.set(id, { id, url: "kept.example.com", tags: ["staff"] });
  const r = await runReadiness(dataDir, tenant, { id: T, name: "Example Tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, TOOL);
  tenant.localSites.clear();
  const b = { id: randomUUID(), tenantId: T, tenantName: "Example Tenant", createdAt: new Date().toISOString(), status: "built", snapshotFile: r.snapshot.file, pilot: { profileKey: "k", name: "p", enabled: false, targets: {} }, steps: [], checks: [] };
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  writeFileSync(path.join(dataDir, "builds", T, `${b.id}.json`), JSON.stringify(b));
  return { dataDir, tenant, ctx: ctxOf(tenant), build: b };
}

test("Rollback: a Website Management change in flight when the server stopped is not confirmed, and rolling back again finds it made, or makes it", async () => {
  for (const made of [true, false]) {
    const s = await wmBuild(`v0330-rollback-wm-${made}`);
    const holding = hold(s.tenant, "POST", ENTRIES, { made });
    void rollback(s.dataDir, s.ctx, s.build.id, { dryRun: false });
    await holding;
    const b = await getBuild(s.dataDir, T, s.build.id);
    assert.equal(b.status, "rollback-partial");
    assert.deepEqual(b.rollback.steps, [{ kind: "website-management", name: "create kept.example.com", status: "not confirmed", answer: ANSWER, error: `${ANSWER}. A read-back couldn't read Website Management (none was saved), so the change isn't confirmed.` }]);
    const sent = count(s.tenant, "POST", ENTRIES);
    const again = await rollback(s.dataDir, s.ctx, s.build.id, { dryRun: false });
    assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback.steps));
    assert.equal(count(s.tenant, "POST", ENTRIES), made ? sent : sent + 1, made ? "found made, nothing sent" : "made now");
    assert.deepEqual([...s.tenant.localSites.values()].map((x) => x.url), ["kept.example.com"]);
  }
});

test("Rollback: one stopped while deleting an Allow's list it found by name deletes it once when run again, and the Allow says it was found", async () => {
  const dataDir = await dataDirFor("v0330-rollback-asked");
  const tenant = new Tenant();
  const { build } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  // The Allow's new list is made, answered 500, and the site lists can't be read after: unconfirmed, with no id.
  tenant.unclear("POST", LISTS);
  tenant.refuse("GET", LISTS, 503, afterWrite(tenant));
  const asked = (await addAllow(dataDir, ctx, "chat.example.org")).entry;
  assert.deepEqual([asked.status, asked.listId], ["unconfirmed", undefined]);
  tenant.rules.length = 0;
  const listId = [...tenant.lists.values()].find((l) => l.name === "Example pilot allows").id;
  const holding = hold(tenant, "DELETE", new RegExp(`/site-lists/${listId}$`));
  void rollback(dataDir, ctx, build.id, { dryRun: false });
  await holding;
  const stopped = await getBuild(dataDir, T, build.id);
  assert.equal(stopped.status, "rollback-partial");
  assert.deepEqual(stopped.steps.filter((x) => x.name === "Example pilot allows").map((x) => [x.status, x.id]), [["delete-failed", listId]]);
  const again = await rollback(dataDir, ctx, build.id, { dryRun: false });
  assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback.steps));
  assert.deepEqual(again.steps.filter((x) => x.name === "Example pilot allows").map((x) => [x.status, x.id]), [["deleted", listId]], "one step for the list");
  const [entry] = (await loadPilotRecord(dataDir, T)).allows;
  assert.deepEqual([entry.status, entry.listId, entry.undo], ["undone", listId, ["The list was found by name.", "List deleted with the build, 404 on read-back."]]);
});

test("Rollback: once each outcome is recorded, the build keeps no sending mark: rolled back, a delete refused, or one not confirmed after a 5xx", async () => {
  const runs = {};
  for (const how of ["done", "refused", "unclear"]) {
    const dataDir = await dataDirFor(`v0330-rollback-clear-${how}`);
    const tenant = new Tenant();
    const { build } = seedPilot(tenant, dataDir);
    if (how === "refused") tenant.refuse("DELETE", PROFILE, 403);
    if (how === "unclear") {
      tenant.unclear("DELETE", PROFILE);
      tenant.refuse("GET", PROFILE, 503, afterWrite(tenant, 1));
    }
    runs[how] = (await rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false })).status;
    const raw = rawBuild(dataDir, build.id);
    assert.deepEqual([...raw.steps, ...raw.rollback.steps].filter((x) => "sending" in x), [], `${how}: no sending mark left`);
  }
  assert.deepEqual(runs, { done: "rolled-back", refused: "rollback-partial", unclear: "rollback-partial" });
});

// ---------- other undo paths: a retire's Restore ----------

const rawRetire = (dataDir) => {
  const d = path.join(dataDir, "retire", T);
  return JSON.parse(readFileSync(path.join(d, readdirSync(d)[0]), "utf8"));
};
const stepRow = (x) => [x.op, x.url ?? x.policyName, x.status, x.answer ?? null, x.readBack ?? null, x.error ?? null];
const RESTORE_IN_FLIGHT = [ANSWER, UNREAD, "The tool couldn't read it back, so the restore isn't confirmed."];

/** A retire of old, done, and its Restore stopped while the write that matches is held. */
async function stoppedRestore(name, method, pattern, opts) {
  const dataDir = await dataDirFor(name);
  const { tenant, pol } = await retireTenant(dataDir);
  const ctx = ctxOf(tenant);
  const rec = await retire(dataDir, ctx, ["old"], true, TOOL);
  assert.equal(rec.status, "retired");
  const holding = hold(tenant, method, pattern, opts);
  void restoreRetire(dataDir, ctx, rec.id);
  await holding;
  return { dataDir, tenant, ctx, pol, rec };
}
const entries = (tenant) => [...tenant.localSites.values()].map((s) => `${s.url} [${s.tags.join(",")}]`).sort();

test("Restore: each write is marked, and the restore saved, before it goes; read back, the one in flight is not confirmed, and the restore didn't finish", async () => {
  const s = await stoppedRestore("v0330-restore-mark", "POST", ENTRIES);
  const raw = rawRetire(s.dataDir);
  assert.equal(raw.status, "restore-partial");
  assert.deepEqual(raw.steps.map((x) => [x.op, x.status, x.sending ?? false]), [["policy-tags", "done", false], ["delete-entry", "done", true], ["patch-entry", "done", false]], "saved before the create went");
  const [r] = await listRecords(s.dataDir, T);
  assert.equal(r.status, "restore-partial");
  assert.deepEqual(r.steps.map(stepRow), [
    ["policy-tags", "Sales", "done", null, "tags match", null],
    ["delete-entry", "a.example.com", "restore-failed", ...RESTORE_IN_FLIGHT],
    ["patch-entry", "b.example.com", "done", null, "tags match", null],
  ]);
  assert.ok(r.steps.every((x) => !("sending" in x)));
});

test("Restore: an entry's re-create in flight when the server stopped, which Sophos made, is found by Restore again and left, which says so", async () => {
  const s = await stoppedRestore("v0330-restore-made", "POST", ENTRIES);
  const made = [...s.tenant.localSites.values()].find((x) => x.url === "a.example.com");
  assert.ok(made, "Sophos re-created it");
  const sent = count(s.tenant, "POST", ENTRIES);
  const again = await restoreRetire(s.dataDir, s.ctx, s.rec.id);
  assert.equal(count(s.tenant, "POST", ENTRIES), sent, "no create sent");
  assert.equal(again.status, "restored");
  assert.deepEqual(again.steps.map((x) => [x.op, x.status, x.readBack]), [["policy-tags", "restored", "tags match"], ["delete-entry", "restored", "already there"], ["patch-entry", "restored", "tags match"]]);
  assert.equal(again.steps[1].newId, made.id);
  assert.deepEqual(entries(s.tenant), ["a.example.com [old]", "b.example.com [old,keep]"]);
});

test("Restore: a policy's tags in flight when the server stopped are not confirmed, with the entries before it restored, and Restore again puts them back", async () => {
  const s = await stoppedRestore("v0330-restore-tags", "PATCH", POLICY, { made: false });
  const [r] = await listRecords(s.dataDir, T);
  assert.equal(r.status, "restore-partial");
  assert.deepEqual(r.steps.map(stepRow), [
    ["policy-tags", "Sales", "restore-failed", ...RESTORE_IN_FLIGHT],
    ["delete-entry", "a.example.com", "restored", null, "re-created, matches", null],
    ["patch-entry", "b.example.com", "restored", null, "tags match", null],
  ]);
  const again = await restoreRetire(s.dataDir, s.ctx, s.rec.id);
  assert.equal(again.status, "restored");
  assert.deepEqual(s.tenant.policies.get(s.pol.id).settings["endpoint.web-control.tags.settings"].value.map((x) => x.tag), ["old", "keep"]);
});

test("Restore: once a step's outcome is recorded, the record keeps no sending mark: restored, refused, or not confirmed after a 5xx", async () => {
  const runs = {};
  for (const how of ["done", "refused", "unclear"]) {
    const dataDir = await dataDirFor(`v0330-restore-clear-${how}`);
    const { tenant } = await retireTenant(dataDir);
    const ctx = ctxOf(tenant);
    const rec = await retire(dataDir, ctx, ["old"], true, TOOL);
    if (how === "refused") tenant.refuse("PATCH", POLICY, 403);
    if (how === "unclear") {
      tenant.unclear("PATCH", POLICY);
      tenant.refuse("GET", POLICY, 503, afterWrite(tenant, tenant.writes + 2));
    }
    const r = await restoreRetire(dataDir, ctx, rec.id);
    runs[how] = r.steps.map((x) => x.status);
    assert.deepEqual(rawRetire(dataDir).steps.filter((x) => "sending" in x), [], `${how}: no sending mark left`);
  }
  assert.deepEqual(runs, { done: ["restored", "restored", "restored"], refused: ["restore-failed", "restored", "restored"], unclear: ["restore-failed", "restored", "restored"] });
});
