// v0.3.28, in what the services record. Create site lists saved its record
// only after every create, and an Allow only after all its writes, so a
// server that stopped mid-run left lists in the tenant with no record: Undo
// said there was nothing to undo, and the next create or Allow was refused
// the name. Each write is now marked as sending, and saved, before it goes,
// as a build step is (v0.3.27), and read back as not confirmed: the next
// create or Allow looks for a list it was creating by name and uses it, and
// Undo and a rollback look for it too. The server stopping is a write held in
// flight that never answers, with the records read from disk as a server
// started again would read them. Each case runs against an in-memory tenant
// (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSite } from "../backend/dist/domain/sites.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { getBuild, rollback } from "../backend/dist/services/build-service.js";
import { createLists, lastListsRecord, planLists, undoLists } from "../backend/dist/services/lists-service.js";
import { addAllow, loadPilotRecord, planAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { T, Tenant, ctxOf, dataDirFor, seedPilot } from "./memory-tenant.mjs";

const LISTS = /\/site-lists$/;
const SITES = /\/site-lists\/[^/]+\/sites$/;
const PROFILE = /\/profiles\/[^/]+$/;
const ANSWER = "The tool stopped before it saved what Sophos answered";
const UNREAD = "not read: none was saved";
const PREFIX = "Example cleaned";

before(() => setReadBackDelays([0, 0]));

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com"), result(2, "chat.example.org", "warn")];

/**
 * The nth write of method that matches is made (or not, with made false) and never answered, as when the server stops
 * while it's in flight. Resolves once it's held. Other writes go through.
 */
function hold(tenant, method, pattern, { nth = 1, made = true } = {}) {
  let held;
  const holding = new Promise((resolve) => (held = resolve));
  const real = tenant.tenantRequest.bind(tenant);
  let n = 0;
  tenant.tenantRequest = async (tenantId, p, o = {}) => {
    if ((o.method ?? "GET") !== method || !pattern.test(p) || ++n !== nth) return real(tenantId, p, o);
    if (made) await real(tenantId, p, o);
    else tenant.calls.push(`${method} ${p}`);
    held();
    return new Promise(() => {});
  };
  return holding;
}

const named = (map, name) => [...map.values()].filter((x) => x.name === name);
const posts = (tenant, pattern) => tenant.calls.filter((c) => c.startsWith("POST ") && pattern.test(c.slice(5))).length;
const rawLists = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, "cleanup", `${T}.lists.json`), "utf8"));
const rawAllows = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, "pilot", `${T}.json`), "utf8")).allows;
const row = (l) => ({ status: l.status, id: !!l.id, answer: l.answer, readBack: l.readBack, sending: l.sending });

// ---------- item 1: Create site lists ----------

/** Create site lists, stopped while the nth list's create is held. */
async function stoppedLists(name, opts) {
  const dataDir = await dataDirFor(name);
  const tenant = new Tenant();
  const holding = hold(tenant, "POST", LISTS, opts);
  // Never answers: the server stopped while the create was out.
  void createLists(dataDir, tenant, T, T, RESULTS, PREFIX);
  await holding;
  return { dataDir, tenant };
}

test("Create site lists: each list is saved before its create goes, marked as sending; read back, the one in flight is not confirmed", async () => {
  const s = await stoppedLists("v0328-lists-mark");
  assert.deepEqual(rawLists(s.dataDir).lists.map((l) => [l.name, l.status, l.sending ?? false]), [[`${PREFIX} Block`, "planned", true]], "saved before the create went");
  const rec = await lastListsRecord(s.dataDir, T);
  assert.deepEqual(rec.lists.map(row), [{ status: "unconfirmed", id: false, answer: ANSWER, readBack: UNREAD, sending: undefined }]);
});

