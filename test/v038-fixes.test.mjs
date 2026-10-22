// v0.3.8: a rollback that didn't finish keeps the pilot on the Pilot and
// Promote pages, and a setting refused for a line break answers 400.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { initState } from "../backend/dist/state.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { activePilot, planAllow } from "../backend/dist/services/pilot-service.js";
import { moveWave, promotionView } from "../backend/dist/services/promote-service.js";
import { rollback } from "../backend/dist/services/build-service.js";
import { SophosClient } from "../backend/dist/sophos/client/sophos-client.js";
import { credentialsRouter } from "../backend/dist/routes/credentials.js";
import { convertRouter } from "../backend/dist/routes/convert.js";

// Every folder this file makes in the temp directory goes once its tests are done (v0.3.22, as in v0.3.21), so a run leaves nothing there.
const made = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const T = "00000000-0000-4000-a000-000000000001";
const HOST = "https://api-us01.central.sophos.com";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A tenant behind a mocked fetch, so the real Sophos client (and its read-only check) is used. */
class MockTenant {
  constructor() {
    this.policies = new Map();
    this.profiles = new Map();
    this.lists = new Map();
    this.sent = [];
    this.deleteStatus = null;
    this.endpoints = ["w1", "w2"].map((id) => ({ id, hostname: id.toUpperCase(), type: "computer", os: { platform: "windows", isServer: false }, assignedProducts: [{ code: "coreAgent", version: "2026.2.2.1.0", status: "installed" }] }));
  }
  inUse(kind, id) {
    if (kind === "profile") return [...this.policies.values()].some((p) => p.settings["endpoint.web-control.web-profile-id"]?.value === id);
    return [...this.profiles.values()].some((p) => (p.siteListActions ?? []).some((a) => a.id === id));
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const m = init.method ?? "GET";
    this.sent.push(`${m} ${u.pathname}`);
    if (u.pathname === "/endpoint/v1/endpoints") return json(200, { items: this.endpoints, pages: {} });
    if (u.pathname === "/web-filters/v1/site-lists" && m === "GET") return json(200, { items: [...this.lists.values()].map(({ sites, ...l }) => ({ ...l, numberOfSites: sites.length })), pages: { total: 1 } });
    const r = /^\/(endpoint\/v1\/policies|web-filters\/v1\/profiles|web-filters\/v1\/site-lists)\/([^/]+)(\/sites)?$/.exec(u.pathname);
    if (r) {
      const kind = r[1].endsWith("policies") ? "policy" : r[1].endsWith("profiles") ? "profile" : "site-list";
      const store = kind === "policy" ? this.policies : kind === "profile" ? this.profiles : this.lists;
      const obj = store.get(r[2]);
      if (!obj) return json(404, { error: "NotFound" });
      if (r[3]) return json(200, { items: obj.sites.map((site) => ({ id: `${obj.id}-${site}`, site })), pages: { total: 1 } });
      if (m === "GET") return json(200, kind === "site-list" ? { id: obj.id, name: obj.name, sites: obj.sites } : obj);
      if (m === "PATCH") {
        const body = JSON.parse(init.body);
        if (body.appliesTo) obj.appliesTo = body.appliesTo;
        return json(200, obj);
      }
      if (m === "DELETE") {
        if (this.deleteStatus) return json(this.deleteStatus, { error: "ServerError" });
        if (kind !== "policy" && this.inUse(kind, obj.id)) return json(409, { error: "Conflict", message: "in use" });
        store.delete(obj.id);
        return json(200, {});
      }
    }
    if (m !== "GET") return json(400, { error: `mock: no route for ${m} ${u.pathname}` });
    return json(200, { items: [], pages: { total: 1 } });
  }
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v038-"));
  made.push(root);
  await initState(root, "0.3.8");
  setReadBackDelays([0, 0]);
  const dataDir = path.join(root, "data");
  const tenant = new MockTenant();
  const listId = randomUUID();
  const profileId = randomUUID();
  const policyId = randomUUID();
  tenant.lists.set(listId, { id: listId, name: "Sales Block", sites: ["bad.example.com"] });
  tenant.profiles.set(profileId, { id: profileId, name: "Sales profile", filterByCategory: false, filterBySiteList: true, siteListActions: [{ id: listId, action: "block", priority: 1 }] });
  tenant.policies.set(policyId, { id: policyId, name: "WF pilot: Sales profile", type: "web-control", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: { "endpoint.web-control.web-profile-id": { value: profileId } } });
  const step = (order, kind, name, id) => ({ order, kind, key: kind, name, method: "POST", path: "", summary: "", body: {}, status: "created", id });
  const build = {
    id: randomUUID(),
    tenantId: T,
    tenantName: "Test tenant",
    createdAt: new Date().toISOString(),
    status: "built",
    pilot: { profileKey: "profile", name: "WF pilot: Sales profile", enabled: false, targets: { endpoints: ["w1"] } },
    steps: [step(1, "site-list", "Sales Block", listId), step(2, "profile", "Sales profile", profileId), step(3, "policy", "WF pilot: Sales profile", policyId)],
    checks: [],
  };
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  writeFileSync(path.join(dataDir, "builds", T, `${build.id}.json`), JSON.stringify(build));
  const client = new SophosClient({ getToken: async () => "t" }, { resolveApiHost: async () => HOST });
  const ctx = { tenantId: T, client, summary: { displayName: "Test tenant", region: "us01", apiHost: HOST, credentialType: "tenant" } };
  return { dataDir, tenant, ctx, buildId: build.id, policyId };
}

