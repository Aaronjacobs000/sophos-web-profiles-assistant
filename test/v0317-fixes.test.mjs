// v0.3.17: the background jobs handle their own failures, so neither can stop
// the server: the SIEM collector's timer when a tenant's saved collection
// setting isn't JSON, and the estate scan's job when anything outside a
// tenant's own read fails (its last step, its final save). And an Allow entry
// or a wave whose undo works after an earlier undo failed no longer carries
// that earlier error. Each case runs in process, against an in-memory tenant,
// and watches for an unhandled rejection, which on Node 20 and later stops
// the server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initState } from "../backend/dist/state.js";
import { log, getRingBuffer } from "../backend/dist/log.js";
import { startCollector } from "../backend/dist/services/siem-store.js";
import { startEstateScan } from "../backend/dist/services/estate.js";
import { undoAllow, loadPilotRecord } from "../backend/dist/services/pilot-service.js";
import { undoWave } from "../backend/dist/services/promote-service.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";

const T = "00000000-0000-4000-a000-000000000001";
const P = "66666666-6666-4666-8666-666666666666";
const LIST = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const POLICY = "33333333-3333-4333-8333-333333333333";
const BUILD = "55555555-5555-4555-8555-555555555552";
const TOOL = { name: "web-profiles-assistant", version: "test" };

/** Collects every unhandled rejection while fn runs, then waits a little for any that come late. */
async function unhandledDuring(fn) {
  const seen = [];
  const on = (reason) => seen.push(reason instanceof Error ? reason.message : String(reason));
  process.on("unhandledRejection", on);
  try {
    await fn();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  } finally {
    process.off("unhandledRejection", on);
  }
  return seen;
}

const put = (file, text) => (mkdirSync(path.dirname(file), { recursive: true }), writeFileSync(file, text));
const logged = (re) => getRingBuffer().some((l) => re.test(l.message));

