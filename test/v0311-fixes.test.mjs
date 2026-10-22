// v0.3.11: a rollback delete Sophos answers with 404 (already gone) is logged
// as done, to match the step, and a pilot policy read that fails another way
// than a 404 says the read failed instead of passing for a missing policy, on
// the Pilot page and in its pilot devices filter.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

// Every folder this file makes in the temp directory goes once its tests are done (v0.3.22, as in v0.3.21), so a run leaves nothing there.
const made = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const T = "00000000-0000-4000-a000-000000000001";
const HOST = "https://api-us01.central.sophos.com";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A tenant behind a mocked fetch, so the real Sophos client is used.
 * deleteMode per kind: "ok", or "404-there" (answers 404 but the object stays).
 * policyGetStatus: a status every GET of a policy by id answers.
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
  async fetch(url, init = {}) {
    const u = new URL(url);
    const m = init.method ?? "GET";
    this.sent.push(`${m} ${u.pathname}`);
    const r = /^\/(endpoint\/v1\/policies|web-filters\/v1\/profiles|web-filters\/v1\/site-lists)\/([^/]+)$/.exec(u.pathname);
    if (r) {
      const kind = r[1].endsWith("policies") ? "policy" : r[1].endsWith("profiles") ? "profile" : "site-list";
      const store = kind === "policy" ? this.policies : kind === "profile" ? this.profiles : this.lists;
      if (kind === "policy" && m === "GET" && this.policyGetStatus) return json(this.policyGetStatus, { error: this.policyGetStatus >= 500 ? "InternalServerError" : "Forbidden" });
      const obj = store.get(r[2]);
      if (!obj) return json(404, { error: "NotFound" });
      if (m === "GET") return json(200, obj);
      if (m === "DELETE") {
        if (this.deleteMode[kind] === "404-there") return json(404, { error: "NotFound" });
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
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0311-"));
  made.push(root);
  await initState(root, "0.3.11");
  setReadBackDelays([0, 0]);
  const dataDir = path.join(root, "data");
  const tenant = new MockTenant();
  const ids = { listId: randomUUID(), profileId: randomUUID(), policyId: randomUUID() };
  tenant.lists.set(ids.listId, { id: ids.listId, name: "Example Block", sites: ["blocked.example.com"] });
  tenant.profiles.set(ids.profileId, { id: ids.profileId, name: "Example profile", filterByCategory: false, filterBySiteList: true, siteListActions: [] });
  tenant.policies.set(ids.policyId, { id: ids.policyId, name: "WF pilot: Example profile", type: "web-control", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: {} });
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

test("a rollback delete Sophos answers with 404 (already gone) is logged as done, to match the step", async () => {
  // Gone before the rollback, so every delete answers 404 and every read-back finds nothing.
  const a = await setup();
  a.tenant.policies.clear();
  a.tenant.profiles.clear();
  a.tenant.lists.clear();
  const done = await withTenant(a.tenant, () => rollback(a.dataDir, a.ctx, a.build.id, { dryRun: false }));
  assert.equal(done.status, "rolled-back");
  assert.deepEqual(done.steps.map((s) => s.status), ["deleted", "deleted", "deleted"]);
  assert.deepEqual(done.rollback.steps.map((s) => s.status), ["deleted, 404 on read-back", "deleted, 404 on read-back", "deleted, 404 on read-back"]);
  const entries = deleteEntries(a.dataDir, a.build.id);
  assert.deepEqual(entries.map((e) => [e.resource, e.ok]), [["policy", true], ["profile", true], ["site-list", true]], JSON.stringify(entries));
  for (const e of entries) {
    assert.equal(e.error, undefined);
    assert.equal(e.detail.note, "Sophos answered 404, so it was already gone, and a read-back found it gone (404)");
  }
  assert.equal(a.tenant.sent.filter((c) => c.startsWith("DELETE ")).length, 3, "each delete was sent once");
  const deleted = await idsDeletedByTool(a.dataDir, T);
  for (const id of Object.values(a.ids)) assert.ok(deleted.has(id), id);

  // Answered 404 but a read-back still finds it: one entry, failed, with what the read-back found, as the step says.
  const b = await setup();
  b.tenant.deleteMode = { policy: "404-there" };
  const kept = await withTenant(b.tenant, () => rollback(b.dataDir, b.ctx, b.build.id, { dryRun: false }));
  assert.equal(kept.steps.find((s) => s.kind === "policy").status, "delete-failed");
  assert.equal(kept.status, "rollback-partial");
  const policy = deleteEntries(b.dataDir, b.build.id).filter((e) => e.resource === "policy");
  assert.equal(policy.length, 1, JSON.stringify(policy));
  assert.equal(policy[0].ok, false);
  assert.equal(policy[0].error, "Sophos API error 404: NotFound. A read-back still found it, so it wasn't deleted.");

  // A clear answer still needs no note.
  const c = await setup();
  await withTenant(c.tenant, () => rollback(c.dataDir, c.ctx, c.build.id, { dryRun: false }));
  assert.deepEqual(deleteEntries(c.dataDir, c.build.id).map((e) => [e.ok, e.detail.note]), [[true, undefined], [true, undefined], [true, undefined]]);
});

test("a pilot policy read that fails another way than a 404 says why it wasn't read, and doesn't call the policy gone", async (t) => {
  const a = await setup();
  a.tenant.policyGetStatus = 403;
  const pilot = await activePilot(a.dataDir, T);
  const forbidden = await withTenant(a.tenant, () => readPilotPolicy(a.ctx, pilot));
  assert.deepEqual(forbidden, { policy: null, unread: "Sophos API error 403: Forbidden" });

  // A 5xx is tried three times (waits of 1 s and 2 s, mocked here), then reported the same way.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  a.tenant.policyGetStatus = 500;
  let finished = false;
  const p = withTenant(a.tenant, () => readPilotPolicy(a.ctx, pilot)).finally(() => (finished = true));
  while (!finished) {
    t.mock.timers.tick(2000);
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(await p, { policy: null, unread: "Sophos API error 500: InternalServerError" });
  t.mock.timers.reset();

  // A 404 is still the one answer that means it's gone.
  a.tenant.policyGetStatus = null;
  a.tenant.policies.clear();
  const gone = await withTenant(a.tenant, () => readPilotPolicy(a.ctx, pilot));
  assert.equal(gone.unread, undefined);
  assert.match(gone.problem, /is no longer in the tenant/);
});

// Last in this file: it configures a mock tenant credential in this process's environment.
test("GET /api/pilot and its pilot devices filter say the pilot policy wasn't read, unlike a 404", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0311r-"));
  made.push(root);
  writeFileSync(path.join(root, ".env"), "CREDENTIAL_MODE=tenant\nSOPHOS_TENANT_CLIENT_ID=mock-client-id\nSOPHOS_TENANT_CLIENT_SECRET=mock-client-secret\nSOPHOS_TENANT_LABEL=Example Tenant\n");
  const tenant = new MockTenant();
  const policyId = randomUUID();
  tenant.policies.set(policyId, { id: policyId, name: "WF pilot: Example profile", type: "web-control", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: {} });
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
    const state = await initState(root, "0.3.11");
    assert.equal(state.status, "configured-ok", state.lastError ?? "");
    const record = { id: randomUUID(), tenantId: T, tenantName: "Example Tenant", createdAt: new Date().toISOString(), status: "built", pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: {} }, steps: [step(1, "site-list", "Example Block", randomUUID()), step(2, "profile", "Example profile", randomUUID()), step(3, "policy", "WF pilot: Example profile", policyId)], checks: [] };
    mkdirSync(path.join(root, "data", "builds", T), { recursive: true });
    writeFileSync(path.join(root, "data", "builds", T, `${record.id}.json`), JSON.stringify(record));
    // Today's events: two on the pilot device w1, one on w2.
    const today = new Date().toISOString().slice(0, 10);
    const ev = (n, endpoint, host) => ({ id: randomUUID(), type: "Event::Endpoint::WebControlViolation", name: `'https://${host}/' blocked due to category 'Chat'`, created_at: `${today}T0${n}:00:00.000Z`, endpoint_id: endpoint, user_id: `u${n}` });
    mkdirSync(path.join(root, "data", "siem", T), { recursive: true });
    writeFileSync(path.join(root, "data", "siem", T, `events-${today}.jsonl`), [ev(1, "w1", "a.example.com"), ev(2, "w1", "b.example.com"), ev(3, "w2", "c.example.com")].map((e) => JSON.stringify(e)).join("\n"));
    const app = express();
    app.use("/api", pilotRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : sophos(url, init));
    const get = async (p) => {
      const res = await realFetch(`${base}${p}`);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      return body;
    };

    // Read: the filter keeps the pilot device's events.
    const there = await get(`/api/pilot/${T}/digest?days=7&pilotOnly=1`);
    assert.deepEqual([there.pilotOnly, there.pilotDevices, there.total, there.pilotUnread], [true, 1, 2, undefined]);

    // Refused (403): the page gets why, and no claim that it's gone; the filter counts nothing and says why.
    tenant.policyGetStatus = 403;
    const view = await get(`/api/pilot/${T}`);
    assert.equal(view.policy, null);
    assert.equal(view.problem, undefined);
    assert.equal(view.policyUnread, "Sophos API error 403: Forbidden");
    const unread = await get(`/api/pilot/${T}/digest?days=7&pilotOnly=1`);
    assert.deepEqual([unread.pilotOnly, unread.pilotDevices, unread.total, unread.pilotUnread], [true, null, 0, "Sophos API error 403: Forbidden"]);
    const all = await get(`/api/pilot/${T}/digest?days=7`);
    assert.deepEqual([all.pilotOnly, all.pilotDevices, all.total, all.pilotUnread], [false, null, 3, undefined], "without the filter nothing is read from Sophos");

    // Gone (404): the problem, and no pilot devices.
    tenant.policyGetStatus = null;
    tenant.policies.clear();
    const goneView = await get(`/api/pilot/${T}`);
    assert.equal(goneView.policyUnread, undefined);
    assert.match(goneView.problem, /is no longer in the tenant/);
    const gone = await get(`/api/pilot/${T}/digest?days=7&pilotOnly=1`);
    assert.deepEqual([gone.pilotOnly, gone.pilotDevices, gone.total, gone.pilotUnread], [true, 0, 0, undefined]);
  } finally {
    globalThis.fetch = realFetch;
    server?.close();
  }
});
