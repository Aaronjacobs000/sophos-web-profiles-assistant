// Guard, from v0.3.20: category D, anything Sophos accepted that the
// read-back didn't confirm stays undoable or retryable, the same as a
// confirmed write. Every service function that writes to a tenant is in
// WRITE_PATHS (a new one fails the first test until it's added). Each is run
// twice against an in-memory tenant: once with every write accepted (2xx)
// and once answered 500 after it was made, and both times with every
// read-back by id failing. Then, with the reads working again, the write's
// own undo or retry must be accepted and must finish. The last test checks
// that each page draws that undo or retry for a record in that state.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, execute, rollback } from "../backend/dist/services/build-service.js";
import { createLists, undoLists } from "../backend/dist/services/lists-service.js";
import { addAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { moveWave, setPilotEnabled, undoWave } from "../backend/dist/services/promote-service.js";
import { restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { summarize } from "../backend/dist/domain/digest.js";
import { T, TOOL, Tenant, classicTenant, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

before(() => setReadBackDelays([0, 0]));

/** Every read of one object by id fails while on() holds and a write has been made; collection reads still work, so a create can be found by name. */
const BY_ID = /\/(policies|profiles|site-lists|local-sites)\/[0-9a-f-]{36}(\/sites)?$/;
function unconfirming(tenant, how) {
  const state = { on: true };
  const from = tenant.writes;
  tenant.refuse("GET", BY_ID, 503, () => state.on && tenant.writes > from);
  if (how === "unclear") for (const m of ["POST", "PUT", "PATCH", "DELETE"]) tenant.unclear(m, /./, () => state.on);
  return () => {
    state.on = false;
  };
}

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com"), result(2, "chat.example.org", "warn")];

/**
 * Each write path: set up, run the write with its read-back unconfirmed, then (reads working) its undo or retry.
 * check(record) says the write's record is in a state its undo or retry takes; done(after) that the undo or retry finished.
 */
const WRITE_PATHS = {
  "build-service.execute": {
    async run(how) {
      const dataDir = await dataDirFor("d-build");
      const tenant = classicTenant();
      const ctx = ctxOf(tenant);
      const { design } = await designFor(dataDir, ctx);
      const profile = design.profiles.find((p) => p.siteLists.length);
      const ok = unconfirming(tenant, how);
      const rec = await execute(dataDir, ctx, { profileKey: profile.key, enabled: false, targets: { endpoints: ["w1"] } }, TOOL);
      ok();
      assert.ok(["built", "partial"].includes(rec.status) && rec.steps.some((s) => s.id && s.readBack !== "matches"), `build ${rec.status}: ${JSON.stringify(rec.steps.map((s) => [s.status, s.readBack]))}`);
      const undo = await rollback(dataDir, ctx, rec.id, { dryRun: false });
      assert.equal(undo.status, "rolled-back", JSON.stringify(undo.rollback.steps));
      assert.equal(tenant.lists.size + tenant.profiles.size, 0, "the rollback removed what the build made");
    },
  },
  "build-service.rollback": {
    async run(how) {
      const dataDir = await dataDirFor("d-rollback");
      const tenant = new Tenant();
      const { build } = seedPilot(tenant, dataDir);
      const ok = unconfirming(tenant, how);
      const first = await rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false });
      ok();
      assert.equal(first.status, "rollback-partial", JSON.stringify(first.rollback.steps));
      const again = await rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false });
      assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback.steps));
    },
  },
  "lists-service.createLists": {
    async run(how) {
      const dataDir = await dataDirFor("d-lists");
      const tenant = new Tenant();
      const ok = unconfirming(tenant, how);
      const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
      ok();
      assert.ok(rec.lists.every((l) => l.status === "created" && l.id && l.readBack?.startsWith("not read")), JSON.stringify(rec.lists));
      const undone = await undoLists(dataDir, tenant, T);
      assert.deepEqual(undone.lists.map((l) => l.status), ["deleted", "deleted"]);
      assert.equal(tenant.lists.size, 0);
    },
  },
  "lists-service.undoLists": {
    async run(how) {
      const dataDir = await dataDirFor("d-undolists");
      const tenant = new Tenant();
      await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
      const ok = unconfirming(tenant, how);
      const first = await undoLists(dataDir, tenant, T);
      ok();
      assert.deepEqual(first.lists.map((l) => l.status), ["not confirmed", "not confirmed"]);
      const again = await undoLists(dataDir, tenant, T);
      assert.deepEqual(again.lists.map((l) => l.status), ["deleted", "deleted"]);
    },
  },
  "pilot-service.addAllow": {
    async run(how) {
      // The first Allow creates the pilot's list and links it; the second adds a site to it.
      for (const second of [false, true]) {
        const dataDir = await dataDirFor("d-allow");
        const tenant = new Tenant();
        const { profileId } = seedPilot(tenant, dataDir);
        const ctx = ctxOf(tenant);
        if (second) await addAllow(dataDir, ctx, "video.example.net");
        const ok = unconfirming(tenant, how);
        const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
        ok();
        assert.ok(["added", "partial"].includes(entry.status) && entry.readBack !== "site listed" && entry.readBack !== "list holds the site; profile links it as allow", JSON.stringify(entry));
        const undone = await undoAllow(dataDir, ctx, entry.id);
        assert.equal(undone.status, "undone", undone.error);
        assert.ok(![...tenant.lists.values()].some((l) => l.sites.some((s) => s.site === "chat.example.org")), "the site is gone");
        if (!second) assert.deepEqual(tenant.profiles.get(profileId).siteListActions.length, 1, "the pilot's list is unlinked");
      }
    },
  },
  "pilot-service.undoAllow": {
    async run(how) {
      for (const second of [false, true]) {
        const dataDir = await dataDirFor("d-undoallow");
        const tenant = new Tenant();
        seedPilot(tenant, dataDir);
        const ctx = ctxOf(tenant);
        if (second) await addAllow(dataDir, ctx, "video.example.net");
        const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
        const ok = unconfirming(tenant, how);
        const first = await undoAllow(dataDir, ctx, entry.id);
        ok();
        assert.equal(first.status, "undo-failed", JSON.stringify(first));
        assert.ok(first.undoReadBack, "Sophos took the undo, so its read-back is kept apart from a refusal");
        const again = await undoAllow(dataDir, ctx, entry.id);
        assert.equal(again.status, "undone", again.error);
      }
    },
  },
  "promote-service.moveWave": {
    async run(how) {
      const dataDir = await dataDirFor("d-wave");
      const tenant = new Tenant();
      const { policyId } = seedPilot(tenant, dataDir);
      const ctx = ctxOf(tenant);
      const ok = unconfirming(tenant, how);
      const w = await moveWave(dataDir, ctx, ["w2"], false);
      ok();
      assert.equal(w.status, "unconfirmed", JSON.stringify(w));
      const undone = await undoWave(dataDir, ctx, w.id);
      assert.equal(undone.status, "undone", undone.error);
      assert.deepEqual(tenant.policies.get(policyId).appliesTo.endpoints, ["w1"]);
    },
  },
  "promote-service.undoWave": {
    async run(how) {
      const dataDir = await dataDirFor("d-undowave");
      const tenant = new Tenant();
      const { policyId } = seedPilot(tenant, dataDir);
      const ctx = ctxOf(tenant);
      const w = await moveWave(dataDir, ctx, ["w2"], false);
      const ok = unconfirming(tenant, how);
      const first = await undoWave(dataDir, ctx, w.id);
      ok();
      assert.deepEqual([first.status, !!first.undoReadBack], ["undo-failed", true], JSON.stringify(first));
      const again = await undoWave(dataDir, ctx, w.id);
      assert.equal(again.status, "undone", again.error);
      assert.deepEqual(tenant.policies.get(policyId).appliesTo.endpoints, ["w1"]);
    },
  },
  "promote-service.setPilotEnabled": {
    async run(how) {
      const dataDir = await dataDirFor("d-toggle");
      const tenant = new Tenant();
      seedPilot(tenant, dataDir);
      const ctx = ctxOf(tenant);
      const ok = unconfirming(tenant, how);
      // The switch shows the policy as read, so turning it on again is the retry.
      const first = await setPilotEnabled(dataDir, ctx, true).catch((err) => ({ error: err.message }));
      ok();
      assert.ok(first.error || first.readBack !== "matches", JSON.stringify(first));
      assert.deepEqual(await setPilotEnabled(dataDir, ctx, true), { enabled: true, readBack: "matches" });
    },
  },
  "retire-service.retire": {
    async run(how) {
      const dataDir = await dataDirFor("d-retire");
      const { tenant } = await retireTenant(dataDir);
      const ok = unconfirming(tenant, how);
      const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
      ok();
      assert.deepEqual(rec.steps.map((s) => s.status), ["unconfirmed", "unconfirmed", "unconfirmed"], "every step was sent and is not confirmed");
      const back = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
      assert.equal(back.status, "restored", JSON.stringify(back.steps.map((s) => [s.status, s.error])));
    },
  },
  "retire-service.restoreRetire": {
    async run(how) {
      const dataDir = await dataDirFor("d-restore");
      const { tenant } = await retireTenant(dataDir);
      const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
      assert.equal(rec.status, "retired");
      const ok = unconfirming(tenant, how);
      const first = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
      ok();
      assert.equal(first.status, "restore-partial", JSON.stringify(first.steps.map((s) => [s.status, s.readBack, s.error])));
      const again = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
      assert.equal(again.status, "restored", JSON.stringify(again.steps.map((s) => [s.status, s.readBack, s.error])));
    },
  },
};

