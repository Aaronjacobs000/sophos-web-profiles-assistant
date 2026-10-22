// v0.3.12: while the pilot policy is gone (a 404), the server refuses an
// Allow dry run and write with a plain message, and the other Allow paths
// stay as they were; a Promote view whose pilot policy read fails another way
// than a 404 says it wasn't read, instead of failing the whole page.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { initState } from "../backend/dist/state.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { addAllow, loadPilotRecord, planAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { promotionView } from "../backend/dist/services/promote-service.js";
import { pilotRouter } from "../backend/dist/routes/pilot.js";

// Every folder this file makes in the temp directory goes once its tests are done (v0.3.22, as in v0.3.21), so a run leaves nothing there.
const made = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const T = "00000000-0000-4000-a000-000000000001";
const HOST = "https://api-us01.central.sophos.com";
const GONE = `Allow is off: the pilot policy "WF pilot: Example profile" is no longer in the tenant. Roll the build back on the Build page, or build a new pilot.`;

/**
 * An in-memory tenant: the pilot policy, its profile and a block list, the
 * calls made, and policyGetStatus, a status every GET of a policy answers.
 * fetch() serves it to the real Sophos client; request() is a tenant client.
 */
class Tenant {
  constructor() {
    this.sent = [];
    this.policyGetStatus = null;
    this.ids = { list: randomUUID(), profile: randomUUID(), policy: randomUUID() };
    this.lists = new Map([[this.ids.list, { id: this.ids.list, name: "Example Block", sites: [{ id: randomUUID(), site: "blocked.example.com" }] }]]);
    this.profiles = new Map([[this.ids.profile, { id: this.ids.profile, name: "Example profile", filterByCategory: false, filterBySiteList: true, siteListActions: [{ id: this.ids.list, action: "block", priority: 1 }] }]]);
    this.policies = new Map([[this.ids.policy, { id: this.ids.policy, name: "WF pilot: Example profile", type: "web-control", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: {} }]]);
    this.endpoints = ["w1", "w2"].map((id) => ({ id, hostname: `EXAMPLE-${id.toUpperCase()}`, type: "computer", os: { platform: "windows", isServer: false }, assignedProducts: [{ code: "coreAgent", version: "2026.2.2.1.0", status: "installed" }] }));
  }
  get writes() {
    return this.sent.filter((c) => !c.startsWith("GET "));
  }
  /** [status, body] for one call. */
  answer(m, p, body) {
    this.sent.push(`${m} ${p}`);
    let r;
    if (p === "/endpoint/v1/endpoints") return [200, { items: this.endpoints, pages: {} }];
    if ((r = /^\/endpoint\/v1\/policies\/([^/]+)$/.exec(p))) {
      if (m === "GET" && this.policyGetStatus) return [this.policyGetStatus, { error: this.policyGetStatus >= 500 ? "InternalServerError" : "Forbidden" }];
      const pol = this.policies.get(r[1]);
      return pol && m === "GET" ? [200, structuredClone(pol)] : [404, { error: "NotFound" }];
    }
    if ((r = /^\/web-filters\/v1\/profiles\/([^/]+)$/.exec(p))) {
      const prof = this.profiles.get(r[1]);
      if (!prof) return [404, { error: "NotFound" }];
      if (m === "GET") return [200, structuredClone(prof)];
      if (m === "PUT") {
        this.profiles.set(prof.id, { ...structuredClone(body), id: prof.id });
        return [200, structuredClone(this.profiles.get(prof.id))];
      }
    }
    if (p === "/web-filters/v1/site-lists") {
      if (m === "GET") return [200, { items: [...this.lists.values()].map(({ sites, ...l }) => ({ ...l, numberOfSites: sites.length })), pages: { total: 1 } }];
      const id = randomUUID();
      this.lists.set(id, { id, name: body.name, sites: body.sites.map((site) => ({ id: randomUUID(), site })) });
      return [201, { id, name: body.name, sites: body.sites }];
    }
    if ((r = /^\/web-filters\/v1\/site-lists\/([^/]+)(\/sites)?$/.exec(p))) {
      const list = this.lists.get(r[1]);
      if (!list) return [404, { error: "NotFound" }];
      if (r[2] && m === "GET") return [200, { items: structuredClone(list.sites), pages: { total: 1 } }];
      if (!r[2] && m === "GET") return [200, { id: list.id, name: list.name, sites: list.sites.map((s) => s.site) }];
      if (!r[2] && m === "DELETE") {
        if ([...this.profiles.values()].some((pr) => (pr.siteListActions ?? []).some((a) => a.id === list.id))) return [409, { error: "Conflict" }];
        this.lists.delete(list.id);
        return [200, {}];
      }
    }
    if (m !== "GET") return [400, { error: `mock: no route for ${m} ${p}` }];
    return [200, { items: [], pages: { total: 1 } }];
  }
  async tenantRequest(tenantId, p, o = {}) {
    const [status, body] = this.answer(o.method ?? "GET", p, o.body);
    if (status >= 400) throw new Error(`Sophos API error ${status}: ${body.error}`);
    return body;
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const [status, body] = this.answer(init.method ?? "GET", u.pathname, init.body ? JSON.parse(init.body) : undefined);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
}

const step = (order, kind, name, id) => ({ order, kind, key: kind === "policy" ? "pilot" : kind, name, method: "POST", path: "", summary: "", body: {}, status: "created", id });

/** A built pilot in dataDir for the tenant's objects. */
function seedBuild(dataDir, tenant) {
  const build = {
    id: randomUUID(),
    tenantId: T,
    tenantName: "Example Tenant",
    createdAt: new Date().toISOString(),
    status: "built",
    pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: ["w1"] } },
    steps: [step(1, "site-list", "Example Block", tenant.ids.list), step(2, "profile", "Example profile", tenant.ids.profile), step(3, "policy", "WF pilot: Example profile", tenant.ids.policy)],
    checks: [],
  };
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  writeFileSync(path.join(dataDir, "builds", T, `${build.id}.json`), JSON.stringify(build));
  return build;
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0312-"));
  made.push(root);
  await initState(root, "0.3.12");
  setReadBackDelays([0, 0]);
  const dataDir = path.join(root, "data");
  const tenant = new Tenant();
  seedBuild(dataDir, tenant);
  const ctx = { tenantId: T, client: tenant, summary: { displayName: "Example Tenant", region: "us01", apiHost: HOST, credentialType: "tenant" } };
  return { dataDir, tenant, ctx };
}