test("Create site lists: a list in flight when the server stopped, which Sophos made, is used by the next create, which says so and doesn't make it again", async () => {
  const s = await stoppedLists("v0328-lists-made");
  const [made] = named(s.tenant.lists, `${PREFIX} Block`);
  assert.ok(made, "Sophos made it");
  const plan = await planLists(s.tenant, T, RESULTS, PREFIX, { dataDir: s.dataDir, scope: T });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.reuse, [{ name: `${PREFIX} Block`, id: made.id }]);
  assert.deepEqual(plan.notes, [`"${PREFIX} Block" is in the tenant. The last create asked for it and Sophos didn't confirm it was made, so this one uses it rather than making another.`]);
  const sent = posts(s.tenant, LISTS);
  const next = await createLists(s.dataDir, s.tenant, T, T, RESULTS, PREFIX);
  assert.equal(posts(s.tenant, LISTS), sent + 1, "only the other list is sent");
  assert.equal(named(s.tenant.lists, `${PREFIX} Block`).length, 1, "not made twice");
  assert.deepEqual(next.lists.map((l) => [l.status, l.id, l.note]), [["created", made.id, "Found by name: the last create asked for it and Sophos didn't confirm it, so it's used, not made again."], ["created", named(s.tenant.lists, `${PREFIX} Warn`)[0].id, undefined]]);
});

test("Create site lists: a list in flight when the server stopped, which Sophos didn't make, is created by the next create", async () => {
  const s = await stoppedLists("v0328-lists-unmade", { made: false });
  assert.deepEqual((await lastListsRecord(s.dataDir, T)).lists.map(row), [{ status: "unconfirmed", id: false, answer: ANSWER, readBack: UNREAD, sending: undefined }]);
  assert.equal(s.tenant.lists.size, 0);
  const plan = await planLists(s.tenant, T, RESULTS, PREFIX, { dataDir: s.dataDir, scope: T });
  assert.deepEqual([plan.problems, plan.reuse], [[], []]);
  const next = await createLists(s.dataDir, s.tenant, T, T, RESULTS, PREFIX);
  assert.deepEqual(next.lists.map((l) => [l.status, l.note]), [["created", undefined], ["created", undefined]]);
  assert.equal(s.tenant.lists.size, 2);
});

test("Create site lists: stopped while the second list was in flight, the first is on record, and Undo deletes it and finds the second by name", async () => {
  const s = await stoppedLists("v0328-lists-second", { nth: 2 });
  assert.equal(s.tenant.lists.size, 2, "Sophos made both");
  const rec = await lastListsRecord(s.dataDir, T);
  assert.deepEqual(rec.lists.map((l) => [l.name, l.status, !!l.id]), [[`${PREFIX} Block`, "created", true], [`${PREFIX} Warn`, "unconfirmed", false]]);
  assert.deepEqual(row(rec.lists[1]), { status: "unconfirmed", id: false, answer: ANSWER, readBack: UNREAD, sending: undefined });
  // The next create uses the one in flight; the one on record is the last create's, which Undo deletes.
  const plan = await planLists(s.tenant, T, RESULTS, PREFIX, { dataDir: s.dataDir, scope: T });
  assert.deepEqual(plan.reuse.map((r) => r.name), [`${PREFIX} Warn`]);
  assert.deepEqual(plan.problems, [`A site list named "${PREFIX} Block" already exists.`]);
  const undone = await undoLists(s.dataDir, s.tenant, T);
  assert.deepEqual(undone.lists.map((l) => [l.name, l.status, l.lookedUp ?? null]), [[`${PREFIX} Block`, "deleted", null], [`${PREFIX} Warn`, "deleted", "found"]]);
  assert.equal(s.tenant.lists.size, 0);
});

test("Create site lists: once a list's outcome is recorded, the record keeps no sending mark: created, refused, or not confirmed after a 5xx", async () => {
  const runs = {};
  for (const how of ["created", "refused", "unclear"]) {
    const dataDir = await dataDirFor(`v0328-lists-clear-${how}`);
    const tenant = new Tenant();
    if (how === "refused") tenant.refuse("POST", LISTS, 403);
    if (how === "unclear") {
      tenant.unclear("POST", LISTS);
      tenant.refuse("GET", LISTS, 503, () => tenant.writes > 0);
    }
    const rec = await createLists(dataDir, tenant, T, T, RESULTS, PREFIX);
    runs[how] = rec.lists.map((l) => l.status);
    assert.deepEqual(rawLists(dataDir).lists.filter((l) => "sending" in l), [], `${how}: no sending mark left`);
  }
  assert.deepEqual(runs, { created: ["created", "created"], refused: ["failed"], unclear: ["unconfirmed"] });
});

// ---------- item 2: an Allow's new list ----------

