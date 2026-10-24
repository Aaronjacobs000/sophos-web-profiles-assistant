// v0.3.29, in what the services record. A retire saved each step only after
// its write, so a server that stopped mid-write left the step planned, and
// Restore skips a planned step: an entry whose delete was in flight wasn't
// re-created, and a policy's tag change or an entry's untag wasn't put back.
// A promotion wave was saved only after its assignment change, so a stop left
// the devices on the pilot with no wave on record and nothing to undo. Each
// write is now marked as sending, and saved, before it goes, as a build step
// is (v0.3.27), and read back as not confirmed: Restore looks the entry up
// and re-creates it only when it's gone, and Undo reads the assignment first.
// The server stopping is a write held in flight that never answers, with the
// records read from disk as a server started again would read them. Each
// case runs against an in-memory tenant (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { listRecords, restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { ALREADY_BEFORE, moveWave, promotionView, undoWave } from "../backend/dist/services/promote-service.js";
import { T, TOOL, Tenant, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";

const ENTRY = /\/local-sites\/[^/]+$/;
const POLICY = /\/policies\/[^/]+$/;
const ANSWER = "The tool stopped before it saved what Sophos answered";
const UNREAD = "not read: none was saved";
const TAGS = "endpoint.web-control.tags.settings";

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

const entries = (tenant) => [...tenant.localSites.values()].map((s) => `${s.url} [${s.tags.join(",")}]`).sort();
const tagsOf = (tenant, pol) => tenant.policies.get(pol.id).settings[TAGS].value.map((x) => x.tag);
const count = (tenant, call) => tenant.calls.filter((c) => c.startsWith(call)).length;

// ---------- item 1: a retire ----------

const rawRetire = (dataDir) => {
  const d = path.join(dataDir, "retire", T);
  return JSON.parse(readFileSync(path.join(d, readdirSync(d)[0]), "utf8"));
};
const stepRow = (s) => [s.op, s.url ?? s.policyName, s.status, s.answer ?? null, s.readBack ?? null, s.error ?? null];

/** A tenant with tag old on a policy and two entries, and a retire of old stopped while the write that matches is held. */
async function stoppedRetire(name, method, pattern, opts) {
  const dataDir = await dataDirFor(name);
  const { tenant, pol } = await retireTenant(dataDir);
  const ctx = ctxOf(tenant);
  const holding = hold(tenant, method, pattern, opts);
  // Never answers: the server stopped while the write was out.
  void retire(dataDir, ctx, ["old"], true, TOOL);
  await holding;
  return { dataDir, tenant, pol, ctx };
}

test("Retire: each step is saved before its write goes, marked as sending; read back, the one in flight is not confirmed, and the retire didn't finish", async () => {
  const s = await stoppedRetire("v0329-retire-mark", "DELETE", ENTRY);
  assert.deepEqual(rawRetire(s.dataDir).steps.map((x) => [x.op, x.status, x.sending ?? false]), [["policy-tags", "done", false], ["delete-entry", "planned", true], ["patch-entry", "planned", false]], "saved before the delete went");
  const [rec] = await listRecords(s.dataDir, T);
  assert.equal(rec.status, "partial");
  assert.deepEqual(rec.steps.map(stepRow), [
    ["policy-tags", "Sales", "done", null, "tags match", null],
    ["delete-entry", "a.example.com", "unconfirmed", ANSWER, UNREAD, "The tool couldn't read it back, so the change isn't confirmed."],
    ["patch-entry", "b.example.com", "planned", null, null, null],
  ]);
  assert.ok(rec.steps.every((x) => !("sending" in x)));
});

test("Retire: an entry's delete in flight when the server stopped, which Sophos made, is re-created by Restore from the record", async () => {
  const s = await stoppedRetire("v0329-retire-delete-made", "DELETE", ENTRY);
  assert.deepEqual(entries(s.tenant), ["b.example.com [old,keep]"], "Sophos deleted it");
  const [rec] = await listRecords(s.dataDir, T);
  const restored = await restoreRetire(s.dataDir, s.ctx, rec.id);
  assert.equal(restored.status, "restored");
  assert.deepEqual(restored.steps.map((x) => [x.op, x.status, x.readBack ?? null]), [["policy-tags", "restored", "tags match"], ["delete-entry", "restored", "re-created, matches"], ["patch-entry", "planned", null]]);
  assert.deepEqual(entries(s.tenant), ["a.example.com [old]", "b.example.com [old,keep]"]);
  assert.deepEqual(tagsOf(s.tenant, s.pol), ["old", "keep"]);
});

test("Retire: an entry's delete in flight when the server stopped, which Sophos didn't make, is found by Restore and left, which says so", async () => {
  const s = await stoppedRetire("v0329-retire-delete-unmade", "DELETE", ENTRY, { made: false });
  const before = [...s.tenant.localSites.values()].find((x) => x.url === "a.example.com");
  assert.ok(before, "still there");
  const [rec] = await listRecords(s.dataDir, T);
  assert.equal(rec.steps[1].status, "unconfirmed");
  const sent = count(s.tenant, "POST /endpoint/v1/settings/web-control/local-sites");
  const restored = await restoreRetire(s.dataDir, s.ctx, rec.id);
  assert.equal(count(s.tenant, "POST /endpoint/v1/settings/web-control/local-sites"), sent, "no create sent");
  assert.deepEqual([restored.steps[1].status, restored.steps[1].readBack, restored.steps[1].newId], ["restored", "already there", before.id]);
  assert.equal(restored.status, "restored");
  assert.deepEqual(entries(s.tenant), ["a.example.com [old]", "b.example.com [old,keep]"]);
});

test("Retire: a policy's tag change, or an entry's untag, in flight when the server stopped is not confirmed, and Restore puts it back", async () => {
  const tags = await stoppedRetire("v0329-retire-tags", "PATCH", POLICY);
  assert.deepEqual(tagsOf(tags.tenant, tags.pol), ["keep"], "Sophos took the tag out");
  const [t1] = await listRecords(tags.dataDir, T);
  assert.deepEqual(t1.steps.map((x) => [x.op, x.status]), [["policy-tags", "unconfirmed"], ["delete-entry", "planned"], ["patch-entry", "planned"]]);
  assert.equal(t1.tagsMayRemain, undefined, "no entry was taken after it");
  const r1 = await restoreRetire(tags.dataDir, tags.ctx, t1.id);
  assert.deepEqual([r1.status, r1.steps[0].status, r1.steps[0].readBack], ["restored", "restored", "tags match"]);
  assert.deepEqual(tagsOf(tags.tenant, tags.pol), ["old", "keep"]);

  const untag = await stoppedRetire("v0329-retire-untag", "PATCH", ENTRY);
  assert.deepEqual(entries(untag.tenant), ["b.example.com [keep]"], "Sophos untagged it, after the delete");
  const [t2] = await listRecords(untag.dataDir, T);
  assert.deepEqual(t2.steps.map(stepRow)[2], ["patch-entry", "b.example.com", "unconfirmed", ANSWER, UNREAD, "The tool couldn't read it back, so the change isn't confirmed."]);
  const r2 = await restoreRetire(untag.dataDir, untag.ctx, t2.id);
  assert.deepEqual(r2.steps.map((x) => [x.op, x.status]), [["policy-tags", "restored"], ["delete-entry", "restored"], ["patch-entry", "restored"]]);
  assert.deepEqual(entries(untag.tenant), ["a.example.com [old]", "b.example.com [old,keep]"]);
});

test("Retire: once a step's outcome is recorded, the record keeps no sending mark: done, refused, or not confirmed after a 5xx", async () => {
  const runs = {};
  for (const how of ["done", "refused", "unclear"]) {
    const dataDir = await dataDirFor(`v0329-retire-clear-${how}`);
    const { tenant } = await retireTenant(dataDir);
    if (how === "refused") tenant.refuse("DELETE", ENTRY, 403);
    if (how === "unclear") {
      // The delete is the second write; only its read-back fails.
      tenant.unclear("DELETE", ENTRY);
      tenant.refuse("GET", ENTRY, 503, () => tenant.writes === 2);
    }
    const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
    runs[how] = rec.steps.map((x) => x.status);
    assert.deepEqual(rawRetire(dataDir).steps.filter((x) => "sending" in x), [], `${how}: no sending mark left`);
  }
  assert.deepEqual(runs, { done: ["done", "done", "done"], refused: ["done", "failed", "planned"], unclear: ["done", "unconfirmed", "done"] });
});

// ---------- item 2: a promotion wave ----------

const rawWaves = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, "promote", `${T}.json`), "utf8")).waves;
const waveRow = (w) => ({ status: w.status, devices: w.devices.map((d) => d.id), answer: w.answer, readBack: w.readBack, error: w.error, sending: w.sending });