test("every service function that writes to a tenant has an entry in this guard", () => {
  // The API wrappers that write: every one in backend/src/sophos/api that sends POST, PUT, PATCH or DELETE.
  const apiDir = path.join(root, "backend/src/sophos/api");
  const writers = readdirSync(apiDir).flatMap((f) =>
    readFileSync(path.join(apiDir, f), "utf8")
      .split(/\n(?=export )/)
      .filter((part) => /method: "(?:POST|PUT|PATCH|DELETE)"/.test(part))
      .map((part) => /^export (?:const|async function|function) (\w+)/.exec(part)?.[1])
      .filter(Boolean),
  );
  assert.ok(writers.length >= 14, writers.join(", "));
  const calls = new RegExp(`\\b(${writers.join("|")})\\(`);
  const dir = path.join(root, "backend/src/services");
  const found = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    for (const part of readFileSync(path.join(dir, f), "utf8").split(/\n(?=export (?:async )?function )/)) {
      const name = /^export (?:async )?function (\w+)/.exec(part)?.[1];
      if (name && calls.test(part)) found.push(`${f.replace(/\.ts$/, "")}.${name}`);
    }
  }
  const missing = found.filter((n) => !WRITE_PATHS[n]);
  assert.deepEqual(missing, [], "add each to WRITE_PATHS with its undo or retry");
  assert.deepEqual(Object.keys(WRITE_PATHS).filter((n) => !found.includes(n)), [], "an entry for a function that no longer writes");
});

