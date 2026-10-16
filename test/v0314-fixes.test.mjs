// v0.3.14: when the pilot policy is no longer in the tenant (Sophos answers
// 404), the server refuses to undo a promotion wave with a plain message,
// writes nothing, and leaves the wave as it was instead of recording an undo
// that failed with Sophos's raw answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { initState } from "../backend/dist/state.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { undoWave } from "../backend/dist/services/promote-service.js";
import { pilotRouter } from "../backend/dist/routes/pilot.js";

const T = "00000000-0000-4000-a000-000000000001";
const HOST = "https://api-us01.central.sophos.com";
const UNDO_GONE = "Undo is off: the pilot policy is no longer in the tenant, so there's no assignment to put back.";

/** An in-memory tenant with the pilot policy; clear policies to make it gone, so every request for it answers 404. */
class Tenant {
  constructor() {
    this.sent = [];
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

/** One wave moved onto the pilot (w1, from no devices), in this status. */
function seedWave(dataDir, tenant, status = "moved") {
  const wave = { id: randomUUID(), at: "2026-10-15T03:00:00.000Z", buildId: randomUUID(), policyId: tenant.policyId, devices: [{ id: "w1", hostname: "EXAMPLE-PC-01" }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: ["w1"], endpointGroups: [] }, status, readBack: "assignment matches", ...(status === "undo-failed" ? { error: "Sophos API error 403: Forbidden" } : {}) };
  mkdirSync(path.join(dataDir, "promote"), { recursive: true });
  writeFileSync(path.join(dataDir, "promote", `${T}.json`), JSON.stringify({ tenantId: T, waves: [wave] }));
  return wave;
}

const savedWaves = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, "promote", `${T}.json`), "utf8")).waves;

async function setup(status) {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0314-"));
  await initState(root, "0.3.14");
  setReadBackDelays([0, 0]);
  const dataDir = path.join(root, "data");
  const tenant = new Tenant();
  const wave = seedWave(dataDir, tenant, status);
  const ctx = { tenantId: T, client: tenant, summary: { displayName: "Example Tenant", region: "us01", apiHost: HOST, credentialType: "tenant" } };
  return { dataDir, tenant, ctx, wave };
}

test("when the pilot policy is gone (a 404), a wave undo is refused with a plain message, nothing is written, and the wave isn't recorded as an undo that failed", async () => {
  for (const status of ["moved", "undo-failed"]) {
    const a = await setup(status);
    a.tenant.policies.clear();
    const before = savedWaves(a.dataDir);
    await assert.rejects(undoWave(a.dataDir, a.ctx, a.wave.id), { message: UNDO_GONE }, status);
    assert.deepEqual(a.tenant.writes, [], `${status}: nothing was written`);
    assert.deepEqual(savedWaves(a.dataDir), before, `${status}: the wave record is as it was`);
    assert.equal(before[0].status, status);
  }
});

test("a pilot policy that reads still has its wave put back", async () => {
  const a = await setup("moved");
  const undone = await undoWave(a.dataDir, a.ctx, a.wave.id);
  assert.deepEqual([undone.status, undone.readBack], ["undone", "assignment back as before the wave"], undone.error);
  assert.deepEqual(a.tenant.writes, [`PATCH /endpoint/v1/policies/${a.tenant.policyId}`]);
  assert.equal(savedWaves(a.dataDir)[0].status, "undone");
});

// Last in this file: it configures a mock tenant credential in this process's environment.
test("the route: POST /promote/:tenant/wave/:id/undo answers 400 with the plain message when the pilot policy is gone", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0314r-"));
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
    const state = await initState(root, "0.3.14");
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

    tenant.policies.clear();
    const res = await realFetch(`${base}/api/promote/${T}/wave/${wave.id}/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual([res.status, await res.json()], [400, { error: "failed", message: UNDO_GONE }]);
    assert.deepEqual(tenant.writes, []);
    assert.deepEqual(savedWaves(dataDir).map((w) => [w.status, w.error]), [["moved", undefined]]);
  } finally {
    globalThis.fetch = realFetch;
    if (prevReadOnly !== undefined) process.env.READ_ONLY = prevReadOnly;
    server?.close();
  }
});