// From v0.3.18 the timer skips only that tenant, with a warning naming it, and collects the rest (v0318-fixes).
test("the SIEM collector's timer skips a tenant whose saved collection setting isn't JSON, and nothing is left unhandled", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpa-v0317-siem-"));
  try {
    put(path.join(dir, "siem", T, "state.json"), "{not json");
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const unhandled = await unhandledDuring(async () => {
      startCollector(dir, 1, () => {
        throw new Error("no tenant context in this test");
      });
      // The first run is a minute after the server starts.
      t.mock.timers.tick(60_000);
      for (let i = 0; i < 200 && !logged(/its saved collection setting couldn't be read/); i++) await new Promise((r) => setImmediate(r));
    });
    t.mock.timers.reset();
    assert.deepEqual(unhandled, [], "no unhandled rejection");
    assert.ok(logged(/No SIEM collection for this tenant: its saved collection setting couldn't be read/), "the skipped tenant is logged");
  } finally {
    t.mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A partner credential that reaches one tenant, whose every read Sophos refuses. */
function partner() {
  const client = { tenantRequest: async () => { throw new Error("Sophos API error 403: Forbidden"); } };
  return { client, identity: { id: P, idType: "partner" }, tenants: [{ id: T, name: "Example Tenant", apiHost: "https://api-us01.central.sophos.com", dataRegion: "us01" }] };
}

async function scanUntilDone(dataDir) {
  const run = await startEstateScan(dataDir, partner(), TOOL, 2);
  for (let i = 0; i < 200 && run.running; i++) await new Promise((r) => setTimeout(r, 25));
  return run;
}

test("the estate scan's job ends, logged, when a step outside a tenant's own read fails, and nothing is left unhandled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpa-v0317-estate-"));
  const emit = log.emit;
  // The job's last step throws, as anything outside a tenant's own read could.
  log.emit = function (level, section, message, opts) {
    if (/^Estate scan finished/.test(message)) throw new Error("injected: the scan's last step failed");
    return emit.call(this, level, section, message, opts);
  };
  try {
    let run;
    const unhandled = await unhandledDuring(async () => {
      run = await scanUntilDone(path.join(dir, "data"));
    });
    assert.deepEqual(unhandled, [], "no unhandled rejection");
    assert.equal(run.running, false, "the scan no longer counts as running, so the page stops waiting and a new scan can start");
    assert.ok(run.finishedAt, "it says when it ended");
    assert.ok(logged(/The estate scan stopped: injected: the scan's last step failed/), "the failure is logged");
  } finally {
    log.emit = emit;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the estate scan's final save that fails is logged, the scan still ends, and nothing is left unhandled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wpa-v0317-estate-"));
  try {
    // The data folder is a file, so nothing can be saved in it.
    const dataDir = path.join(dir, "data");
    writeFileSync(dataDir, "not a folder");
    let run;
    const unhandled = await unhandledDuring(async () => {
      run = await scanUntilDone(dataDir);
    });
    assert.deepEqual(unhandled, []);
    assert.equal(run.running, false);
    assert.deepEqual(run.rows.map((r) => r.status), ["done"], "the tenant's own read ended as it does on its own");
    assert.ok(logged(/Couldn't keep the estate view on disk/));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * An in-memory tenant with the pilot's site list (one site), profile and
 * policy. fail[name] makes that kind of call answer 500 while it's set.
 */
class Tenant {
  constructor() {
    this.fail = {};
    this.sites = [{ id: "s1", site: "chat.example.org" }];
    this.policy = { id: POLICY, name: "WF pilot: Example profile", type: "web-control", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: {} };
  }
  async tenantRequest(_t, p, o = {}) {
    const m = o.method ?? "GET";
    if (p === `/web-filters/v1/site-lists/${LIST}/sites` && m === "GET") return { items: structuredClone(this.sites), pages: { total: 1 } };
    if (p === `/web-filters/v1/site-lists/${LIST}/sites/s1` && m === "DELETE") {
      if (this.fail.siteDelete) throw new Error("Sophos API error 500: InternalServerError");
      this.sites = this.sites.filter((s) => s.id !== "s1");
      return {};
    }
    if (p === `/endpoint/v1/policies/${POLICY}`) {
      if (m === "GET") return structuredClone(this.policy);
      if (m === "PATCH") {
        if (this.fail.policyPatch) throw new Error("Sophos API error 500: InternalServerError");
        this.policy.appliesTo = structuredClone(o.body.appliesTo);
        return structuredClone(this.policy);
      }
    }
    throw new Error(`mock: no route for ${m} ${p}`);
  }
}

async function tenantWith(records) {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v0317-undo-"));
  await initState(root, "0.3.17");
  const dataDir = path.join(root, "data");
  for (const [file, value] of Object.entries(records)) put(path.join(dataDir, file), JSON.stringify(value));
  setReadBackDelays([0, 0]);
  const tenant = new Tenant();
  const ctx = { tenantId: T, client: tenant, summary: { displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" } };
  return { root, dataDir, tenant, ctx };
}

test("an Allow whose undo works after an earlier undo failed no longer carries the earlier error", async () => {
  const allow = { id: "99999999-0000-4000-8000-000000000001", at: "2026-10-15T04:00:00.000Z", host: "chat.example.org", site: "chat.example.org", buildId: BUILD, profileId: PROFILE, listId: LIST, listName: "Example allows", siteId: "s1", createdList: false, status: "added", readBack: "site listed" };
  const a = await tenantWith({ [`pilot/${T}.json`]: { tenantId: T, allows: [allow] } });
  try {
    a.tenant.fail.siteDelete = true;
    const failed = await undoAllow(a.dataDir, a.ctx, allow.id);
    assert.equal(failed.status, "undo-failed");
    assert.match(failed.error, /Sophos API error 500/);
    a.tenant.fail.siteDelete = false;
    const undone = await undoAllow(a.dataDir, a.ctx, allow.id);
    assert.equal(undone.status, "undone");
    assert.equal(undone.error, undefined, "the answer has no error");
    assert.equal((await loadPilotRecord(a.dataDir, T)).allows[0].error, undefined, "nor has the record");
  } finally {
    rmSync(a.root, { recursive: true, force: true });
  }
});

test("a wave whose undo works after an earlier undo failed no longer carries the earlier error", async () => {
  const wave = { id: "88888888-0000-4000-8000-000000000001", at: "2026-10-15T03:00:00.000Z", buildId: BUILD, policyId: POLICY, devices: [{ id: "w1", hostname: "EXAMPLE-PC-01" }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: ["w1"], endpointGroups: [] }, status: "moved", readBack: "assignment matches" };
  const a = await tenantWith({ [`promote/${T}.json`]: { tenantId: T, waves: [wave] } });
  try {
    a.tenant.fail.policyPatch = true;
    const failed = await undoWave(a.dataDir, a.ctx, wave.id);
    assert.equal(failed.status, "undo-failed");
    assert.match(failed.error, /Sophos API error 500/);
    a.tenant.fail.policyPatch = false;
    const undone = await undoWave(a.dataDir, a.ctx, wave.id);
    assert.equal(undone.status, "undone");
    assert.equal(undone.error, undefined);
    assert.deepEqual(a.tenant.policy.appliesTo.endpoints ?? [], [], "the assignment is back as before the wave");
  } finally {
    rmSync(a.root, { recursive: true, force: true });
  }
});