/** A built pilot on w1, and a move of w2 onto it stopped while its assignment change is held. */
async function stoppedWave(name, opts) {
  const dataDir = await dataDirFor(name);
  const tenant = new Tenant();
  const seeded = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const holding = hold(tenant, "PATCH", POLICY, opts);
  // Never answers: the server stopped while the change was out.
  void moveWave(dataDir, ctx, ["w2"], false);
  await holding;
  return { dataDir, tenant, ctx, ...seeded };
}

const IN_FLIGHT_WAVE = { status: "unconfirmed", devices: ["w2"], answer: ANSWER, readBack: UNREAD, error: "The tool couldn't read the pilot policy back, so the move isn't confirmed.", sending: undefined };

test("Wave: saved before its assignment change goes, marked as sending; read back, it's not confirmed and can be undone", async () => {
  const s = await stoppedWave("v0329-wave-mark");
  assert.deepEqual(rawWaves(s.dataDir).map((w) => [w.devices.map((d) => d.id), w.sending ?? false]), [[["w2"], true]], "saved before the change went");
  const view = await promotionView(s.dataDir, s.ctx, null);
  assert.deepEqual(view.waves.map(waveRow), [IN_FLIGHT_WAVE]);
});

test("Wave: a move in flight when the server stopped, which Sophos made, is undone: Undo reads the assignment, and moves the devices back", async () => {
  const s = await stoppedWave("v0329-wave-made");
  assert.deepEqual(s.tenant.policies.get(s.policyId).appliesTo.endpoints, ["w1", "w2"], "Sophos moved it");
  const [wave] = (await promotionView(s.dataDir, s.ctx, null)).waves;
  const sent = count(s.tenant, "PATCH ");
  const undone = await undoWave(s.dataDir, s.ctx, wave.id);
  assert.deepEqual([undone.status, undone.readBack, undone.error], ["undone", "assignment back as before the wave", undefined]);
  assert.equal(count(s.tenant, "PATCH "), sent + 1);
  assert.deepEqual(s.tenant.policies.get(s.policyId).appliesTo.endpoints, ["w1"]);
});

