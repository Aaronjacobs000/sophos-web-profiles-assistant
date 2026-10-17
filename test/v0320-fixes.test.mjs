// v0.3.20: anything Sophos accepted that the read-back didn't confirm stays
// undoable or retryable, the same as a confirmed write (category D), in what
// the services record and accept. A wave not confirmed can be undone; Undo
// last lists sends the deletes it couldn't confirm again, and reads back a
// delete answered with a 5xx; an Allow whose list was made but not linked
// can be undone; a retire goes on past a step it couldn't confirm; and a
// restore record saved before v0.3.19 says a restore write that failed
// failed. Each case runs against an in-memory tenant (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { ALREADY_BEFORE, moveWave, undoWave } from "../backend/dist/services/promote-service.js";
import { addAllow, loadPilotRecord, planAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { createLists, undoLists } from "../backend/dist/services/lists-service.js";
import { getBuild } from "../backend/dist/services/build-service.js";
import { listRecords, restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

before(() => setReadBackDelays([0, 0]));

/** A switch a rule holds on: on() until off(). */
function flag() {
  let v = true;
  return { when: () => v, off: () => (v = false) };
}

// ---------- item 1: promotion ----------

test("a wave Sophos accepted whose read-back couldn't read the policy is kept as not confirmed, and can be undone", async () => {
  const dataDir = await dataDirFor("wave");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const reads = flag();
  tenant.refuse("GET", new RegExp(`/policies/${policyId}$`), 503, (() => { const w = afterWrite(tenant); return () => reads.when() && w(); })());
  const w = await moveWave(dataDir, ctx, ["w2"], false);
  assert.deepEqual(tenant.policies.get(policyId).appliesTo.endpoints, ["w1", "w2"], "Sophos made the change");
  assert.deepEqual([w.status, w.readBack], ["unconfirmed", `not read: ${UNAVAILABLE}`]);
  reads.off();
  const undone = await undoWave(dataDir, ctx, w.id);
  assert.equal(undone.status, "undone", undone.error);
  assert.equal(undone.readBack, "assignment back as before the wave");
  assert.deepEqual(tenant.policies.get(policyId).appliesTo.endpoints, ["w1"], "the undo put the assignment back");
});

test("a wave whose read-back found the old assignment is not confirmed; its undo, with the move never landed, sends nothing and is done", async () => {
  const dataDir = await dataDirFor("wave-differs");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const ignored = flag();
  tenant.ignore("PATCH", new RegExp(`/policies/${policyId}$`), ignored.when);
  const w = await moveWave(dataDir, ctx, ["w2"], false);
  assert.deepEqual([w.status, w.readBack], ["unconfirmed", "assignment differs"]);
  ignored.off();
  const writes = tenant.writes;
  const undone = await undoWave(dataDir, ctx, w.id);
  assert.deepEqual([undone.status, undone.readBack], ["undone", ALREADY_BEFORE]);
  assert.equal(tenant.writes, writes, "nothing was sent");
});

test("a wave Sophos answered with a 500 is read back: moved when the devices are on the pilot, failed when they aren't", async () => {
  const dataDir = await dataDirFor("wave-unclear");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const once = flag();
  tenant.unclear("PATCH", new RegExp(`/policies/${policyId}$`), once.when);
  const made = await moveWave(dataDir, ctx, ["w2"], false);
  assert.deepEqual([made.status, made.readBack], ["moved", "assignment matches"], made.error);
  once.off();
  // Answered 500, and not made.
  const dir2 = await dataDirFor("wave-unclear2");
  const t2 = new Tenant();
  const s2 = seedPilot(t2, dir2);
  // Answered 500 without the change being made: ignored, then unclear.
  t2.ignore("PATCH", new RegExp(`/policies/${s2.policyId}$`));
  t2.unclear("PATCH", new RegExp(`/policies/${s2.policyId}$`));
  const notMade = await moveWave(dir2, ctxOf(t2), ["w2"], false);
  assert.equal(notMade.status, "failed");
  assert.equal(notMade.readBack, undefined, "not made, so there's no read-back of a write Sophos took");
  assert.match(notMade.error, /^Sophos API error 500: InternalServerError\. A read-back found the pilot without the new devices, so the wave wasn't moved\./);
});

test("a wave saved before v0.3.20 as failed with a read-back is read as not confirmed, and can be undone", async () => {
  const dataDir = await dataDirFor("wave-legacy");
  const tenant = new Tenant();
  const { policyId, build } = seedPilot(tenant, dataDir);
  tenant.policies.get(policyId).appliesTo = { endpoints: ["w1", "w2"], endpointGroups: [] };
  const id = "88888888-0000-4000-8000-000000000001";
  mkdirSync(path.join(dataDir, "promote"), { recursive: true });
  writeFileSync(path.join(dataDir, "promote", `${T}.json`), JSON.stringify({ tenantId: T, waves: [{ id, at: new Date().toISOString(), buildId: build.id, policyId, devices: [{ id: "w2", hostname: "W2" }], before: { endpoints: ["w1"], endpointGroups: [] }, after: { endpoints: ["w1", "w2"], endpointGroups: [] }, status: "failed", readBack: `not read: ${UNAVAILABLE}`, error: "The tool couldn't read the pilot policy back, so the move isn't confirmed." }] }));
  const undone = await undoWave(dataDir, ctxOf(tenant), id);
  assert.equal(undone.status, "undone", undone.error);
  assert.deepEqual(tenant.policies.get(policyId).appliesTo.endpoints, ["w1"]);
});

test("a later wave not confirmed is still in place, so an earlier wave isn't undone before it", async () => {
  const dataDir = await dataDirFor("wave-later");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const first = await moveWave(dataDir, ctx, ["w2"], false);
  assert.equal(first.status, "moved");
  await new Promise((r) => setTimeout(r, 5));
  tenant.refuse("GET", new RegExp(`/policies/${policyId}$`), 503, afterWrite(tenant));
  const second = await moveWave(dataDir, ctx, ["w3"], false);
  assert.equal(second.status, "unconfirmed");
  tenant.rules.length = 0;
  await assert.rejects(undoWave(dataDir, ctx, first.id), /Undo the later waves first/);
});

// ---------- item 2: Undo last lists ----------

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com"), result(2, "files.example.net"), result(3, "chat.example.org", "warn")];

test("Undo last lists sends a delete it couldn't confirm again, and a retry that finds the list gone (404) is done", async () => {
  const dataDir = await dataDirFor("lists-retry");
  const tenant = new Tenant();
  const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  const [block, warn] = rec.lists;
  const reads = flag();
  tenant.refuse("GET", new RegExp(`/site-lists/(${block.id}|${warn.id})$`), 503, (() => { const w = afterWrite(tenant); return () => reads.when() && w(); })());
  const first = await undoLists(dataDir, tenant, T);
  assert.deepEqual(first.lists.map((l) => l.status), ["not confirmed", "not confirmed"]);
  assert.equal(tenant.lists.size, 0, "Sophos deleted both");
  reads.off();
  const again = await undoLists(dataDir, tenant, T);
  assert.deepEqual(again.lists.map((l) => [l.status, l.readBack]), [["deleted", "404 on read-back"], ["deleted", "404 on read-back"]]);
  assert.equal(tenant.calls.filter((c) => c.startsWith("DELETE ")).length, 4, "the retry sent each delete again");
});

test("Undo last lists sends a delete again when the list was still there after it", async () => {
  const dataDir = await dataDirFor("lists-still");
  const tenant = new Tenant();
  const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  const ignored = flag();
  tenant.ignore("DELETE", new RegExp(`/site-lists/${rec.lists[0].id}$`), ignored.when);
  const first = await undoLists(dataDir, tenant, T);
  assert.deepEqual(first.lists.map((l) => l.status), ["still there after delete", "deleted"]);
  ignored.off();
  const again = await undoLists(dataDir, tenant, T);
  assert.deepEqual(again.lists.map((l) => l.status), ["deleted", "deleted"]);
  assert.equal(tenant.lists.size, 0);
});

test("Undo last lists reads back a delete Sophos answered with a 500: deleted when it's gone, and kept apart from a refusal", async () => {
  const dataDir = await dataDirFor("lists-500");
  const tenant = new Tenant();
  const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  tenant.unclear("DELETE", new RegExp(`/site-lists/${rec.lists[0].id}$`));
  tenant.refuse("DELETE", new RegExp(`/site-lists/${rec.lists[1].id}$`), 403);
  const undone = await undoLists(dataDir, tenant, T);
  assert.deepEqual(undone.lists.map((l) => [l.status, l.error]), [["deleted", undefined], ["delete failed", "Sophos API error 403: Forbidden"]]);
  const audit = readFileSync(path.join(dataDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const found = audit.find((e) => e.action === "delete" && e.resourceId === rec.lists[0].id && e.ok);
  assert.match(found?.detail?.note ?? "", /^Sophos API error 500: InternalServerError, then a read-back found it gone \(404\)$/);
});

// ---------- item 3: the Allow ----------

test("an Allow whose list Sophos made but whose link to the profile was refused is partial, and its undo deletes the list", async () => {
  const dataDir = await dataDirFor("allow-link");
  const tenant = new Tenant();
  const { profileId, build } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  tenant.refuse("PUT", new RegExp(`/profiles/${profileId}$`), 403);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  assert.equal(entry.status, "partial");
  assert.equal(entry.error, "Sophos API error 403: Forbidden");
  assert.ok(tenant.lists.has(entry.listId), "the list is in the tenant");
  assert.ok((await getBuild(dataDir, T, build.id)).steps.some((s) => s.id === entry.listId), "and the build's, so a rollback removes it too");
  // A second Allow says what to do about it.
  const plan = await planAllow(dataDir, ctx, "video.example.net");
  assert.match(plan.problems.join(" "), /from the Allow for chat\.example\.org is in the tenant, but its link to the profile didn't go through\. Undo that Allow first/);
  tenant.rules.length = 0;
  const undone = await undoAllow(dataDir, ctx, entry.id);
  assert.equal(undone.status, "undone", undone.error);
  assert.deepEqual(undone.undo, ["List deleted, 404 on read-back."]);
  assert.ok(!tenant.lists.has(entry.listId));
});

test("an Allow whose link Sophos answered with a 500 is read back: added when the link is there, partial when it isn't", async () => {
  const dataDir = await dataDirFor("allow-unclear");
  const tenant = new Tenant();
  const { profileId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const once = flag();
  tenant.unclear("PUT", new RegExp(`/profiles/${profileId}$`), once.when);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  assert.deepEqual([entry.status, entry.readBack], ["added", "list holds the site; profile links it as allow"]);
  once.off();
  const dir2 = await dataDirFor("allow-unclear2");
  const t2 = new Tenant();
  const s2 = seedPilot(t2, dir2);
  t2.ignore("PUT", new RegExp(`/profiles/${s2.profileId}$`));
  t2.unclear("PUT", new RegExp(`/profiles/${s2.profileId}$`));
  const r2 = await addAllow(dir2, ctxOf(t2), "chat.example.org");
  assert.equal(r2.entry.status, "partial");
  assert.match(r2.entry.error, /^Sophos API error 500: InternalServerError\. The tool read the profile "Example profile" .* and found no link to the list in it/);
});

test("an Allow saved before v0.3.20 as failed after its list was made reads as partial, and can be undone", async () => {
  const dataDir = await dataDirFor("allow-legacy");
  const tenant = new Tenant();
  const { profileId, build } = seedPilot(tenant, dataDir);
  tenant.lists.set("l-old", { id: "l-old", name: "Example pilot allows", sites: [{ id: "s1", site: "chat.example.org" }] });
  mkdirSync(path.join(dataDir, "pilot"), { recursive: true });
  const id = "99999999-0000-4000-8000-000000000001";
  writeFileSync(path.join(dataDir, "pilot", `${T}.json`), JSON.stringify({ tenantId: T, allows: [{ id, at: new Date().toISOString(), host: "chat.example.org", site: "chat.example.org", buildId: build.id, profileId, listId: "l-old", listName: "Example pilot allows", createdList: true, status: "failed", readBack: "list holds the site", error: "Sophos API error 403: Forbidden" }] }));
  assert.equal((await loadPilotRecord(dataDir, T)).allows[0].status, "partial");
  const undone = await undoAllow(dataDir, ctxOf(tenant), id);
  assert.equal(undone.status, "undone", undone.error);
  assert.ok(!tenant.lists.has("l-old"));
});

test("an Allow added to the pilot's list that Sophos answered with a 500 is read back: added and undoable when the site is there", async () => {
  const dataDir = await dataDirFor("allow-site-unclear");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const first = await addAllow(dataDir, ctx, "chat.example.org");
  assert.equal(first.entry.status, "added");
  tenant.unclear("POST", new RegExp(`/site-lists/${first.entry.listId}/sites$`));
  const { entry } = await addAllow(dataDir, ctx, "video.example.net");
  assert.deepEqual([entry.status, entry.readBack], ["added", "site listed"]);
  assert.ok(entry.siteId, "the site's id came from the read-back, so the undo can remove it");
});

test("an Allow undo sent again after a list delete it couldn't confirm finishes when the list is gone", async () => {
  const dataDir = await dataDirFor("allow-undo-retry");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  const reads = flag();
  tenant.refuse("GET", new RegExp(`/site-lists/${entry.listId}(/sites)?$`), 503, (() => { const w = afterWrite(tenant); return () => reads.when() && w() && tenant.calls.some((c) => c.startsWith("DELETE ")); })());
  const first = await undoAllow(dataDir, ctx, entry.id);
  assert.deepEqual([first.status, first.undoReadBack], ["undo-failed", `not read: ${UNAVAILABLE}`]);
  assert.ok(!tenant.lists.has(entry.listId), "Sophos deleted the list");
  reads.off();
  const again = await undoAllow(dataDir, ctx, entry.id);
  assert.equal(again.status, "undone", again.error);
  assert.deepEqual(again.undo, ["List deleted, 404 on read-back."]);
});

test("an Allow undo sent again after a site removal it couldn't confirm finishes when the site is gone", async () => {
  const dataDir = await dataDirFor("allow-undo-site");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  await addAllow(dataDir, ctx, "chat.example.org");
  const { entry } = await addAllow(dataDir, ctx, "video.example.net");
  const reads = flag();
  tenant.refuse("GET", new RegExp(`/site-lists/${entry.listId}/sites$`), 503, () => reads.when() && tenant.calls.some((c) => c.startsWith("DELETE ")));
  const first = await undoAllow(dataDir, ctx, entry.id);
  assert.equal(first.status, "undo-failed");
  assert.equal(first.undoReadBack, `not read: ${UNAVAILABLE}`);
  reads.off();
  const again = await undoAllow(dataDir, ctx, entry.id);
  assert.equal(again.status, "undone", again.error);
});

// ---------- item 4: retiring tags ----------

test("a retire step Sophos accepted whose read-back found it unchanged is not confirmed, and the retire goes on", async () => {
  const dataDir = await dataDirFor("retire-goes-on");
  const { tenant, pol } = await retireTenant(dataDir);
  tenant.ignore("PATCH", new RegExp(`/policies/${pol.id}$`));
  const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
  assert.deepEqual(rec.steps.map((s) => [s.op, s.status, s.readBack]), [["policy-tags", "unconfirmed", "tags differ"], ["delete-entry", "done", "404 on read-back"], ["patch-entry", "done", "tags match"]]);
  assert.equal(rec.steps[0].error, "Read back: tags differ.");
  assert.equal(rec.status, "partial");
  // Restore puts back the unconfirmed step too.
  tenant.rules.length = 0;
  const back = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
  assert.deepEqual(back.steps.map((s) => s.status), ["restored", "restored", "restored"]);
  assert.equal(back.status, "restored");
});

test("a retire step Sophos refused still stops the retire, and one it answered with a 500 and left unchanged stops it too", async () => {
  const dataDir = await dataDirFor("retire-stops");
  const { tenant, pol } = await retireTenant(dataDir);
  tenant.refuse("PATCH", new RegExp(`/policies/${pol.id}$`), 403);
  const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
  assert.deepEqual(rec.steps.map((s) => s.status), ["failed", "planned", "planned"]);
  const dir2 = await dataDirFor("retire-stops2");
  const r2 = await retireTenant(dir2);
  r2.tenant.ignore("PATCH", new RegExp(`/policies/${r2.pol.id}$`));
  r2.tenant.unclear("PATCH", new RegExp(`/policies/${r2.pol.id}$`));
  const rec2 = await retire(dir2, ctxOf(r2.tenant), ["old"], true, TOOL);
  assert.deepEqual(rec2.steps.map((s) => s.status), ["failed", "planned", "planned"]);
  assert.equal(rec2.steps[0].readBack, undefined);
  assert.match(rec2.steps[0].error, /^Sophos API error 500: InternalServerError\. A read-back found it unchanged \(tags differ\), so it wasn't made\.$/);
});

// ---------- item 5: restore records saved before v0.3.19 ----------

test("a restore record saved before v0.3.19 whose restore write failed reads as failed, not as not confirmed", async () => {
  const dataDir = await dataDirFor("restore-legacy");
  const dir = path.join(dataDir, "retire", T);
  mkdirSync(dir, { recursive: true });
  const tag = { op: "policy-tags", policyId: "p", policyName: "Base Policy", before: [{ tag: "old", action: "allow" }], after: [] };
  const del = { op: "delete-entry", id: "s1", url: "a.example.com", tags: ["old"] };
  const rec = (n, steps) => ({ id: `77777777-0000-4000-8000-00000000000${n}`, tenantId: T, at: `2026-10-1${n}T01:00:00.000Z`, tags: ["old"], snapshotFile: "x.json", status: "restore-partial", steps, warnings: [] });
  // 1: the restore write was refused; the read-backs are the retire's. 2: v0.3.19, accepted and not confirmed. 3: before v0.3.19, accepted, read back differing.
  writeFileSync(path.join(dir, `${rec(1).id}.json`), JSON.stringify(rec(1, [{ ...tag, status: "restore-failed", readBack: "tags match", error: "Sophos API error 403: Forbidden" }, { ...del, status: "restore-failed", readBack: "404 on read-back", error: "Sophos API error 403: Forbidden" }])));
  writeFileSync(path.join(dir, `${rec(2).id}.json`), JSON.stringify(rec(2, [{ ...tag, status: "restore-failed", readBack: `not read: ${UNAVAILABLE}`, error: "The tool couldn't read it back, so the restore isn't confirmed." }])));
  writeFileSync(path.join(dir, `${rec(3).id}.json`), JSON.stringify(rec(3, [{ ...tag, status: "restore-failed", readBack: "tags differ" }])));
  const byId = Object.fromEntries((await listRecords(dataDir, T)).map((r) => [r.id.slice(-1), r.steps.map((s) => [s.status, s.readBack])]));
  assert.deepEqual(byId["1"], [["restore-failed", undefined], ["restore-failed", undefined]]);
  assert.deepEqual(byId["2"], [["restore-failed", `not read: ${UNAVAILABLE}`]]);
  assert.deepEqual(byId["3"], [["restore-failed", "tags differ"]]);
});

// ---------- item 6: the section headers in components.css ----------

test("every section header in components.css names what its rules style, not a page from the migration tool", () => {
  const css = readFileSync(path.join(root, "frontend/css/components.css"), "utf8");
  const headers = [...css.matchAll(/\/\* =+ (.+?) =+ \*\//g)].map((m) => m[1]);
  assert.ok(headers.length > 10, headers.join(", "));
  const stale = headers.filter((h) => /migration|monitor|\btabs\b|exclusions|legacy|search/i.test(h));
  assert.deepEqual(stale, []);
  // Each header holds rules, and no rule set sits under a second header for the same thing.
  assert.equal(new Set(headers).size, headers.length, "a header appears twice");
  const sections = css.split(/\/\* =+ .+? =+ \*\//).slice(1);
  sections.forEach((body, i) => assert.match(body.replace(/\/\*[\s\S]*?\*\//g, ""), /\{/, `"${headers[i]}" holds no rules`));
});
