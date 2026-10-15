// v0.3.9: a rollback delete Sophos answers with a 5xx is read back before
// it's called failed, the Promote page says when the pilot policy is gone
// instead of failing on the 404, and the Build page headline is plain words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initState } from "../backend/dist/state.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { activePilot } from "../backend/dist/services/pilot-service.js";
import { promotionView } from "../backend/dist/services/promote-service.js";
import { rollback } from "../backend/dist/services/build-service.js";
import { SophosClient } from "../backend/dist/sophos/client/sophos-client.js";
import { buildHeadline } from "../frontend/js/ui.js";

const T = "00000000-0000-4000-a000-000000000001";
const HOST = "https://api-us01.central.sophos.com";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A tenant behind a mocked fetch, so the real Sophos client is used. deleteMode
 * per kind: "ok", "500-made" (answers 500 but deletes) or "500-not-made".
 */
class MockTenant {
  constructor() {
    this.policies = new Map();
    this.profiles = new Map();
    this.lists = new Map();
    this.sent = [];
    this.deleteMode = {};
    this.policyGetStatus = null;
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
        if (mode === "500-not-made") return json(500, { error: "InternalServerError" });
        if (kind !== "policy" && this.inUse(kind, obj.id)) return json(409, { error: "Conflict", message: "in use" });
        store.delete(obj.id);
        return mode === "500-made" ? json(500, { error: "InternalServerError" }) : json(200, {});
      }
    }
    if (m !== "GET") return json(400, { error: `mock: no route for ${m} ${u.pathname}` });
    return json(200, { items: [], pages: { total: 1 } });
  }
}

const step = (order, kind, name, id, status = "created") => ({ order, kind, key: kind, name, method: "POST", path: "", summary: "", body: {}, status, id });

async function setup(buildOver = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v039-"));
  await initState(root, "0.3.9");
  setReadBackDelays([0, 0]);
  const dataDir = path.join(root, "data");
  const tenant = new MockTenant();
  const listId = randomUUID();
  const profileId = randomUUID();
  const policyId = randomUUID();
  tenant.lists.set(listId, { id: listId, name: "Example Block", sites: ["blocked.example.com"] });
  tenant.profiles.set(profileId, { id: profileId, name: "Example profile", filterByCategory: false, filterBySiteList: true, siteListActions: [{ id: listId, action: "block", priority: 1 }] });
  tenant.policies.set(policyId, { id: policyId, name: "WF pilot: Example profile", type: "web-control", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: { "endpoint.web-control.web-profile-id": { value: profileId } } });
  const build = {
    id: randomUUID(),
    tenantId: T,
    tenantName: "Test tenant",
    createdAt: new Date().toISOString(),
    status: "built",
    pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: ["w1"] } },
    steps: [step(1, "site-list", "Example Block", listId), step(2, "profile", "Example profile", profileId), step(3, "policy", "WF pilot: Example profile", policyId)],
    checks: [],
    ...buildOver,
  };
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  writeFileSync(path.join(dataDir, "builds", T, `${build.id}.json`), JSON.stringify(build));
  const client = new SophosClient({ getToken: async () => "t" }, { resolveApiHost: async () => HOST });
  const ctx = { tenantId: T, client, summary: { displayName: "Test tenant", region: "us01", apiHost: HOST, credentialType: "tenant" } };
  return { dataDir, tenant, ctx, build, ids: { listId, profileId, policyId } };
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

test("a rollback delete Sophos answers 500 but makes is read back and recorded as deleted", async () => {
  const { dataDir, tenant, ctx, build } = await setup();
  tenant.deleteMode = { policy: "500-made", profile: "500-made", "site-list": "500-made" };
  const done = await withTenant(tenant, () => rollback(dataDir, ctx, build.id, { dryRun: false }));
  assert.equal(tenant.policies.size + tenant.profiles.size + tenant.lists.size, 0, "every delete went through");
  assert.deepEqual(done.steps.map((s) => s.status), ["deleted", "deleted", "deleted"]);
  assert.equal(done.status, "rolled-back", JSON.stringify(done.rollback));
  for (const s of done.rollback.steps) assert.match(s.status, /^deleted: Sophos answered 500, then a read-back found it gone \(404\)$/);
  // Each delete was sent once, then read back by id.
  assert.equal(tenant.sent.filter((c) => c.startsWith("DELETE ")).length, 3);
  assert.equal(await activePilot(dataDir, T), null, "the pilot went with the rollback");
  assert.equal((await withTenant(tenant, () => promotionView(dataDir, ctx, 25))).pilot, null);
});

