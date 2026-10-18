// v0.3.21, in what the services record and accept: Undo last lists sends a
// delete Sophos refused again, as a rollback does; the advice after a create
// Sophos answered unclearly, and that a read-back didn't find, says what a
// rerun does; an Allow whose profile couldn't be read back after the link
// says so; a delete Sophos didn't answer with a success keeps what it said,
// so the page doesn't say Sophos accepted it; a retire that went on past a
// tag change it couldn't confirm names the policies that may still name the
// tag; and a run of the v0.3.19 and v0.3.20 service tests leaves no folder in
// the temp directory. Each case runs against an in-memory tenant
// (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { createLists, planLists, undoLists } from "../backend/dist/services/lists-service.js";
import { designFor, dryRun, execute, rollback } from "../backend/dist/services/build-service.js";
import { addAllow, planAllow } from "../backend/dist/services/pilot-service.js";
import { listRecords, restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, classicTenant, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

before(() => setReadBackDelays([0, 0]));

/** A switch a rule holds on: on() until off(). */
function flag() {
  let v = true;
  return { when: () => v, off: () => (v = false) };
}

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com"), result(2, "chat.example.org", "warn")];

// ---------- item 2: Undo last lists sends a refused delete again ----------

test("Undo last lists sends a delete Sophos refused again, as a rollback does, and it's deleted once Sophos takes it", async () => {
  const dataDir = await dataDirFor("v0321-lists-refused");
  const tenant = new Tenant();
  const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  const [block, warn] = rec.lists;
  const refusing = flag();
  tenant.refuse("DELETE", new RegExp(`/site-lists/${block.id}$`), 409, refusing.when);
  tenant.refuse("DELETE", new RegExp(`/site-lists/${warn.id}$`), 403, refusing.when);
  const first = await undoLists(dataDir, tenant, T);
  assert.deepEqual(first.lists.map((l) => l.status), ["in use by a profile, left", "delete failed"]);
  assert.equal(tenant.lists.size, 2, "both are still there");
  refusing.off();
  const again = await undoLists(dataDir, tenant, T);
  assert.deepEqual(again.lists.map((l) => [l.status, l.readBack, l.error]), [["deleted", "404 on read-back", undefined], ["deleted", "404 on read-back", undefined]]);
  assert.equal(tenant.calls.filter((c) => c.startsWith("DELETE ")).length, 4, "the second undo sent both deletes again");
  assert.equal(tenant.lists.size, 0);
});

// ---------- item 3: the advice after a create a read-back didn't find ----------

const SKIPPED = /anything in the tenant by then is skipped as already there/;
const REFUSED = /A name that's already taken is refused\./;
/** Makes every create matching pattern go unmade, then answered 500, while on() holds. */
function unmade(tenant, pattern) {
  const f = flag();
  tenant.ignore("POST", pattern, f.when);
  tenant.unclear("POST", pattern, f.when);
  return f.off;
}

/**
 * Each create a read-back may not find: make it go unmade and get its error, then put the object in the tenant (it shows
 * up late), and run it again. What the rerun does must be what the advice said it would.
 */
const CREATES = {
  "the build": async () => {
    const dataDir = await dataDirFor("v0321-late-build");
    const tenant = classicTenant();
    const ctx = ctxOf(tenant);
    const { design } = await designFor(dataDir, ctx);
    const pilot = { profileKey: design.profiles.find((p) => p.siteLists.length).key, enabled: false, targets: { endpoints: ["w1"] } };
    const off = unmade(tenant, /\/site-lists$/);
    const rec = await execute(dataDir, ctx, pilot, TOOL);
    off();
    const step = rec.steps.find((s) => s.status === "failed");
    assert.ok(step && !step.id, JSON.stringify(rec.steps));
    const late = randomUUID();
    tenant.lists.set(late, { id: late, name: step.name, sites: [{ id: randomUUID(), site: "blocked.example.com" }] });
    const again = await dryRun(dataDir, ctx, pilot);
    return { error: step.error, name: step.name, refused: again.checks.filter((c) => !c.ok).map((c) => c.text).join(" "), recorded: [] };
  },
  "Create site lists": async () => {
    const dataDir = await dataDirFor("v0321-late-lists");
    const tenant = new Tenant();
    const off = unmade(tenant, /\/site-lists$/);
    const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
    off();
    const row = rec.lists.find((l) => l.status === "failed");
    assert.ok(row && !row.id, JSON.stringify(rec.lists));
    const late = randomUUID();
    tenant.lists.set(late, { id: late, name: row.name, sites: [{ id: randomUUID(), site: "app.example.com" }] });
    const plan = await planLists(tenant, T, RESULTS, "Example cleaned");
    return { error: row.error, name: row.name, refused: plan.problems.join(" "), recorded: [] };
  },
  "a narrow Allow": async () => {
    const dataDir = await dataDirFor("v0321-late-allow");
    const tenant = new Tenant();
    seedPilot(tenant, dataDir);
    const ctx = ctxOf(tenant);
    const off = unmade(tenant, /\/site-lists$/);
    const plan = await planAllow(dataDir, ctx, "chat.example.org");
    const name = plan.steps.find((s) => s.op === "create-list").name;
    const error = await addAllow(dataDir, ctx, "chat.example.org").then(() => "", (err) => err.message);
    off();
    const late = randomUUID();
    tenant.lists.set(late, { id: late, name, sites: [{ id: randomUUID(), site: "chat.example.org" }] });
    const again = await planAllow(dataDir, ctx, "chat.example.org");
    return { error, name, refused: again.problems.join(" "), recorded: [] };
  },
  "a restore": async () => {
    const dataDir = await dataDirFor("v0321-late-restore");
    const { tenant } = await retireTenant(dataDir);
    const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
    assert.equal(rec.status, "retired");
    const off = unmade(tenant, /\/local-sites$/);
    const first = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
    off();
    const step = first.steps.find((s) => s.op === "delete-entry");
    assert.equal(step.status, "restore-failed");
    const late = randomUUID();
    tenant.localSites.set(late, { id: late, url: step.url, tags: ["old"] });
    const again = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
    const back = again.steps.find((s) => s.op === "delete-entry");
    return { error: step.error, name: step.url, refused: "", recorded: back.status === "restored" && back.newId === late ? [back.newId] : [] };
  },
};

for (const [what, run] of Object.entries(CREATES)) {
  test(`${what}: the advice after a create Sophos answered 500 that a read-back didn't find says what a rerun does`, async () => {
    const r = await run();
    assert.match(r.error, /Sophos API error 500: InternalServerError\. The tool read .* and found no /, r.error);
    if (SKIPPED.test(r.error)) {
      // A rerun that skips what's there must find the late one and record it.
      assert.equal(r.recorded.length, 1, `the advice says a rerun skips it, but the rerun didn't record it: ${r.error}`);
    } else {
      // A rerun that refuses a taken name: the advice says so, says where to look, and that the tool can't undo it.
      assert.match(r.error, REFUSED, r.error);
      assert.ok(r.error.includes(`look for the site list "${r.name}" in Sophos Fusion`), r.error);
      assert.match(r.error, /the tool has no record of it, so .+ won't remove it: delete it there, then/);
      assert.ok(r.refused.includes(`named "${r.name}" already exists`), `the advice says a taken name is refused, but the rerun said: ${r.refused}`);
    }
  });
}

// ---------- item 4: an Allow whose profile couldn't be read back ----------

test("an Allow whose link Sophos accepted, with every read of the profile after it failing, says the profile wasn't read", async () => {
  const dataDir = await dataDirFor("v0321-allow-profile-unread");
  const tenant = new Tenant();
  const { profileId } = seedPilot(tenant, dataDir);
  const put = `PUT /web-filters/v1/profiles/${profileId}`;
  tenant.refuse("GET", new RegExp(`/profiles/${profileId}$`), 503, () => tenant.calls.includes(put));
  const { entry } = await addAllow(dataDir, ctxOf(tenant), "chat.example.org");
  assert.ok(tenant.profiles.get(profileId).siteListActions.some((a) => a.id === entry.listId), "Sophos made the link");
  assert.equal(entry.status, "added");
  assert.equal(entry.readBack, `list holds the site; profile not read: ${UNAVAILABLE}`);
  // A profile that read back without the link still says so.
  const dir2 = await dataDirFor("v0321-allow-profile-unlinked");
  const t2 = new Tenant();
  const s2 = seedPilot(t2, dir2);
  t2.ignore("PUT", new RegExp(`/profiles/${s2.profileId}$`));
  const r2 = await addAllow(dir2, ctxOf(t2), "chat.example.org");
  assert.equal(r2.entry.readBack, "list holds the site; profile read back without the link");
});

// ---------- item 5: a delete Sophos didn't answer with a success ----------

test("Undo last lists keeps what Sophos said to a delete it didn't answer with a success, and only then", async () => {
  const dataDir = await dataDirFor("v0321-lists-answer");
  const tenant = new Tenant();
  const rec = await createLists(dataDir, tenant, T, T, [...RESULTS, result(3, "files.example.net", "allow")], "Example cleaned");
  const [a, b, c] = rec.lists;
  const reads = flag();
  tenant.refuse("GET", /\/site-lists\/[0-9a-f-]{36}$/, 503, (() => { const w = afterWrite(tenant); return () => reads.when() && w(); })());
  tenant.unclear("DELETE", new RegExp(`/site-lists/${a.id}$`));
  tenant.refuse("DELETE", new RegExp(`/site-lists/${c.id}$`), 404);
  const first = await undoLists(dataDir, tenant, T);
  assert.deepEqual(first.lists.map((l) => [l.status, l.deleteAnswer]), [
    ["not confirmed", UNCLEAR],
    ["not confirmed", undefined],
    ["not confirmed", "Sophos API error 404: NotFound"],
  ]);
  reads.off();
  tenant.rules.length = 0;
  const again = await undoLists(dataDir, tenant, T);
  assert.deepEqual(again.lists.map((l) => [l.status, l.deleteAnswer]), [["deleted", undefined], ["deleted", undefined], ["deleted", undefined]]);
});

test("a rollback keeps what Sophos said to a delete it didn't answer with a success, and only then", async () => {
  const dataDir = await dataDirFor("v0321-rollback-answer");
  const tenant = new Tenant();
  const { build, policyId, profileId } = seedPilot(tenant, dataDir);
  const reads = flag();
  tenant.refuse("GET", new RegExp(`/(policies/${policyId}|profiles/${profileId})$`), 503, (() => { const w = afterWrite(tenant); return () => reads.when() && w(); })());
  tenant.unclear("DELETE", new RegExp(`/policies/${policyId}$`));
  const first = await rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false });
  const by = (kind) => first.steps.find((s) => s.kind === kind);
  assert.deepEqual([by("policy").status, by("policy").deleteReadBack, by("policy").deleteAnswer], ["delete-failed", `not read: ${UNAVAILABLE}`, UNCLEAR]);
  // Sophos accepted the profile's delete: not confirmed, with nothing said.
  assert.deepEqual([by("profile").status, by("profile").deleteReadBack, by("profile").deleteAnswer], ["delete-failed", `not read: ${UNAVAILABLE}`, undefined]);
  reads.off();
  tenant.rules.length = 0;
  const again = await rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false });
  assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback.steps));
  assert.ok(again.steps.every((s) => s.deleteAnswer === undefined && s.deleteReadBack === undefined), JSON.stringify(again.steps));
});