/** A built pilot, and an Allow of chat.example.org stopped while the write that matches is held. */
async function stoppedAllow(name, method, pattern, opts) {
  const dataDir = await dataDirFor(name);
  const tenant = new Tenant();
  const seeded = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const holding = hold(tenant, method, pattern, opts);
  // Never answers: the server stopped while the write was out.
  void addAllow(dataDir, ctx, "chat.example.org");
  await holding;
  return { dataDir, tenant, ctx, ...seeded };
}

const allowRow = (a) => ({ status: a.status, listName: a.listName, listId: !!a.listId, answer: a.answer, readBack: a.readBack, sending: a.sending });

test("Allow: the entry is saved with its list's name before the new list's create goes; read back, it's not confirmed", async () => {
  const s = await stoppedAllow("v0328-allow-mark", "POST", LISTS);
  assert.deepEqual(rawAllows(s.dataDir).map((a) => [a.site, a.listName, a.sending ?? false, !!a.listId]), [["chat.example.org", "Example pilot allows", true, false]], "saved before the create went");
  const rec = await loadPilotRecord(s.dataDir, T);
  assert.deepEqual(rec.allows.map(allowRow), [{ status: "unconfirmed", listName: "Example pilot allows", listId: false, answer: ANSWER, readBack: UNREAD, sending: undefined }]);
});

test("Allow: a new list in flight when the server stopped, which Sophos made, is used by the next Allow, which says so and doesn't make it again", async () => {
  const s = await stoppedAllow("v0328-allow-made", "POST", LISTS);
  const [made] = named(s.tenant.lists, "Example pilot allows");
  assert.ok(made, "Sophos made it");
  const plan = await planAllow(s.dataDir, s.ctx, "chat.example.org");
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.steps.map((x) => x.op), ["use-list", "link-list"]);
  assert.ok(plan.notes.includes(`The site list "Example pilot allows" from the Allow for chat.example.org is in the tenant. Sophos didn't confirm it was made, so this Allow uses it rather than making another.`), JSON.stringify(plan.notes));
  const sent = posts(s.tenant, LISTS);
  const { entry } = await addAllow(s.dataDir, s.ctx, "chat.example.org");
  assert.equal(posts(s.tenant, LISTS), sent, "no create sent for it");
  assert.equal(named(s.tenant.lists, "Example pilot allows").length, 1, "not made twice");
  assert.deepEqual([entry.status, entry.listId, entry.readBack, entry.note], ["added", made.id, "list holds the site; profile links it as allow", 'The site list "Example pilot allows" was found by name and used, not made again.']);
  assert.equal((await loadPilotRecord(s.dataDir, T)).allows.length, 1, "the same entry carried on");
});

test("Allow: a new list in flight when the server stopped, which Sophos didn't make, is created by the next Allow on the same entry", async () => {
  const s = await stoppedAllow("v0328-allow-unmade", "POST", LISTS, { made: false });
  const [first] = (await loadPilotRecord(s.dataDir, T)).allows;
  assert.deepEqual(allowRow(first), { status: "unconfirmed", listName: "Example pilot allows", listId: false, answer: ANSWER, readBack: UNREAD, sending: undefined });
  const plan = await planAllow(s.dataDir, s.ctx, "chat.example.org");
  assert.deepEqual([plan.problems, plan.steps.map((x) => x.op)], [[], ["create-list", "link-list"]]);
  const { entry } = await addAllow(s.dataDir, s.ctx, "chat.example.org");
  assert.deepEqual([entry.id, entry.status], [first.id, "added"]);
  assert.equal(named(s.tenant.lists, "Example pilot allows").length, 1);
});