test("while the pilot policy is gone, the server refuses an Allow dry run and write with a plain message, and sends nothing", async () => {
  // Deleted in Sophos Fusion after the build; its profile and block list are still there.
  const a = await setup();
  a.tenant.policies.clear();
  await assert.rejects(planAllow(a.dataDir, a.ctx, "app.example.com"), { message: GONE });
  await assert.rejects(addAllow(a.dataDir, a.ctx, "app.example.com"), { message: GONE });
  // Any host, even one the plan would refuse for itself.
  await assert.rejects(planAllow(a.dataDir, a.ctx, "*.example.com"), { message: GONE });
  assert.deepEqual(a.tenant.writes, [], "nothing was written");
  assert.deepEqual((await loadPilotRecord(a.dataDir, T)).allows, [], "no Allow entry was recorded");
});

test("the other Allow paths stay as they were: a policy that's there or wasn't read still plans, and undo works while the policy is gone", async () => {
  const a = await setup();
  // There: the plan creates and links the pilot allows list.
  const plan = await planAllow(a.dataDir, a.ctx, "app.example.com");
  assert.deepEqual([plan.problems, plan.steps.map((s) => s.op)], [[], ["create-list", "link-list"]]);
  // Not read (a 403) doesn't show the policy is gone, so it still plans.
  a.tenant.policyGetStatus = 403;
  const unread = await planAllow(a.dataDir, a.ctx, "app.example.com");
  assert.deepEqual([unread.problems, unread.steps.map((s) => s.op)], [[], ["create-list", "link-list"]]);
  a.tenant.policyGetStatus = null;
  // A broad host is still refused by the plan itself.
  assert.match((await planAllow(a.dataDir, a.ctx, "com")).problems.join(" "), /narrow Allow takes one host/);

  // An Allow added while the policy was there can still be undone once it's gone.
  const added = await addAllow(a.dataDir, a.ctx, "app.example.com");
  assert.equal(added.entry.status, "added");
  a.tenant.policies.clear();
  const undone = await undoAllow(a.dataDir, a.ctx, added.entry.id);
  assert.equal(undone.status, "undone", undone.error);
  assert.ok(!a.tenant.lists.has(added.entry.listId), "the pilot allows list went with the last entry");
});

test("a Promote view whose pilot policy read fails another way than a 404 says why it wasn't read, with no plan, and only reads", async () => {
  const a = await setup();
  a.tenant.policyGetStatus = 403;
  const view = await promotionView(a.dataDir, a.ctx, null);
  assert.equal(view.pilot?.policyId, a.tenant.ids.policy);
  assert.deepEqual(
    { policy: view.policy, policyUnread: view.policyUnread, problem: view.problem, mode: view.mode, plan: view.plan },
    { policy: null, policyUnread: "Sophos API error 403: Forbidden", problem: undefined, mode: "none", plan: null },
  );
  assert.deepEqual(a.tenant.writes, []);

  // A 404 is still the one answer that means it's gone.
  a.tenant.policyGetStatus = null;
  a.tenant.policies.clear();
  const gone = await promotionView(a.dataDir, a.ctx, 25);
  assert.equal(gone.policyUnread, undefined);
  assert.match(gone.problem, /is no longer in the tenant/);
  assert.equal(gone.plan.inPilot.length, 0);
});

// Last in this file: it configures a mock tenant credential in this process's environment.
test("the routes: POST /allow answers 400 with the plain message while the pilot policy is gone, and GET /promote says a policy it couldn't read wasn't read", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0312r-"));
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
    const state = await initState(root, "0.3.12");
    assert.equal(state.status, "configured-ok", state.lastError ?? "");
    seedBuild(path.join(root, "data"), tenant);
    const app = express();
    app.use(express.json());
    app.use("/api", pilotRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : sophos(url, init));
    const call = async (method, p, body) => {
      const res = await realFetch(`${base}${p}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      return [res.status, await res.json()];
    };

    // Gone: the dry run and the write are both refused, and nothing reaches the tenant.
    tenant.policies.clear();
    for (const dryRun of [true, false]) assert.deepEqual(await call("POST", `/api/pilot/${T}/allow`, { host: "app.example.com", dryRun }), [400, { error: "failed", message: GONE }], `dryRun ${dryRun}`);
    assert.deepEqual(tenant.writes, []);

    // Not read (a 403): the Promote view says why, with the pilot and no plan, instead of a 500.
    tenant.policyGetStatus = 403;
    const [status, view] = await call("GET", `/api/promote/${T}`);
    assert.equal(status, 200, JSON.stringify(view));
    assert.deepEqual([view.pilot?.policyName, view.policy, view.policyUnread, view.problem, view.plan], ["WF pilot: Example profile", null, "Sophos API error 403: Forbidden", undefined, null]);
  } finally {
    globalThis.fetch = realFetch;
    if (prevReadOnly !== undefined) process.env.READ_ONLY = prevReadOnly;
    server?.close();
  }
});