/** Runs fn with fetch going to the mock tenant, and READ_ONLY set as asked. */
async function withTenant(tenant, readOnly, fn) {
  const realFetch = globalThis.fetch;
  const prev = process.env.READ_ONLY;
  globalThis.fetch = (url, init) => tenant.fetch(url, init);
  if (readOnly) process.env.READ_ONLY = "1";
  else delete process.env.READ_ONLY;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.READ_ONLY;
    else process.env.READ_ONLY = prev;
  }
}

test("a rollback refused in read-only mode keeps the pilot on the Pilot and Promote pages, and can be retried", async () => {
  const { dataDir, tenant, ctx, buildId, policyId } = await setup();
  const done = await withTenant(tenant, true, () => rollback(dataDir, ctx, buildId, { dryRun: false }));
  assert.equal(done.status, "rollback-partial");
  assert.ok(tenant.sent.every((c) => c.startsWith("GET ")), "read-only mode sent no write");
  assert.ok(tenant.policies.has(policyId), "the pilot policy is still in the tenant");

  const pilot = await activePilot(dataDir, T);
  assert.ok(pilot, "the Pilot page still has its pilot");
  assert.equal(pilot.policyId, policyId);
  assert.ok(pilot.rollbackUnfinished, "and says the rollback didn't finish");
  assert.deepEqual(pilot.rollbackUnfinished.left.map((s) => s.kind).sort(), ["policy", "profile", "site-list"]);
  assert.match(pilot.rollbackUnfinished.reason, /Read-only mode/);

  // Carry on: the Promote page shows the pilot and a wave can be planned.
  const view = await withTenant(tenant, true, () => promotionView(dataDir, ctx, 25));
  assert.equal(view.pilot?.policyId, policyId);
  assert.equal(view.mode, "devices");
  assert.equal(view.problem, undefined);
  const dry = await withTenant(tenant, true, () => moveWave(dataDir, ctx, ["w2"], true));
  assert.deepEqual(dry.problems, []);
  assert.deepEqual((await withTenant(tenant, true, () => planAllow(dataDir, ctx, "cdn.example.com"))).problems, []);

  // Retry with writes allowed: everything goes, and the pilot with it.
  const again = await withTenant(tenant, false, () => rollback(dataDir, ctx, buildId, { dryRun: false }));
  assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback));
  assert.equal(tenant.policies.size + tenant.profiles.size + tenant.lists.size, 0);
  assert.equal(await activePilot(dataDir, T), null);
});

test("a rollback Sophos refuses keeps the pilot usable, and a pilot with no rollback carries no note", async () => {
  const { dataDir, tenant, ctx, buildId, policyId } = await setup();
  assert.equal((await activePilot(dataDir, T)).rollbackUnfinished, undefined, "no rollback yet");
  tenant.deleteStatus = 500;
  const done = await withTenant(tenant, false, () => rollback(dataDir, ctx, buildId, { dryRun: false }));
  assert.equal(done.status, "rollback-partial");
  assert.ok(tenant.policies.has(policyId));
  const pilot = await activePilot(dataDir, T);
  assert.equal(pilot?.policyId, policyId);
  assert.match(pilot.rollbackUnfinished.reason, /500/);

  // Carry on: a wave still moves onto the pilot.
  tenant.deleteStatus = null;
  const wave = await withTenant(tenant, false, () => moveWave(dataDir, ctx, ["w2"], false));
  assert.equal(wave.status, "moved", wave.error);
  assert.deepEqual(tenant.policies.get(policyId).appliesTo.endpoints, ["w1", "w2"]);
});

test("a setting with a line break is refused with 400 and its message, and nothing is saved or sent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v038e-"));
  made.push(root);
  await initState(root, "0.3.8");
  const app = express();
  app.use(express.json());
  app.use("/api", credentialsRouter);
  app.use("/api", convertRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  const sophos = [];
  globalThis.fetch = (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : (sophos.push(String(url)), Promise.resolve(json(401, { error: "unauthorized" }))));
  const put = async (p, body) => {
    const res = await realFetch(base + p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const cases = [
      ["/api/credentials", { mode: "tenant", clientId: "abc", clientSecret: "s", label: "Contoso\nCHROME_PATH=/tmp/x" }, /^SOPHOS_TENANT_LABEL can't contain a line break\.$/],
      ["/api/credentials", { mode: "partner", clientId: "abc\rX=y", clientSecret: "s" }, /^SOPHOS_PARTNER_CLIENT_ID can't contain a line break\.$/],
      ["/api/intelix", { clientId: "abc\nCHROME_PATH=/tmp/x", clientSecret: "s", region: "au" }, /^INTELIX_CLIENT_ID can't contain a line break\.$/],
    ];
    for (const [p, body, message] of cases) {
      const r = await put(p, body);
      assert.equal(r.status, 400, `${p} ${JSON.stringify(r.body)}`);
      assert.match(r.body.message, message);
    }
    assert.equal(existsSync(path.join(root, ".env")), false, "nothing was saved");
    assert.deepEqual(sophos, [], "nothing was sent");
    assert.equal((await put("/api/intelix", { clientId: "abc", clientSecret: "s", region: "au" })).status, 200, "a one-line value still saves");
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