test("Allow: Undo, and a rollback of the build, look for a new list in flight when the server stopped by name and delete it", async () => {
  const u = await stoppedAllow("v0328-allow-undo", "POST", LISTS);
  const [entry] = (await loadPilotRecord(u.dataDir, T)).allows;
  const undone = await undoAllow(u.dataDir, u.ctx, entry.id);
  assert.deepEqual([undone.status, undone.undo], ["undone", ["The list was found by name.", "List deleted, 404 on read-back."]]);
  assert.equal(named(u.tenant.lists, "Example pilot allows").length, 0);

  const r = await stoppedAllow("v0328-allow-rollback", "POST", LISTS);
  const done = await rollback(r.dataDir, r.ctx, r.build.id, { dryRun: false });
  assert.equal(done.status, "rolled-back", JSON.stringify(done.rollback.steps));
  assert.deepEqual(done.rollback.steps.filter((o) => o.kind === "site-list").map((o) => [o.name, o.lookedUp ?? null]), [["Example pilot allows", "found"], ["Example Block", null]]);
  assert.equal(r.tenant.lists.size, 0);
  assert.equal((await loadPilotRecord(r.dataDir, T)).allows[0].status, "undone");
});

test("Allow: a link to the profile in flight when the server stopped leaves the list on record, its link not confirmed, and Undo removes it", async () => {
  const s = await stoppedAllow("v0328-allow-link", "PUT", PROFILE);
  const [entry] = (await loadPilotRecord(s.dataDir, T)).allows;
  const listId = named(s.tenant.lists, "Example pilot allows")[0].id;
  assert.deepEqual([entry.status, entry.listId, entry.createdList, entry.answer, entry.readBack], ["partial", listId, true, ANSWER, "list holds the site; profile not read: none was saved"]);
  assert.ok((await getBuild(s.dataDir, T, s.build.id)).steps.some((x) => x.id === listId), "the build has the list, so a rollback deletes it too");
  const plan = await planAllow(s.dataDir, s.ctx, "video.example.net");
  assert.deepEqual(plan.problems, [`The site list "Example pilot allows" from the Allow for chat.example.org is in the tenant, but its link to the profile isn't confirmed. Undo that Allow first, then allow this site again.`]);
  const undone = await undoAllow(s.dataDir, s.ctx, entry.id);
  assert.equal(undone.status, "undone", JSON.stringify(undone));
  assert.equal(s.tenant.lists.has(listId), false);
  assert.ok(!(s.tenant.profiles.get(s.profileId).siteListActions ?? []).some((a) => a.id === listId), "unlinked");
});

test("Allow: a site's add to the pilot allows list in flight when the server stopped is on record, not confirmed, and Undo removes the site", async () => {
  const dataDir = await dataDirFor("v0328-allow-site");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const first = (await addAllow(dataDir, ctx, "chat.example.org")).entry;
  const holding = hold(tenant, "POST", SITES);
  void addAllow(dataDir, ctx, "video.example.net");
  await holding;
  const list = tenant.lists.get(first.listId);
  assert.deepEqual(list.sites.map((x) => x.site), ["chat.example.org", "video.example.net"], "Sophos added it");
  const rec = await loadPilotRecord(dataDir, T);
  assert.deepEqual(rec.allows.map((a) => [a.site, a.status, a.listId === first.listId, a.answer ?? null, a.readBack]), [
    ["video.example.net", "added", true, ANSWER, UNREAD],
    ["chat.example.org", "added", true, null, "list holds the site; profile links it as allow"],
  ]);
  const undone = await undoAllow(dataDir, ctx, rec.allows[0].id);
  assert.deepEqual([undone.status, undone.undo], ["undone", ["Site removed, confirmed on read-back."]]);
  assert.deepEqual(list.sites.map((x) => x.site), ["chat.example.org"]);
});

test("Allow: once its outcome is recorded, the record keeps no sending mark: added, refused, or not confirmed after a 5xx", async () => {
  const runs = {};
  for (const how of ["added", "refused", "unclear"]) {
    const dataDir = await dataDirFor(`v0328-allow-clear-${how}`);
    const tenant = new Tenant();
    seedPilot(tenant, dataDir);
    if (how === "refused") tenant.refuse("POST", LISTS, 403);
    if (how === "unclear") {
      tenant.unclear("POST", LISTS);
      tenant.refuse("GET", LISTS, 503, () => tenant.writes > 0);
    }
    await addAllow(dataDir, ctxOf(tenant), "chat.example.org").catch(() => null);
    runs[how] = rawAllows(dataDir).map((a) => a.status);
    assert.deepEqual(rawAllows(dataDir).filter((a) => "sending" in a), [], `${how}: no sending mark left`);
  }
  assert.deepEqual(runs, { added: ["added"], refused: ["failed"], unclear: ["unconfirmed"] });
});