test("a rollback delete Sophos answers 500 and doesn't make is recorded as delete-failed, with what the read-back found", async () => {
  const { dataDir, tenant, ctx, build, ids } = await setup();
  tenant.deleteMode = { policy: "500-not-made" };
  const done = await withTenant(tenant, () => rollback(dataDir, ctx, build.id, { dryRun: false }));
  assert.ok(tenant.policies.has(ids.policyId));
  assert.equal(done.steps.find((s) => s.kind === "policy").status, "delete-failed");
  assert.equal(done.status, "rollback-partial");
  const policyStep = done.rollback.steps.find((s) => s.kind === "policy");
  assert.equal(policyStep.status, "failed");
  assert.equal(policyStep.error, "Sophos API error 500: InternalServerError. A read-back still found it, so it wasn't deleted.");
  const pilot = await activePilot(dataDir, T);
  assert.equal(pilot?.policyId, ids.policyId, "the pilot stays");
  assert.match(pilot.rollbackUnfinished.reason, /^Sophos API error 500: .*A read-back still found it/);

  // The retry deletes everything, each confirmed with a 404.
  tenant.deleteMode = {};
  const again = await withTenant(tenant, () => rollback(dataDir, ctx, build.id, { dryRun: false }));
  assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback));
  assert.equal(tenant.policies.size + tenant.profiles.size + tenant.lists.size, 0);
});

test("the Promote page says the pilot policy is gone instead of failing on the 404", async () => {
  // Deleted in Sophos Fusion after the build.
  const a = await setup();
  a.tenant.policies.delete(a.ids.policyId);
  const view = await withTenant(a.tenant, () => promotionView(a.dataDir, a.ctx, 25));
  assert.equal(view.pilot?.policyId, a.ids.policyId);
  assert.equal(view.policy, null);
  assert.equal(view.mode, "none");
  assert.equal(view.problem, `The pilot policy "WF pilot: Example profile" is no longer in the tenant, so there's nothing to promote. Roll the build back on the Build page to remove what's left of it, or build a new pilot.`);
  assert.equal(view.plan.inPilot.length, 0);
  assert.ok(a.tenant.sent.every((c) => c.startsWith("GET ")), "the page only reads");

  // A rollback an earlier version recorded as failed after a 500, though the deletes went through.
  const failed = { kind: "policy", name: "WF pilot: Example profile", status: "failed", error: "Sophos API error 500: InternalServerError" };
  const b = await setup({ status: "rollback-partial", rollback: { at: new Date().toISOString(), steps: [failed] } });
  const record = JSON.parse(readFileSync(path.join(b.dataDir, "builds", T, `${b.build.id}.json`), "utf8"));
  for (const s of record.steps) s.status = "delete-failed";
  writeFileSync(path.join(b.dataDir, "builds", T, `${b.build.id}.json`), JSON.stringify(record));
  b.tenant.policies.clear();
  b.tenant.profiles.clear();
  b.tenant.lists.clear();
  const stale = await withTenant(b.tenant, () => promotionView(b.dataDir, b.ctx, 25));
  assert.equal(stale.policy, null);
  assert.match(stale.problem, /no longer in the tenant/);

  // Any other answer is still an error.
  const c = await setup();
  c.tenant.policyGetStatus = 403;
  await assert.rejects(withTenant(c.tenant, () => promotionView(c.dataDir, c.ctx, 25)), /Sophos API error 403/);
});

test("the Build page headline says each status in plain words", () => {
  const rec = (status, checks = []) => ({ status, steps: [{}, {}, {}], checks });
  assert.equal(buildHeadline(null, false), "Plan the pilot");
  assert.equal(buildHeadline(rec("dry-run", [{ ok: true }]), false), "Dry run passed. Ready to create 3 objects.");
  assert.equal(buildHeadline(rec("dry-run", [{ ok: true }]), true), "Dry run passed. Read-only mode, so nothing will be created.");
  assert.equal(buildHeadline(rec("dry-run", [{ ok: false }]), false), "Dry run found problems");
  assert.equal(buildHeadline(rec("built"), false), "Built 3 objects");
  assert.equal(buildHeadline(rec("partial"), false), "Build didn't finish");
  assert.equal(buildHeadline(rec("failed"), false), "Build failed");
  assert.equal(buildHeadline(rec("rolled-back"), false), "Rolled back");
  assert.equal(buildHeadline(rec("rollback-partial"), false), "Rollback didn't finish");
  const page = readFileSync(new URL("../frontend/js/page-build.js", import.meta.url), "utf8");
  assert.match(page, /<h1>\$\{esc\(buildHeadline\(lead, getStatus\(\)\?\.readOnly\)\)\}<\/h1>/, "the page uses it");
});