// ---------- item 8: a retire that went on past a tag change it couldn't confirm ----------

test("a retire that went on past a tag change it couldn't confirm names the policy that may still name the tag, and a restore clears it", async () => {
  const dataDir = await dataDirFor("v0321-retire-tags-left");
  const { tenant, pol } = await retireTenant(dataDir);
  tenant.ignore("PATCH", new RegExp(`/policies/${pol.id}$`));
  const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
  assert.deepEqual(rec.steps.map((s) => [s.op, s.status]), [["policy-tags", "unconfirmed"], ["delete-entry", "done"], ["patch-entry", "done"]]);
  assert.deepEqual(rec.tagsMayRemain, [{ policyId: pol.id, policyName: "Sales", tags: ["old"] }]);
  assert.deepEqual((await listRecords(dataDir, T)).find((r) => r.id === rec.id).tagsMayRemain, rec.tagsMayRemain, "as saved");
  tenant.rules.length = 0;
  const back = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
  assert.equal(back.status, "restored", JSON.stringify(back.steps.map((s) => [s.status, s.error])));
  assert.equal(back.tagsMayRemain, undefined);
  assert.equal((await listRecords(dataDir, T)).find((r) => r.id === rec.id).tagsMayRemain, undefined);
});

test("a retire whose tag change was confirmed, or that stopped before any entry, names no policy; one saved by v0.3.20 that went on does", async () => {
  const dataDir = await dataDirFor("v0321-retire-tags-none");
  const { tenant, pol } = await retireTenant(dataDir);
  const done = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
  assert.equal(done.status, "retired");
  assert.equal(done.tagsMayRemain, undefined);
  // Refused: the retire stops at the tag change, so no entry was taken.
  const dir2 = await dataDirFor("v0321-retire-tags-refused");
  const s2 = await retireTenant(dir2);
  s2.tenant.refuse("PATCH", new RegExp(`/policies/${s2.pol.id}$`), 403);
  const stopped = await retire(dir2, ctxOf(s2.tenant), ["old"], true, TOOL);
  assert.deepEqual(stopped.steps.map((s) => s.status), ["failed", "planned", "planned"]);
  assert.equal(stopped.tagsMayRemain, undefined);
  // Saved by v0.3.20: the same steps, without the field.
  const dir = path.join(dataDir, "retire", T);
  mkdirSync(dir, { recursive: true });
  const id = "77777777-0000-4000-8000-000000000021";
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, tenantId: T, at: new Date().toISOString(), tags: ["old"], snapshotFile: done.snapshotFile, status: "partial", warnings: [], steps: [
    { op: "policy-tags", policyId: pol.id, policyName: "Sales", before: [{ tag: "old", action: "allow" }, { tag: "keep", action: "block" }], after: [{ tag: "keep", action: "block" }], status: "unconfirmed", readBack: `not read: ${UNAVAILABLE}`, error: "The tool couldn't read it back, so the change isn't confirmed." },
    { op: "delete-entry", id: randomUUID(), url: "a.example.com", tags: ["old"], status: "done", readBack: "404 on read-back" },
  ] }));
  assert.deepEqual((await listRecords(dataDir, T)).find((r) => r.id === id).tagsMayRemain, [{ policyId: pol.id, policyName: "Sales", tags: ["old"] }]);
});

// ---------- item 6: the temp directory ----------

test("a run of the v0.3.19 and v0.3.20 service tests leaves no folder of theirs in the temp directory", { timeout: 300_000 }, () => {
  // Their own temp directory, so tests running alongside this one don't count.
  const tmp = mkdtempSync(path.join(tmpdir(), "wpa-v0321-tmp-"));
  try {
    const ours = () => readdirSync(tmp).filter((n) => n.startsWith("wpa-"));
    const before = ours().length;
    const files = ["v0319-fixes", "v0320-fixes", "undo-paths"].map((f) => path.join(root, "test", `${f}.test.mjs`));
    // Browser tests are off in it, so it adds no browser to the run it's part of.
    const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, WPA_SKIP_BROWSER: "1" };
    // This file runs under the test runner, which marks its processes; the run below is a run of its own.
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { env, encoding: "utf8", timeout: 240_000 });
    const tests = Number(/^# tests (\d+)$/m.exec(run.stdout ?? "")?.[1] ?? 0);
    assert.ok(tests > 50, `the run didn't run: ${(run.stdout ?? "").slice(-1500)} ${(run.stderr ?? "").slice(-1500)}`);
    assert.deepEqual(ours(), [], "folders left behind");
    assert.equal(ours().length, before);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
