// v0.3.10: a rollback delete that times out or loses the connection is read
// back like one Sophos answers with a 5xx, the audit log records what the
// read-back found, and the Pilot page says when the pilot policy is gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initState } from "../backend/dist/state.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { activePilot, readPilotPolicy } from "../backend/dist/services/pilot-service.js";
import { idsDeletedByTool, rollback } from "../backend/dist/services/build-service.js";
import { SophosClient } from "../backend/dist/sophos/client/sophos-client.js";
import express from "express";
import { pilotRouter } from "../backend/dist/routes/pilot.js";

const T = "00000000-0000-4000-a000-000000000001";
const HOST = "https://api-us01.central.sophos.com";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A connection Sophos dropped after the request went out, as fetch reports it. */
const dropped = () => new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });

/**
 * A tenant behind a mocked fetch, so the real Sophos client is used. deleteMode
 * per kind: "ok"; "500-made" or "500-not-made" (answers 500, with or without
 * deleting); "drop-made" or "drop-not-made" (the connection drops); and
 * "timeout-made" or "timeout-not-made" (no answer until the client gives up).
 */
class MockTenant {
  constructor() {
    this.policies = new Map();
    this.profiles = new Map();
    this.lists = new Map();
    this.sent = [];
    this.deleteMode = {};
    this.policyGetStatus = null;
  }
  inUse(kind, id) {
    if (kind === "profile") return [...this.policies.values()].some((p) => p.settings["endpoint.web-control.web-profile-id"]?.value === id);
    return [...this.profiles.values()].some((p) => (p.siteListActions ?? []).some((a) => a.id === id));
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const m = init.method ?? "GET";
    this.sent.push(`${m} ${u.pathname}`);
    const r = /^\/(endpoint\/v1\/policies|web-filters\/v1\/profiles|web-filters\/v1\/site-lists)\/([^/]+)$/.exec(u.pathname);
    if (r) {
      const kind = r[1].endsWith("policies") ? "policy" : r[1].endsWith("profiles") ? "profile" : "site-list";
      const store = kind === "policy" ? this.policies : kind === "profile" ? this.profiles : this.lists;
      if (kind === "policy" && m === "GET" && this.policyGetStatus) return json(this.policyGetStatus, { error: "Forbidden" });
      const obj = store.get(r[2]);
      if (!obj) return json(404, { error: "NotFound" });
      if (m === "GET") return json(200, obj);
      if (m === "DELETE") {
        const mode = this.deleteMode[kind] ?? "ok";
        if (kind !== "policy" && this.inUse(kind, obj.id)) return json(409, { error: "Conflict", message: "in use" });
        if (mode.endsWith("-made") && !mode.endsWith("not-made")) store.delete(obj.id);
        if (mode.startsWith("500")) return json(500, { error: "InternalServerError" });
        if (mode.startsWith("drop")) throw dropped();
        if (mode.startsWith("timeout")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
        store.delete(obj.id);
        return json(200, {});
      }
    }
    if (m !== "GET") return json(400, { error: `mock: no route for ${m} ${u.pathname}` });
    return json(200, { items: [], pages: { total: 1 } });
  }
}

const step = (order, kind, name, id) => ({ order, kind, key: kind, name, method: "POST", path: "", summary: "", body: {}, status: "created", id });

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0310-"));
  await initState(root, "0.3.10");
  setReadBackDelays([0, 0]);
  const dataDir = path.join(root, "data");
  const tenant = new MockTenant();
  const ids = { listId: randomUUID(), profileId: randomUUID(), policyId: randomUUID() };
  tenant.lists.set(ids.listId, { id: ids.listId, name: "Example Block", sites: ["blocked.example.com"] });
  tenant.profiles.set(ids.profileId, { id: ids.profileId, name: "Example profile", filterByCategory: false, filterBySiteList: true, siteListActions: [{ id: ids.listId, action: "block", priority: 1 }] });
  tenant.policies.set(ids.policyId, { id: ids.policyId, name: "WF pilot: Example profile", type: "web-control", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: { "endpoint.web-control.web-profile-id": { value: ids.profileId } } });
  const build = {
    id: randomUUID(),
    tenantId: T,
    tenantName: "Test tenant",
    createdAt: new Date().toISOString(),
    status: "built",
    pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: ["w1"] } },
    steps: [step(1, "site-list", "Example Block", ids.listId), step(2, "profile", "Example profile", ids.profileId), step(3, "policy", "WF pilot: Example profile", ids.policyId)],
    checks: [],
  };
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  writeFileSync(path.join(dataDir, "builds", T, `${build.id}.json`), JSON.stringify(build));
  const client = new SophosClient({ getToken: async () => "t" }, { resolveApiHost: async () => HOST });
  const ctx = { tenantId: T, client, summary: { displayName: "Test tenant", region: "us01", apiHost: HOST, credentialType: "tenant" } };
  return { dataDir, tenant, ctx, build, ids };
}

async function withTenant(tenant, fn) {
  const realFetch = globalThis.fetch;
  const prev = process.env.READ_ONLY;
  globalThis.fetch = (url, init) => tenant.fetch(url, init);
  delete process.env.READ_ONLY;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (prev !== undefined) process.env.READ_ONLY = prev;
  }
}

