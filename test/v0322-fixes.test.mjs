// v0.3.22, in what the services record: a wave, a wave undo, an Allow, an
// Allow undo and a retire step that Sophos answered with a 5xx, and that no
// read-back could read after, keep what Sophos said, so the pages don't say
// Sophos accepted them; an Allow undo whose list delete isn't confirmed keeps
// the delete's read-back on the build step, as a rollback does, so the Build
// page shows it not confirmed rather than failed; a run of the older service
// tests, or of the browser tests, leaves nothing in the temp directory; and
// every test that starts the server or a browser gives it a temp folder of its
// own. Each service case runs against an in-memory tenant (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { getBuild } from "../backend/dist/services/build-service.js";
import { addAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { moveWave, undoWave } from "../backend/dist/services/promote-service.js";
import { restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";
import { skipBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOT_READ = `not read: ${UNAVAILABLE}`;

before(() => setReadBackDelays([0, 0]));

/** Matching writes answered 500, and the reads matching read refused (503) from the next write on, until off(). */
function unanswered(tenant, method, write, read) {
  let on = true;
  const w = afterWrite(tenant);
  tenant.unclear(method, write, () => on);
  tenant.refuse("GET", read, 503, () => on && w());
  return () => (on = false);
}

/** Only the read refused (503) from the next write on: Sophos accepted the write. */
function unread(tenant, read) {
  let on = true;
  const w = afterWrite(tenant);
  tenant.refuse("GET", read, 503, () => on && w());
  return () => (on = false);
}

// ---------- item 1: waves ----------

test("a wave move or undo Sophos answered 500, with nothing read back after, keeps what Sophos said; one it accepted doesn't", async () => {
  const dataDir = await dataDirFor("v0322-wave");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const POLICY = new RegExp(`/policies/${policyId}$`);
  let off = unanswered(tenant, "PATCH", POLICY, POLICY);
  const moved = await moveWave(dataDir, ctxOf(tenant), ["w2"], false);
  off();
  assert.deepEqual([moved.status, moved.readBack, moved.answer], ["unconfirmed", NOT_READ, UNCLEAR]);
  // Accepted, and not read back: as before.
  off = unread(tenant, POLICY);
  const accepted = await moveWave(dataDir, ctxOf(tenant), ["w3"], false);
  off();
  assert.deepEqual([accepted.status, accepted.readBack, accepted.answer], ["unconfirmed", NOT_READ, undefined]);
  await undoWave(dataDir, ctxOf(tenant), accepted.id);
  // The undo of the first wave, answered 500 and not read back.
  off = unanswered(tenant, "PATCH", POLICY, POLICY);
  const undo = await undoWave(dataDir, ctxOf(tenant), moved.id);
  off();
  assert.deepEqual([undo.status, undo.undoReadBack, undo.undoAnswer], ["undo-failed", NOT_READ, UNCLEAR]);
  // Sent again and confirmed: nothing of the last attempt is left.
  const again = await undoWave(dataDir, ctxOf(tenant), moved.id);
  assert.deepEqual([again.status, again.undoReadBack, again.undoAnswer], ["undone", undefined, undefined]);
});

// ---------- item 1: Allow, and item 5: its undo's list delete on the build ----------

const SITES = /\/site-lists\/[^/]+\/sites$/;

test("an Allow Sophos answered 500, with the list not read back after, keeps what Sophos said; one it accepted doesn't", async () => {
  const dataDir = await dataDirFor("v0322-allow");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  await addAllow(dataDir, ctxOf(tenant), "chat.example.org");
  let off = unanswered(tenant, "POST", SITES, SITES);
  const { entry } = await addAllow(dataDir, ctxOf(tenant), "app.example.com");
  off();
  assert.deepEqual([entry.status, entry.readBack, entry.answer], ["added", NOT_READ, UNCLEAR]);
  off = unread(tenant, SITES);
  const { entry: accepted } = await addAllow(dataDir, ctxOf(tenant), "files.example.net");
  off();
  assert.deepEqual([accepted.status, accepted.readBack, accepted.answer], ["added", NOT_READ, undefined]);
});

test("an Allow undo Sophos answered 500, with nothing read back after, keeps what Sophos said, and only then", async () => {
  const dataDir = await dataDirFor("v0322-allow-undo-site");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  await addAllow(dataDir, ctxOf(tenant), "chat.example.org");
  const { entry } = await addAllow(dataDir, ctxOf(tenant), "app.example.com");
  const { entry: other } = await addAllow(dataDir, ctxOf(tenant), "files.example.net");
  // A site's delete, in a list another Allow still uses.
  let off = unanswered(tenant, "DELETE", /\/sites\/[^/]+$/, SITES);
  const undo = await undoAllow(dataDir, ctxOf(tenant), entry.id);
  off();
  assert.deepEqual([undo.status, undo.undoReadBack, undo.undoAnswer], ["undo-failed", NOT_READ, UNCLEAR]);
  // Accepted, and not read back: nothing said.
  off = unread(tenant, SITES);
  const accepted = await undoAllow(dataDir, ctxOf(tenant), other.id);
  off();
  assert.deepEqual([accepted.status, accepted.undoReadBack, accepted.undoAnswer], ["undo-failed", NOT_READ, undefined]);
  // Sent again and confirmed: nothing of the last attempt is left.
  const again = await undoAllow(dataDir, ctxOf(tenant), entry.id);
  assert.deepEqual([again.status, again.undoReadBack, again.undoAnswer], ["undone", undefined, undefined]);
});

test("an Allow undo whose list delete isn't confirmed keeps its read-back on the build step, as a rollback does, so it isn't a failed delete", async () => {
  const dataDir = await dataDirFor("v0322-allow-undo-list");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const { entry } = await addAllow(dataDir, ctxOf(tenant), "chat.example.org");
  const LIST = new RegExp(`/site-lists/${entry.listId}$`);
  const stepOf = async () => (await getBuild(dataDir, T, entry.buildId)).steps.find((s) => s.id === entry.listId);
  const relink = () => {
    // The undo unlinked it: link it again, so the next undo sends the delete again.
    const p = [...tenant.profiles.values()][0];
    if (!p.siteListActions.some((a) => a.id === entry.listId)) p.siteListActions.push({ id: entry.listId, action: "allow", priority: 2 });
  };
  // Answered 500, nothing read back: not confirmed, with what Sophos said.
  let off = unanswered(tenant, "DELETE", LIST, LIST);
  const undo = await undoAllow(dataDir, ctxOf(tenant), entry.id);
  off();
  assert.deepEqual([undo.status, undo.undoReadBack, undo.undoAnswer], ["undo-failed", NOT_READ, UNCLEAR]);
  let step = await stepOf();
  assert.deepEqual([step.status, step.deleteReadBack, step.deleteAnswer], ["delete-failed", NOT_READ, UNCLEAR]);
  // Accepted, and not read back: not confirmed, with nothing said.
  tenant.lists.set(entry.listId, { id: entry.listId, name: entry.listName, sites: [{ id: "s1", site: "chat.example.org" }] });
  relink();
  off = unread(tenant, LIST);
  await undoAllow(dataDir, ctxOf(tenant), entry.id);
  off();
  step = await stepOf();
  assert.deepEqual([step.status, step.deleteReadBack, step.deleteAnswer], ["delete-failed", NOT_READ, undefined]);
  // Answered 500 and found still there: not deleted, as a rollback counts it.
  tenant.lists.set(entry.listId, { id: entry.listId, name: entry.listName, sites: [{ id: "s1", site: "chat.example.org" }] });
  relink();
  let still = true;
  tenant.ignore("DELETE", LIST, () => still);
  tenant.unclear("DELETE", LIST, () => still);
  const kept = await undoAllow(dataDir, ctxOf(tenant), entry.id);
  still = false;
  assert.equal(kept.status, "undo-failed");
  step = await stepOf();
  assert.deepEqual([step.status, step.deleteReadBack, step.deleteAnswer], ["delete-failed", undefined, undefined]);
  // Sent again and confirmed.
  tenant.rules.length = 0;
  relink();
  const done = await undoAllow(dataDir, ctxOf(tenant), entry.id);
  assert.equal(done.status, "undone", JSON.stringify(done));
  step = await stepOf();
  assert.deepEqual([step.status, step.deleteReadBack, step.deleteAnswer], ["deleted", undefined, undefined]);
});

// ---------- item 1: retire ----------

test("a retire step Sophos answered 500, with nothing read back after, keeps what Sophos said; a restore clears it", async () => {
  const dataDir = await dataDirFor("v0322-retire");
  const { tenant, pol } = await retireTenant(dataDir);
  const POLICY = new RegExp(`/policies/${pol.id}$`);
  const off = unanswered(tenant, "PATCH", POLICY, POLICY);
  const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
  off();
  assert.deepEqual(rec.steps.map((s) => [s.op, s.status, s.answer]), [["policy-tags", "unconfirmed", UNCLEAR], ["delete-entry", "done", undefined], ["patch-entry", "done", undefined]]);
  assert.equal(rec.steps[0].readBack, NOT_READ);
  tenant.rules.length = 0;
  const back = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
  assert.equal(back.status, "restored");
  assert.ok(back.steps.every((s) => s.answer === undefined), JSON.stringify(back.steps));
  // Accepted, and not read back: no answer kept.
  const dir2 = await dataDirFor("v0322-retire-accepted");
  const s2 = await retireTenant(dir2);
  const off2 = unread(s2.tenant, new RegExp(`/policies/${s2.pol.id}$`));
  const rec2 = await retire(dir2, ctxOf(s2.tenant), ["old"], true, TOOL);
  off2();
  assert.deepEqual([rec2.steps[0].status, rec2.steps[0].readBack, rec2.steps[0].answer], ["unconfirmed", NOT_READ, undefined]);
});

// ---------- items 2 and 3: the temp directory ----------

/** Runs test files in a temp directory of their own, with env added, and gives back what's left in it and the TAP counts. */
function runIn(files, env, timeout) {
  const tmp = mkdtempSync(path.join(tmpdir(), "wpa-v0322-tmp-"));
  try {
    const runEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...env(tmp) };
    // This file runs under the test runner, which marks its processes; the run below is a run of its own.
    delete runEnv.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files.map((f) => path.join(root, "test", `${f}.test.mjs`))], { env: runEnv, encoding: "utf8", timeout });
    const count = (what) => Number(new RegExp(`^# ${what} (\\d+)$`, "m").exec(run.stdout ?? "")?.[1] ?? -1);
    return { left: readdirSync(tmp), tests: count("tests"), pass: count("pass"), skipped: count("skipped"), out: `${(run.stdout ?? "").slice(-1500)} ${(run.stderr ?? "").slice(-1500)}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const OLDER = ["v035-readonly", "v037-hardening", "v038-fixes", "v039-fixes", "v0310-fixes", "v0311-fixes", "v0312-fixes", "v0313-fixes", "v0314-fixes", "drop3-services", "snapshot"];

test("a run of the older service tests (v0.3.5 to v0.3.14, drop 3, snapshots) leaves nothing in the temp directory", { timeout: 300_000 }, () => {
  // Browser tests are off in it, so it adds no browser to the run it's part of.
  const r = runIn(OLDER, () => ({ WPA_SKIP_BROWSER: "1" }), 240_000);
  assert.ok(r.tests > 50 && r.pass === r.tests, `the run didn't pass: ${r.out}`);
  assert.deepEqual(r.left, [], "folders left behind");
});

test("a run of browser tests leaves nothing in the temp directory, the browser's own folders included", { skip: skipBrowser, timeout: 300_000 }, () => {
  // Chrome on macOS makes its temp folders where MAC_CHROMIUM_TMPDIR says, not TMPDIR, so the run points both here.
  const r = runIn(["v039-phone-layout", "v0310-pages"], (tmp) => ({ MAC_CHROMIUM_TMPDIR: tmp }), 240_000);
  assert.ok(r.tests >= 4 && r.pass === r.tests && r.skipped === 0, `the run didn't pass: ${r.out}`);
  assert.deepEqual(r.left, [], "folders left behind");
});

test("every test that starts the server or a browser gives it a temp folder of its own", () => {
  // A server a test starts can start a browser for a PDF, which, slowed by a loaded computer, leaves a folder too.
  const wrong = [];
  for (const f of readdirSync(path.join(root, "test")).filter((n) => n.endsWith(".mjs") && n !== "v0322-fixes.test.mjs")) {
    const s = readFileSync(path.join(root, "test", f), "utf8");
    if (s.includes("spawn(") && s.includes(["backend", "dist", "server.js"].join("/")) && !s.includes("...tempIn(")) wrong.push(`${f} starts the server without tempIn()`);
    if (s.includes("spawn(browser,") && !s.includes("env: browserEnv(")) wrong.push(`${f} starts a browser without browserEnv()`);
  }
  assert.deepEqual(wrong, []);
});