test("Wave: a move in flight when the server stopped, which Sophos didn't make, is undone with nothing sent: Undo reads the assignment as before", async () => {
  const s = await stoppedWave("v0329-wave-unmade", { made: false });
  assert.deepEqual(s.tenant.policies.get(s.policyId).appliesTo.endpoints, ["w1"]);
  const view = await promotionView(s.dataDir, s.ctx, null);
  assert.deepEqual(view.waves.map(waveRow), [IN_FLIGHT_WAVE]);
  assert.deepEqual(view.plan.waves.flatMap((w) => w.devices.map((d) => d.id)), ["w2", "w3"], "w2 can be moved again");
  const sent = count(s.tenant, "PATCH ");
  const undone = await undoWave(s.dataDir, s.ctx, view.waves[0].id);
  assert.deepEqual([undone.status, undone.readBack], ["undone", ALREADY_BEFORE]);
  assert.equal(count(s.tenant, "PATCH "), sent, "nothing sent");
});

test("Wave: once its outcome is recorded, the record keeps no sending mark: moved, refused, or not confirmed after a 5xx", async () => {
  const runs = {};
  for (const how of ["moved", "refused", "unclear"]) {
    const dataDir = await dataDirFor(`v0329-wave-clear-${how}`);
    const tenant = new Tenant();
    seedPilot(tenant, dataDir);
    if (how === "refused") tenant.refuse("PATCH", POLICY, 403);
    if (how === "unclear") {
      tenant.unclear("PATCH", POLICY);
      tenant.refuse("GET", POLICY, 503, () => tenant.writes > 0);
    }
    runs[how] = (await moveWave(dataDir, ctxOf(tenant), ["w2"], false)).status;
    assert.deepEqual(rawWaves(dataDir).filter((w) => "sending" in w), [], `${how}: no sending mark left`);
  }
  assert.deepEqual(runs, { moved: "moved", refused: "failed", unclear: "unconfirmed" });
});