/** The audit entries for this build's rollback deletes. */
function deleteEntries(dataDir, buildId) {
  return readFileSync(path.join(dataDir, "audit.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.action === "delete" && e.detail?.rollbackOf === buildId);
}

test("a rollback delete that loses the connection is read back: deleted when it's gone, failed with what the read-back found when it isn't", async () => {
  const a = await setup();
  a.tenant.deleteMode = { policy: "drop-made", profile: "drop-made", "site-list": "drop-made" };
  const done = await withTenant(a.tenant, () => rollback(a.dataDir, a.ctx, a.build.id, { dryRun: false }));
  assert.equal(a.tenant.policies.size + a.tenant.profiles.size + a.tenant.lists.size, 0, "every delete went through");
  assert.deepEqual(done.steps.map((s) => s.status), ["deleted", "deleted", "deleted"]);
  assert.equal(done.status, "rolled-back", JSON.stringify(done.rollback));
  for (const s of done.rollback.steps) assert.equal(s.status, "deleted: Sophos API request failed: fetch failed (ECONNRESET), then a read-back found it gone (404)");
  assert.equal(a.tenant.sent.filter((c) => c.startsWith("DELETE ")).length, 3, "each delete was sent once");
  for (const id of Object.values(a.ids)) assert.ok(a.tenant.sent.some((c) => c.startsWith("GET ") && c.endsWith(id)), `read back ${id}`);
  assert.equal(await activePilot(a.dataDir, T), null, "the pilot went with the rollback");

  const b = await setup();
  b.tenant.deleteMode = { policy: "drop-not-made" };
  const kept = await withTenant(b.tenant, () => rollback(b.dataDir, b.ctx, b.build.id, { dryRun: false }));
  assert.ok(b.tenant.policies.has(b.ids.policyId));
  assert.equal(kept.steps.find((s) => s.kind === "policy").status, "delete-failed");
  assert.equal(kept.status, "rollback-partial");
  const policyStep = kept.rollback.steps.find((s) => s.kind === "policy");
  assert.equal(policyStep.status, "failed");
  assert.equal(policyStep.error, "Sophos API request failed: fetch failed (ECONNRESET). A read-back still found it, so it wasn't deleted.");
  assert.match((await activePilot(b.dataDir, T)).rollbackUnfinished.reason, /^Sophos API request failed: .*A read-back still found it/);
});

test("a rollback delete that gets no answer in time is read back the same way", async (t) => {
  // The client gives up after 30 s; mocked timers get there at once.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = async (s, mode) => {
    s.tenant.deleteMode = mode;
    let finished = false;
    const p = withTenant(s.tenant, () => rollback(s.dataDir, s.ctx, s.build.id, { dryRun: false })).finally(() => (finished = true));
    while (!finished) {
      t.mock.timers.tick(30_000);
      await new Promise((r) => setImmediate(r));
    }
    return p;
  };
  const a = await setup();
  const done = await run(a, { policy: "timeout-made", profile: "timeout-made", "site-list": "timeout-made" });
  assert.equal(done.status, "rolled-back", JSON.stringify(done.rollback));
  assert.deepEqual(done.steps.map((s) => s.status), ["deleted", "deleted", "deleted"]);
  for (const s of done.rollback.steps) assert.equal(s.status, "deleted: Sophos API request got no answer within 30 s, then a read-back found it gone (404)");

  const b = await setup();
  const kept = await run(b, { "site-list": "timeout-not-made" });
  assert.equal(kept.status, "rollback-partial");
  assert.ok(b.tenant.lists.has(b.ids.listId));
  assert.deepEqual(kept.steps.map((s) => s.status), ["delete-failed", "deleted", "deleted"]);
  assert.equal(kept.rollback.steps.find((s) => s.kind === "site-list").error, "Sophos API request got no answer within 30 s. A read-back still found it, so it wasn't deleted.");
});

test("the audit log records what the read-back found for a delete Sophos answered unclearly", async () => {
  // Answered 500, but gone: one entry, done, with how Sophos answered and what the read-back found.
  const a = await setup();
  a.tenant.deleteMode = { policy: "500-made", profile: "drop-made", "site-list": "ok" };
  await withTenant(a.tenant, () => rollback(a.dataDir, a.ctx, a.build.id, { dryRun: false }));
  const entries = deleteEntries(a.dataDir, a.build.id);
  assert.deepEqual(entries.map((e) => [e.resource, e.ok]), [["policy", true], ["profile", true], ["site-list", true]], JSON.stringify(entries));
  assert.equal(entries[0].resourceId, a.ids.policyId);
  assert.equal(entries[0].detail.note, "Sophos answered 500, then a read-back found it gone (404)");
  assert.equal(entries[1].detail.note, "Sophos API request failed: fetch failed (ECONNRESET), then a read-back found it gone (404)");
  assert.equal(entries[2].detail.note, undefined, "a clear answer needs no note");
  assert.equal(entries[0].error, undefined);
  // The snapshot diff counts them as deleted by the tool.
  const deleted = await idsDeletedByTool(a.dataDir, T);
  for (const id of Object.values(a.ids)) assert.ok(deleted.has(id), id);

  // Answered 500 and still there: one entry, failed, with what the read-back found.
  const b = await setup();
  b.tenant.deleteMode = { policy: "500-not-made" };
  await withTenant(b.tenant, () => rollback(b.dataDir, b.ctx, b.build.id, { dryRun: false }));
  const failed = deleteEntries(b.dataDir, b.build.id);
  assert.deepEqual(failed.map((e) => [e.resource, e.ok]), [["policy", false], ["profile", false], ["site-list", false]], "the profile and list are still in use");
  assert.equal(failed[0].error, "Sophos API error 500: InternalServerError. A read-back still found it, so it wasn't deleted.");
  assert.ok(!(await idsDeletedByTool(b.dataDir, T)).has(b.ids.policyId));
});

test("the Pilot page says the pilot policy is gone, and what to do, when Sophos answers 404", async () => {
  // A rollback an earlier version recorded as failed after a 500, though the deletes went through.
  const a = await setup();
  const file = path.join(a.dataDir, "builds", T, `${a.build.id}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.status = "rollback-partial";
  record.rollback = { at: new Date().toISOString(), steps: [{ kind: "policy", name: "WF pilot: Example profile", status: "failed", error: "Sophos API error 500: InternalServerError" }] };
  for (const s of record.steps) s.status = "delete-failed";
  writeFileSync(file, JSON.stringify(record));
  a.tenant.policies.clear();
  const pilot = await activePilot(a.dataDir, T);
  assert.ok(pilot.rollbackUnfinished, "the record still says the rollback didn't finish");
  const view = await withTenant(a.tenant, () => readPilotPolicy(a.ctx, pilot));
  assert.equal(view.policy, null);
  assert.equal(view.problem, `The pilot policy "WF pilot: Example profile" is no longer in the tenant. Roll the build back on the Build page to remove what's left of it, or build a new pilot.`);
  assert.ok(a.tenant.sent.every((c) => c.startsWith("GET ")), "the page only reads");

  // There: the policy as the page shows it, and no problem.
  const b = await setup();
  const bPilot = await activePilot(b.dataDir, T);
  const live = await withTenant(b.tenant, () => readPilotPolicy(b.ctx, bPilot));
  assert.deepEqual(live, { policy: { id: b.ids.policyId, name: "WF pilot: Example profile", enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] } });

  // Any other answer isn't proof it's gone: no policy, no claim that it's gone, and why it wasn't read (v0.3.11).
  const c = await setup();
  c.tenant.policyGetStatus = 403;
  const cPilot = await activePilot(c.dataDir, T);
  assert.deepEqual(await withTenant(c.tenant, () => readPilotPolicy(c.ctx, cPilot)), { policy: null, unread: "Sophos API error 403: Forbidden" });
});

// Last in this file: it configures a mock tenant credential in this process's environment.
test("GET /api/pilot gives the Pilot page the gone note when the pilot policy answers 404", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0310r-"));
  writeFileSync(path.join(root, ".env"), "CREDENTIAL_MODE=tenant\nSOPHOS_TENANT_CLIENT_ID=mock-client-id\nSOPHOS_TENANT_CLIENT_SECRET=mock-client-secret\nSOPHOS_TENANT_LABEL=Example Tenant\n");
  const tenant = new MockTenant();
  const sophos = (url, init) => {
    const u = new URL(url);
    if (u.hostname === "id.sophos.com") return Promise.resolve(json(200, { access_token: "mock", expires_in: 3600, errorCode: "success" }));
    if (u.pathname === "/whoami/v1") return Promise.resolve(json(200, { id: T, idType: "tenant", apiHosts: { global: "https://api.central.sophos.com", dataRegion: HOST } }));
    return tenant.fetch(url, init);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = sophos;
  let server;
  try {
    const state = await initState(root, "0.3.10");
    assert.equal(state.status, "configured-ok", state.lastError ?? "");
    const step3 = (order, kind, name) => step(order, kind, name, randomUUID());
    const record = { id: randomUUID(), tenantId: T, tenantName: "Example Tenant", createdAt: new Date().toISOString(), status: "built", pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: {} }, steps: [step3(1, "site-list", "Example Block"), step3(2, "profile", "Example profile"), step3(3, "policy", "WF pilot: Example profile")], checks: [] };
    mkdirSync(path.join(root, "data", "builds", T), { recursive: true });
    writeFileSync(path.join(root, "data", "builds", T, `${record.id}.json`), JSON.stringify(record));
    const app = express();
    app.use("/api", pilotRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : sophos(url, init));
    const res = await realFetch(`${base}/api/pilot/${T}`);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.pilot.policyName, "WF pilot: Example profile");
    assert.equal(body.policy, null);
    assert.equal(body.problem, `The pilot policy "WF pilot: Example profile" is no longer in the tenant. Roll the build back on the Build page to remove what's left of it, or build a new pilot.`);
  } finally {
    globalThis.fetch = realFetch;
    server?.close();
  }
});