for (const [name, p] of Object.entries(WRITE_PATHS)) {
  for (const how of ["accepted", "unclear"]) {
    const said = how === "accepted" ? "Sophos accepted" : "Sophos made but answered 500";
    test(`category D: ${name}, a write ${said} and the read-back couldn't confirm, can be undone or tried again`, async () => {
      await p.run(how);
    });
  }
}

// ---------- the pages ----------

const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: TOOL.version, readOnly: false };
const now = new Date().toISOString();
const NOT_READ = "not read: Sophos API error 503: ServiceUnavailable";
const pilot = { buildId: "00000001-0000-4000-a000-000000000000", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const promo = (waves) => ({ pilot, policy: { ...policy, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 }, mode: "devices", plan: { waves: [], inPilot: [{ id: "w1" }], notEligible: [] }, waves, waveSize: 25 });
const wave = (n, s, extra) => ({ id: `88888888-0000-4000-8000-0000000000${n}0`, at: now, buildId: pilot.buildId, policyId: "p1", devices: [{ id: `w${n}`, hostname: `EXAMPLE-PC-0${n}` }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: [`w${n}`], endpointGroups: [] }, status: s, ...extra });
const allow = (n, s, extra) => ({ id: `99999999-0000-4000-8000-0000000000${n}0`, at: now, host: `h${n}.example.com`, site: `h${n}.example.com`, buildId: pilot.buildId, profileId: "pr1", listId: "al1", listName: "Example pilot allows", createdList: true, status: s, buildStatus: "built", ...extra });
const tagStep = (s, extra) => ({ op: "policy-tags", policyId: "b", policyName: "Base Policy", before: [{ tag: "Example tag", action: "block" }], after: [], status: s, ...extra });
const retireRec = (n, s, steps) => ({ id: `77777777-0000-4000-8000-0000000000${n}0`, tenantId: T, at: now, tags: ["Example tag"], snapshotFile: "example-tenant_20261017-010000.json", status: s, steps, warnings: [] });
const step = (order, kind, extra) => ({ order, kind, key: kind, name: `Example ${kind}`, method: "POST", path: "", summary: "", body: {}, status: "created", id: `${kind}-${order}`, readBack: "matches", ...extra });
const buildRec = (s, steps, extra) => ({ id: pilot.buildId, tenantId: T, createdAt: now, status: s, snapshotFile: "example-tenant_20261017-010000.json", pilot: { profileKey: "profile", name: pilot.policyName, enabled: false, targets: { endpoints: [] } }, steps, checks: [], ...extra });
const design = { policies: [], profiles: [], siteLists: [], limits: { profiles: { planned: 0, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
const cleanup = (lastLists) => ({ run: { scope: T, options: { dns: true, intelix: false }, intelixLookups: 0, running: false }, results: [], summary: { total: 1, covered: 0, remove: 0, exception: 1, needsDecision: 0 }, lists: [{ name: "Example cleaned Block", action: "block", sites: 1 }], leftOut: 0, lastLists: { tenantId: T, scope: T, createdAt: now, lists: lastLists }, intelix: false });
const listRow = (s, extra) => ({ name: "Example cleaned Block", action: "block", sites: 1, id: "l1", status: s, ...extra });

/** Each record not confirmed, the page that draws it, and the control that undoes or retries it. */
const PAGES = [
  { name: "Build: a build step not read back", page: `/build.html?tenant=${T}`, reads: { [`GET /api/build/${T}`]: { items: [buildRec("built", [step(1, "site-list", { readBack: "not-read", readBackNote: "x" }), step(2, "profile"), step(3, "policy")])] } }, control: "[data-rollback]" },
  { name: "Build: a rollback delete not confirmed", page: `/build.html?tenant=${T}`, reads: { [`GET /api/build/${T}`]: { items: [buildRec("rollback-partial", [step(1, "policy", { status: "delete-failed", deleteReadBack: NOT_READ })], { rollback: { at: now, steps: [{ kind: "policy", name: "Example policy", id: "policy-1", status: "not confirmed", error: "x" }] } })] } }, control: "[data-rollback]" },
  { name: "Clean up: a list made, not read back", page: `/cleanup.html?tenant=${T}`, reads: { [`GET /api/cleanup/${T}`]: cleanup([listRow("created", { readBack: NOT_READ })]) }, control: "#undo-lists" },
  { name: "Clean up: a list delete not confirmed", page: `/cleanup.html?tenant=${T}`, reads: { [`GET /api/cleanup/${T}`]: cleanup([listRow("not confirmed", { readBack: NOT_READ })]) }, control: "#undo-lists" },
  { name: "Clean up: a list still there after its delete", page: `/cleanup.html?tenant=${T}`, reads: { [`GET /api/cleanup/${T}`]: cleanup([listRow("still there after delete", { readBack: "still there" })]) }, control: "#undo-lists" },
  { name: "Pilot: an Allow not confirmed", page: `/pilot.html?tenant=${T}`, reads: { [`GET /api/pilot/${T}`]: { pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [allow(1, "added", { readBack: NOT_READ })] } }, control: "[data-undo]" },
  { name: "Pilot: an Allow whose link didn't go through", page: `/pilot.html?tenant=${T}`, reads: { [`GET /api/pilot/${T}`]: { pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [allow(1, "partial", { readBack: "list holds the site", error: "x" })] } }, control: "[data-undo]" },
  { name: "Pilot: an Allow whose link Sophos didn't answer with a success and that wasn't read back", page: `/pilot.html?tenant=${T}`, reads: { [`GET /api/pilot/${T}`]: { pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [allow(1, "partial", { readBack: `list holds the site; profile ${NOT_READ}`, answer: "Sophos API error 500: InternalServerError", error: "x" })] } }, control: "[data-undo]" },
  { name: "Pilot: an Allow undo not confirmed", page: `/pilot.html?tenant=${T}`, reads: { [`GET /api/pilot/${T}`]: { pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [allow(1, "undo-failed", { readBack: "site listed", undoReadBack: NOT_READ, error: "x" })] } }, control: "[data-undo]" },
  // A create Sophos didn't confirm was made (no id): the rollback or undo looks for it by name (v0.3.25).
  { name: "Build: a step Sophos didn't confirm was made", page: `/build.html?tenant=${T}`, reads: { [`GET /api/build/${T}`]: { items: [buildRec("partial", [step(1, "site-list", { status: "unconfirmed", id: undefined, answer: "Sophos API error 500: InternalServerError", readBack: "not-read", readBackNote: "x" }), step(2, "profile", { status: "planned", id: undefined, readBack: undefined })])] } }, control: "[data-rollback]" },
  { name: "Clean up: a list Sophos didn't confirm was made", page: `/cleanup.html?tenant=${T}`, reads: { [`GET /api/cleanup/${T}`]: cleanup([listRow("unconfirmed", { id: undefined, answer: "Sophos API error 500: InternalServerError", readBack: NOT_READ })]) }, control: "#undo-lists" },
  { name: "Pilot: an Allow whose new list Sophos didn't confirm was made", page: `/pilot.html?tenant=${T}`, reads: { [`GET /api/pilot/${T}`]: { pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [allow(1, "unconfirmed", { listId: undefined, createdList: false, readBack: NOT_READ, answer: "Sophos API error 500: InternalServerError" })] } }, control: "[data-undo]" },
  { name: "Promote: a wave not confirmed", page: `/promote.html?tenant=${T}`, reads: { [`GET /api/promote/${T}`]: promo([wave(1, "unconfirmed", { readBack: NOT_READ, error: "x" })]) }, control: "[data-undo-wave]" },
  { name: "Promote: a wave undo not confirmed", page: `/promote.html?tenant=${T}`, reads: { [`GET /api/promote/${T}`]: promo([wave(1, "undo-failed", { readBack: "assignment matches", undoReadBack: NOT_READ, error: "x" })]) }, control: "[data-undo-wave]" },
  { name: "Promote: a retire step not confirmed", page: `/promote.html?tenant=${T}`, reads: { [`GET /api/retire/${T}`]: { tags: [], records: [retireRec(1, "partial", [tagStep("unconfirmed", { readBack: "tags differ", error: "Read back: tags differ." })])] } }, control: "[data-restore]" },
  { name: "Promote: a restore step Sophos didn't answer with a success and that wasn't read back", page: `/promote.html?tenant=${T}`, reads: { [`GET /api/retire/${T}`]: { tags: [], records: [retireRec(1, "restore-partial", [tagStep("restore-failed", { readBack: NOT_READ, answer: "Sophos API error 500: InternalServerError", error: "The tool couldn't read it back, so the restore isn't confirmed." })])] } }, control: "[data-restore]" },
  { name: "Promote: a restore step not confirmed", page: `/promote.html?tenant=${T}`, reads: { [`GET /api/retire/${T}`]: { tags: [], records: [retireRec(1, "restore-partial", [tagStep("restore-failed", { readBack: NOT_READ, error: "The tool couldn't read it back, so the restore isn't confirmed." })])] } }, control: "[data-restore]" },
];

const READS = {
  "GET /api/readiness": null,
  [`GET /api/design/${T}`]: { design, genAi: {} },
  [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
  [`GET /api/build/${T}`]: { items: [] },
  [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([]) },
  [`GET /api/promote/${T}`]: promo([]),
  [`GET /api/retire/${T}`]: { tags: [], records: [] },
};

test("each page draws the undo or retry for a write Sophos accepted that the read-back didn't confirm", { skip: skipBrowser, timeout: 120_000 }, async () => {
  let reads = READS;
  const app = express();
  app.use(express.json());
  app.all("/api/*", (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(status);
    const out = reads[key];
    if (out === undefined || out === null) return res.status(404).json({ error: "not_found" });
    res.json(out);
  });
  app.use(express.static(path.join(root, "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let b;
  try {
    b = await openBrowser();
    const wrong = [];
    for (const p of PAGES) {
      reads = { ...READS, ...p.reads };
      try {
        await b.open(`${base}${p.page}`, 1440, "h1");
        let found = false;
        for (let i = 0; i < 50 && !(found = await b.evaluate(`!!document.querySelector(${JSON.stringify(p.control)})`)); i++) await new Promise((r) => setTimeout(r, 100));
        if (!found) wrong.push(`${p.name}: no ${p.control}`);
        else if (await b.evaluate(`document.querySelector(${JSON.stringify(p.control)}).disabled`)) wrong.push(`${p.name}: ${p.control} is off`);
      } catch (err) {
        wrong.push(`${p.name}: ${err.message}`);
      }
    }
    assert.deepEqual(wrong, []);
  } finally {
    srv.close();
    await b?.close();
  }
});
