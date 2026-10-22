// v0.3.13: while the pilot policy can't be read (Sophos answers anything but
// a 404, or doesn't answer in time), the server refuses to undo a promotion
// wave with a plain message, writes nothing, and leaves the wave as it was.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { initState } from "../backend/dist/state.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { undoWave } from "../backend/dist/services/promote-service.js";
import { pilotRouter } from "../backend/dist/routes/pilot.js";

// Every folder this file makes in the temp directory goes once its tests are done (v0.3.22, as in v0.3.21), so a run leaves nothing there.
const made = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const T = "00000000-0000-4000-a000-000000000001";
const HOST = "https://api-us01.central.sophos.com";
const UNDO_OFF = "Undo is off: the tool couldn't read the pilot policy, so it can't check the assignment first. Try again later, or check it in Sophos Fusion.";

/**
 * An in-memory tenant with the pilot policy, and policyGet: a status every
 * GET of the policy answers, or "timeout" for no answer in time.
 */
class Tenant {
  constructor() {
    this.sent = [];
    this.policyGet = null;
    this.policyId = randomUUID();
    this.policies = new Map([[this.policyId, { id: this.policyId, name: "WF pilot: Example profile", type: "web-control", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: {} }]]);
  }
  get writes() {
    return this.sent.filter((c) => !c.startsWith("GET "));
  }
  async tenantRequest(tenantId, p, o = {}) {
    const m = o.method ?? "GET";
    this.sent.push(`${m} ${p}`);
    const r = /^\/endpoint\/v1\/policies\/([^/]+)$/.exec(p);
    if (!r) throw new Error(`mock: no route for ${m} ${p}`);
    if (m === "GET" && this.policyGet === "timeout") throw new Error("Sophos API request got no answer within 30 s.");
    if (m === "GET" && this.policyGet) throw new Error(`Sophos API error ${this.policyGet}: ${this.policyGet >= 500 ? "InternalServerError" : "Forbidden"}`);
    const pol = this.policies.get(r[1]);
    if (!pol) throw new Error("Sophos API error 404: NotFound");
    if (m === "GET") return structuredClone(pol);
    if (m === "PATCH") {
      Object.assign(pol, structuredClone(o.body));
      return structuredClone(pol);
    }
    throw new Error(`mock: no route for ${m} ${p}`);
  }
  async fetch(url, init = {}) {
    try {
      const body = await this.tenantRequest(T, new URL(url).pathname, { method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    } catch (err) {
      const status = Number(/error (\d{3})/.exec(err.message)?.[1] ?? 500);
      return new Response(JSON.stringify({ error: err.message.split(": ").pop() }), { status, headers: { "content-type": "application/json" } });
    }
  }
}

/** One wave moved onto the pilot: w1, from no devices. */
function seedWave(dataDir, tenant) {
  const wave = { id: randomUUID(), at: "2026-10-15T03:00:00.000Z", buildId: randomUUID(), policyId: tenant.policyId, devices: [{ id: "w1", hostname: "EXAMPLE-PC-01" }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: ["w1"], endpointGroups: [] }, status: "moved", readBack: "assignment matches" };
  mkdirSync(path.join(dataDir, "promote"), { recursive: true });
  writeFileSync(path.join(dataDir, "promote", `${T}.json`), JSON.stringify({ tenantId: T, waves: [wave] }));
  return wave;
}

const savedWaves = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, "promote", `${T}.json`), "utf8")).waves;

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0313-"));
  made.push(root);
  await initState(root, "0.3.13");
  setReadBackDelays([0, 0]);
  const dataDir = path.join(root, "data");
  const tenant = new Tenant();
  const wave = seedWave(dataDir, tenant);
  const ctx = { tenantId: T, client: tenant, summary: { displayName: "Example Tenant", region: "us01", apiHost: HOST, credentialType: "tenant" } };
  return { dataDir, tenant, ctx, wave };
}

test("while the pilot policy can't be read, a wave undo is refused with a plain message, nothing is written, and the wave stays moved", async () => {
  for (const answer of [403, 500, "timeout"]) {
    const a = await setup();
    a.tenant.policyGet = answer;
    const before = savedWaves(a.dataDir);
    await assert.rejects(undoWave(a.dataDir, a.ctx, a.wave.id), { message: UNDO_OFF }, String(answer));
    assert.deepEqual(a.tenant.writes, [], `${answer}: nothing was written`);
    assert.deepEqual(savedWaves(a.dataDir), before, `${answer}: the wave record is as it was`);
    assert.equal(before[0].status, "moved");
  }
});

// A 404 is refused with its own plain message since v0.3.14 (test/v0314-fixes.test.mjs).
test("the other undo path stays as it was: a policy that reads is put back", async () => {
  const a = await setup();
  const undone = await undoWave(a.dataDir, a.ctx, a.wave.id);
  assert.equal(undone.status, "undone", undone.error);
  assert.equal(undone.readBack, "assignment back as before the wave");
  assert.deepEqual(a.tenant.writes, [`PATCH /endpoint/v1/policies/${a.tenant.policyId}`]);
});

// Last in this file: it configures a mock tenant credential in this process's environment.
test("the route: POST /promote/:tenant/wave/:id/undo answers 400 with the plain message while the pilot policy can't be read", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0313r-"));
  made.push(root);
  writeFileSync(path.join(root, ".env"), "CREDENTIAL_MODE=tenant\nSOPHOS_TENANT_CLIENT_ID=mock-client-id\nSOPHOS_TENANT_CLIENT_SECRET=mock-client-secret\nSOPHOS_TENANT_LABEL=Example Tenant\n");
  const tenant = new Tenant();
  const sophos = (url, init) => {
    const u = new URL(url);
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    if (u.hostname === "id.sophos.com") return json({ access_token: "mock", expires_in: 3600, errorCode: "success" });
    if (u.pathname === "/whoami/v1") return json({ id: T, idType: "tenant", apiHosts: { global: "https://api.central.sophos.com", dataRegion: HOST } });
    return tenant.fetch(url, init);
  };
  const realFetch = globalThis.fetch;
  const prevReadOnly = process.env.READ_ONLY;
  delete process.env.READ_ONLY;
  globalThis.fetch = sophos;
  let server;
  try {
    const state = await initState(root, "0.3.13");
    assert.equal(state.status, "configured-ok", state.lastError ?? "");
    const dataDir = path.join(root, "data");
    const wave = seedWave(dataDir, tenant);
    const app = express();
    app.use(express.json());
    app.use("/api", pilotRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : sophos(url, init));

    tenant.policyGet = 403;
    const res = await realFetch(`${base}/api/promote/${T}/wave/${wave.id}/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual([res.status, await res.json()], [400, { error: "failed", message: UNDO_OFF }]);
    assert.deepEqual(tenant.writes, []);
    assert.equal(savedWaves(dataDir)[0].status, "moved");
  } finally {
    globalThis.fetch = realFetch;
    if (prevReadOnly !== undefined) process.env.READ_ONLY = prevReadOnly;
    server?.close();
  }
});
