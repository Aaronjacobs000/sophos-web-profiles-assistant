// v0.3.23, in what the services record: a write Sophos answered with a 5xx
// is read back before anything is said about it. The pilot switch is done
// when the read-back finds it, refused when it finds the pilot as it was, and
// not confirmed, with what Sophos said, when nothing could be read. A retire's
// restore and a rollback's Website Management restore read back the same way.
// An Allow whose link to the profile can't be read back keeps what Sophos
// said, and so does an Allow list or a restore's re-created entry found by
// name after a 5xx but not read back. An Allow undo whose list delete a
// read-back still found says why on the build step. And a PDF export leaves
// nothing in the temp directory, made or not. Each service case runs against
// an in-memory tenant (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { getBuild, rollback, saveRecord } from "../backend/dist/services/build-service.js";
import { addAllow, planAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { setPilotEnabled } from "../backend/dist/services/promote-service.js";
import { restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { runReadiness } from "../backend/dist/services/readiness.js";
import { findBrowser, htmlToPdf } from "../backend/dist/services/pdf.js";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";

const NOT_READ = `not read: ${UNAVAILABLE}`;

before(() => setReadBackDelays([0, 0]));

const auditOf = (dataDir) => readFileSync(path.join(dataDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

// ---------- item 1: the pilot switch ----------

test("the pilot switch Sophos answered 500 says what the read-back found: on, still off, or nothing read", async () => {
  const dataDir = await dataDirFor("v0323-switch");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const POLICY = new RegExp(`/policies/${policyId}$`);
  const pol = tenant.policies.get(policyId);
  // Made, then answered 500: found on, so it's done, and the audit log says how.
  tenant.unclear("PATCH", POLICY);
  assert.deepEqual(await setPilotEnabled(dataDir, ctx, true), { enabled: true, readBack: "matches" });
  tenant.rules.length = 0;
  assert.ok(auditOf(dataDir).some((e) => e.ok && e.resourceId === policyId && /^Sophos answered 500, but a read-back found the pilot on in the tenant/.test(e.detail?.note ?? "")));
  // Answered 500, and read back still off: refused, saying so.
  pol.enabled = false;
  tenant.ignore("PATCH", POLICY);
  tenant.unclear("PATCH", POLICY);
  const refused = await setPilotEnabled(dataDir, ctx, true).then(() => "", (err) => err.message);
  tenant.rules.length = 0;
  assert.equal(refused, `${UNCLEAR}. A read-back found the pilot still off, so it wasn't turned on.`);
  // Answered 500, and nothing read back: not confirmed, with what Sophos said.
  tenant.unclear("PATCH", POLICY);
  tenant.refuse("GET", POLICY, 503, afterWrite(tenant));
  const unread = await setPilotEnabled(dataDir, ctx, true);
  tenant.rules.length = 0;
  assert.deepEqual(unread, { enabled: true, readBack: NOT_READ, answer: UNCLEAR });
  // Accepted, and nothing read back: as before, with nothing said.
  tenant.refuse("GET", POLICY, 503, afterWrite(tenant));
  assert.deepEqual(await setPilotEnabled(dataDir, ctx, false), { enabled: false, readBack: NOT_READ });
});

// ---------- item 2: a retire's restore ----------

/** A tenant whose tag "old" was retired, and its record. */
async function retired(name) {
  const dataDir = await dataDirFor(name);
  const { tenant, pol } = await retireTenant(dataDir);
  const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
  assert.equal(rec.status, "retired");
  return { dataDir, tenant, pol, rec };
}

const stepsOf = (r) => Object.fromEntries(r.steps.map((s) => [s.op, [s.status, s.readBack, s.answer, s.error]]));

test("a restore step Sophos answered 500 is read back: restored when it's found put back, failed when found unchanged", async () => {
  const made = await retired("v0323-restore-made");
  made.tenant.unclear("PATCH", /./);
  const back = await restoreRetire(made.dataDir, ctxOf(made.tenant), made.rec.id);
  assert.equal(back.status, "restored", JSON.stringify(stepsOf(back)));
  assert.ok(auditOf(made.dataDir).some((e) => e.ok && e.action === "restore-tags" && /but a read-back found the change in the tenant/.test(e.detail?.note ?? "")));
  const kept = await retired("v0323-restore-unchanged");
  kept.tenant.ignore("PATCH", new RegExp(`/policies/${kept.pol.id}$`));
  kept.tenant.unclear("PATCH", new RegExp(`/policies/${kept.pol.id}$`));
  const failed = await restoreRetire(kept.dataDir, ctxOf(kept.tenant), kept.rec.id);
  assert.deepEqual(stepsOf(failed)["policy-tags"], ["restore-failed", undefined, undefined, `${UNCLEAR}. A read-back found it unchanged (tags differ), so it wasn't restored.`]);
  assert.deepEqual([stepsOf(failed)["delete-entry"][0], stepsOf(failed)["patch-entry"][0]], ["restored", "restored"]);
});

test("a restore step Sophos answered 500, with nothing read back after, isn't confirmed and keeps what Sophos said", async () => {
  const { dataDir, tenant, pol, rec } = await retired("v0323-restore-unread");
  tenant.unclear("PATCH", /./);
  // From the restore's second write (its first is the entry it re-creates, read back before this), reads by id fail.
  tenant.refuse("GET", /\/(local-sites|policies)\/[^/]+$/, 503, afterWrite(tenant, tenant.writes + 1));
  const first = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
  tenant.rules.length = 0;
  const why = "The tool couldn't read it back, so the restore isn't confirmed.";
  assert.deepEqual(stepsOf(first), {
    "delete-entry": ["restored", "re-created, matches", undefined, undefined],
    "patch-entry": ["restore-failed", NOT_READ, UNCLEAR, why],
    "policy-tags": ["restore-failed", NOT_READ, UNCLEAR, why],
  });
  assert.equal(first.status, "restore-partial");
  // Restore again: done, with nothing left of the last attempt.
  const again = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
  assert.equal(again.status, "restored", JSON.stringify(stepsOf(again)));
  assert.ok(again.steps.every((s) => s.answer === undefined));
  assert.deepEqual(tenant.policies.get(pol.id).settings["endpoint.web-control.tags.settings"].value.map((x) => x.tag), ["old", "keep"]);
});

// ---------- items 2 and 4: a restore's re-created entry ----------

test("a re-created entry Sophos answered 500, found by its URL but not read back, keeps what Sophos said; so does one Website Management couldn't be read for", async () => {
  const found = await retired("v0323-recreate-found");
  found.tenant.unclear("POST", /\/local-sites$/);
  found.tenant.refuse("GET", /\/local-sites\/[^/]+$/, 503, afterWrite(found.tenant));
  const r1 = await restoreRetire(found.dataDir, ctxOf(found.tenant), found.rec.id);
  const step1 = r1.steps.find((s) => s.op === "delete-entry");
  assert.deepEqual([step1.status, step1.readBack, step1.answer, !!step1.newId], ["restore-failed", NOT_READ, UNCLEAR, true]);
  // Found and read back as it was: restored, with nothing said.
  const clean = await retired("v0323-recreate-matches");
  clean.tenant.unclear("POST", /\/local-sites$/);
  const r2 = await restoreRetire(clean.dataDir, ctxOf(clean.tenant), clean.rec.id);
  assert.deepEqual(stepsOf(r2)["delete-entry"], ["restored", "re-created, matches", undefined, undefined]);
  // Website Management not read after the 500, so nothing says whether it was made: not confirmed, not failed.
  const unread = await retired("v0323-recreate-unread");
  unread.tenant.unclear("POST", /\/local-sites$/);
  unread.tenant.refuse("GET", /\/local-sites$/, 503, afterWrite(unread.tenant));
  const r3 = await restoreRetire(unread.dataDir, ctxOf(unread.tenant), unread.rec.id);
  unread.tenant.rules.length = 0;
  const step3 = r3.steps.find((s) => s.op === "delete-entry");
  assert.deepEqual([step3.status, step3.readBack, step3.answer, step3.newId], ["restore-failed", NOT_READ, UNCLEAR, undefined]);
  // It was made, so the next restore finds it there.
  const again = await restoreRetire(unread.dataDir, ctxOf(unread.tenant), unread.rec.id);
  assert.deepEqual(stepsOf(again)["delete-entry"].slice(0, 2), ["restored", "already there"]);
});

// ---------- item 2: a rollback's Website Management restore ----------

/** A pilot built after a snapshot that has an entry the tenant has lost since, so a rollback re-creates it; rules set before it. */
async function wmRollback(name, rules) {
  const dataDir = await dataDirFor(name);
  const tenant = new Tenant();
  const { build } = seedPilot(tenant, dataDir);
  const id = randomUUID();
  tenant.localSites.set(id, { id, url: "kept.example.com", tags: ["staff"] });
  const run = await runReadiness(dataDir, tenant, { id: T, name: "Example Tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, TOOL);
  await saveRecord(dataDir, { ...(await getBuild(dataDir, T, build.id)), snapshotFile: run.snapshot.file });
  tenant.localSites.delete(id);
  rules(tenant);
  const r = await rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false });
  tenant.rules.length = 0;
  return { r, wm: r.rollback.steps.filter((s) => s.kind === "website-management").map((s) => [s.name, s.status, s.answer, s.error]), tenant };
}

test("a rollback's Website Management change Sophos answered 500 is read back: done when it's there, failed when it isn't, not confirmed when nothing was read", async () => {
  const made = await wmRollback("v0323-wm-made", (t) => t.unclear("POST", /\/local-sites$/));
  assert.equal(made.r.status, "rolled-back", JSON.stringify(made.wm));
  assert.deepEqual(made.wm, [["create kept.example.com", "done", undefined, undefined], ["Website Management read back", "matches the snapshot", undefined, undefined]]);
  const unmade = await wmRollback("v0323-wm-unmade", (t) => {
    t.ignore("POST", /\/local-sites$/);
    t.unclear("POST", /\/local-sites$/);
  });
  assert.equal(unmade.r.status, "rollback-partial");
  assert.deepEqual(unmade.wm, [["create kept.example.com", "failed", undefined, `${UNCLEAR}. A read-back found it not as the snapshot has it, so it wasn't made.`]]);
  const unread = await wmRollback("v0323-wm-unread", (t) => {
    t.unclear("POST", /\/local-sites$/);
    t.refuse("GET", /\/local-sites$/, 503, afterWrite(t));
  });
  assert.equal(unread.r.status, "rollback-partial");
  assert.deepEqual(unread.wm, [["create kept.example.com", "not confirmed", UNCLEAR, `${UNCLEAR}. A read-back couldn't read Website Management (${UNAVAILABLE}), so the change isn't confirmed.`]]);
  assert.equal(unread.tenant.localSites.size, 1, "it was made");
});

// ---------- item 3: an Allow's link to the profile ----------

test("an Allow whose link Sophos answered 500, with the profile not read back after, keeps what Sophos said, and the next Allow says the link isn't confirmed", async () => {
  const dataDir = await dataDirFor("v0323-allow-link");
  const tenant = new Tenant();
  const { profileId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const PROFILE = new RegExp(`/profiles/${profileId}$`);
  tenant.unclear("PUT", PROFILE);
  // From the Allow's second write (the link; its first makes the list), reads of the profile fail.
  tenant.refuse("GET", PROFILE, 503, afterWrite(tenant, tenant.writes + 1));
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  tenant.rules.length = 0;
  assert.deepEqual([entry.status, entry.readBack, entry.answer], ["partial", `list holds the site; profile not read: ${UNAVAILABLE}`, UNCLEAR]);
  const plan = await planAllow(dataDir, ctx, "video.example.net");
  assert.match(plan.problems.join(" "), /from the Allow for chat\.example\.org is in the tenant, but its link to the profile isn't confirmed\. Undo that Allow first/);
  const undone = await undoAllow(dataDir, ctx, entry.id);
  assert.equal(undone.status, "undone", undone.error);
  assert.equal(tenant.profiles.get(profileId).siteListActions.length, 1, "unlinked");
  // Answered 500, and the profile read back without the link: it didn't go through, as before.
  tenant.ignore("PUT", PROFILE);
  tenant.unclear("PUT", PROFILE);
  const { entry: unlinked } = await addAllow(dataDir, ctx, "files.example.net");
  tenant.rules.length = 0;
  assert.deepEqual([unlinked.status, unlinked.readBack, unlinked.answer], ["partial", "list holds the site", undefined]);
  assert.match((await planAllow(dataDir, ctx, "video.example.net")).problems.join(" "), /but its link to the profile didn't go through\./);
});

// ---------- item 4: an Allow's list found by name ----------

test("an Allow list Sophos answered 500, found by name but not read back holding the site, keeps what Sophos said; one read back holding it doesn't", async () => {
  const dataDir = await dataDirFor("v0323-allow-create");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  tenant.unclear("POST", /\/site-lists$/);
  tenant.refuse("GET", /\/site-lists\/[^/]+(\/sites)?$/, 503, afterWrite(tenant));
  const { entry } = await addAllow(dataDir, ctxOf(tenant), "chat.example.org");
  tenant.rules.length = 0;
  assert.deepEqual([entry.status, entry.readBack, entry.answer], ["added", `${NOT_READ}; profile links it as allow`, UNCLEAR]);
  const dir2 = await dataDirFor("v0323-allow-create-read");
  const t2 = new Tenant();
  seedPilot(t2, dir2);
  t2.unclear("POST", /\/site-lists$/);
  const { entry: read } = await addAllow(dir2, ctxOf(t2), "chat.example.org");
  assert.deepEqual([read.status, read.readBack, read.answer], ["added", "list holds the site; profile links it as allow", undefined]);
});

// ---------- item 5: an Allow undo's list delete on the build ----------

test("an Allow undo whose list delete Sophos answered 500, with the list read back still there, says why on the build step; a rollback clears it", async () => {
  const dataDir = await dataDirFor("v0323-allow-undo-still");
  const tenant = new Tenant();
  const { build } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  const LIST = new RegExp(`/site-lists/${entry.listId}$`);
  const stepOf = async () => (await getBuild(dataDir, T, build.id)).steps.find((s) => s.id === entry.listId);
  tenant.ignore("DELETE", LIST);
  tenant.unclear("DELETE", LIST);
  const undo = await undoAllow(dataDir, ctx, entry.id);
  tenant.rules.length = 0;
  assert.equal(undo.status, "undo-failed");
  const step = await stepOf();
  assert.deepEqual([step.status, step.deleteReadBack, step.deleteAnswer, step.deleteError], ["delete-failed", undefined, undefined, `${UNCLEAR}. A read-back still found the list, so it wasn't deleted.`]);
  const r = await rollback(dataDir, ctx, build.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  const after = await stepOf();
  assert.deepEqual([after.status, after.deleteError], ["deleted", undefined]);
});

// ---------- item 6: the PDF export's temp folders ----------

/**
 * Runs htmlToPdf with this process's temp folder settings pointed at a folder of the test's own, and gives back what's
 * left in it once it's done (it holds nothing before). env adds settings, such as CHROME_PATH.
 */
async function exportIn(env, run) {
  const own = mkdtempSync(path.join(tmpdir(), "wpa-v0323-pdf-"));
  const temp = path.join(own, "T");
  mkdirSync(temp);
  const keys = ["TMPDIR", "TMP", "TEMP", "MAC_CHROMIUM_TMPDIR", ...Object.keys(env)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { TMPDIR: temp, TMP: temp, TEMP: temp, MAC_CHROMIUM_TMPDIR: temp }, env);
  try {
    assert.deepEqual(readdirSync(temp), [], "the temp folder is empty before");
    const outcome = await run().then((pdf) => ({ pdf }), (err) => ({ error: err.message }));
    return { ...outcome, left: () => readdirSync(temp), own };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// A stand-in for Chrome or Edge: it makes a component download folder in its temp folder as Chrome does, then prints a
// PDF (ok), exits without one (fail), or runs until it's stopped (hang), writing in its profile and temp folder as it
// exits. When it's gone it writes the marker file, so the test can wait for that.
const FAKE = `#!/bin/sh
t="\${MAC_CHROMIUM_TMPDIR:-\${TMPDIR:-/tmp}}"
mkdir "$t/com.google.Chrome.chrome_chrome_url_fetcher_.$$"
for a in "$@"; do case "$a" in --print-to-pdf=*) out="\${a#--print-to-pdf=}";; --user-data-dir=*) profile="\${a#--user-data-dir=}";; esac; done
gone() { : > "$FAKE_MARKER"; exit "$1"; }
case "$FAKE_BROWSER" in
  ok) printf '%%PDF-1.4\\n' > "$out"; gone 0;;
  fail) gone 3;;
  hang) trap 'mkdir "$t/com.google.Chrome.$$"; sleep 1; mkdir -p "$profile/Default"; gone 0' TERM; while :; do sleep 0.1; done;;
esac
`;

test("a PDF export leaves nothing in the temp directory, the browser's own folders included, whether it's made, fails or times out", { skip: process.platform === "win32" ? "the stand-in browser is a shell script" : false, timeout: 60_000 }, async () => {
  const bin = mkdtempSync(path.join(tmpdir(), "wpa-v0323-bin-"));
  try {
    const fake = path.join(bin, "browser.sh");
    writeFileSync(fake, FAKE);
    chmodSync(fake, 0o755);
    const wrong = [];
    for (const mode of ["ok", "fail", "hang"]) {
      const marker = path.join(bin, `${mode}.done`);
      const r = await exportIn({ CHROME_PATH: fake, FAKE_BROWSER: mode, FAKE_MARKER: marker }, () => htmlToPdf("<h1>Example report</h1>", mode === "hang" ? 500 : 20_000));
      // The stand-in has gone once it writes the marker; wait for that, not a set time.
      for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((res) => setTimeout(res, 100));
      if (mode === "ok") assert.equal(r.pdf?.subarray(0, 5).toString(), "%PDF-", r.error);
      else assert.match(r.error ?? "", mode === "fail" ? /exited \(3\) without a PDF/ : /didn't finish the PDF within 0\.5 s/);
      if (r.left().length) wrong.push(`${mode}: ${r.left().join(", ")}`);
      rmSync(r.own, { recursive: true, force: true });
    }
    assert.deepEqual(wrong, [], "folders left in the temp directory");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

const browser = findBrowser();

test("a PDF export with the real browser leaves nothing in the temp directory, made or timed out", { skip: process.env.WPA_SKIP_BROWSER === "1" ? "browser tests are off for this run" : !browser ? "no Chrome or Edge on this computer" : false, timeout: 120_000 }, async () => {
  // A report whose image takes far longer than the timeout keeps the browser busy until it's stopped.
  const slow = http.createServer((req, res) => {
    const t = setTimeout(() => res.end(), 30_000);
    req.on("close", () => clearTimeout(t));
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  try {
    const wrong = [];
    const runs = [
      ["made", () => htmlToPdf("<h1>Example report</h1>")],
      ["timed out", () => htmlToPdf(`<h1>Example report</h1><img src="http://127.0.0.1:${slow.address().port}/slow.gif">`, 2_000)],
    ];
    for (const [what, run] of runs) {
      const r = await exportIn({}, run);
      if (what === "made") assert.equal(r.pdf?.subarray(0, 5).toString(), "%PDF-", r.error);
      else assert.match(r.error ?? "", /didn't finish the PDF within 2 s/);
      // The export is over once the browser has exited, so what's left now stays.
      const left = r.left();
      if (left.length) wrong.push(`${what}: ${left.join(", ")}`);
      rmSync(r.own, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    assert.deepEqual(wrong, [], "folders left in the temp directory");
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});
