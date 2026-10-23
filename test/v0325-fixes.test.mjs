// v0.3.25, in what the services record. A rollback of a build looks for each
// step Sophos didn't confirm was made (no id) by name, the way the next build
// does: found, it's deleted by that id; not there, there was nothing to
// remove; not read, the rollback isn't confirmed and the step stays
// unconfirmed. So do Undo for an Allow whose new list wasn't confirmed, a
// rollback of that Allow's build, and Undo last lists. And records v0.3.23
// saved in that state (failed, no id, the unread lookup's error), in
// fixtures/v0323-records.json, are read as not confirmed, so the next run and
// the rollback look them up by name too; anything that failed another way
// stays failed. Each case runs against an in-memory tenant (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, dryRun, execute, getBuild, listBuilds, rollback, saveRecord } from "../backend/dist/services/build-service.js";
import { activePilot, addAllow, loadPilotRecord, planAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { createLists, lastListsRecord, planLists, undoLists } from "../backend/dist/services/lists-service.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { wcPolicy } from "./fixtures.mjs";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, classicTenant, ctxOf, dataDirFor, seedPilot } from "./memory-tenant.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const V0323 = JSON.parse(readFileSync(path.join(here, "fixtures", "v0323-records.json"), "utf8"));
const LISTS = /\/site-lists$/;
const UNREAD_LISTS = `The tool couldn't read the tenant's site lists to look for it by name (${UNAVAILABLE}), so it may be in the tenant.`;

before(() => setReadBackDelays([0, 0]));

const auditOf = (dataDir) => readFileSync(path.join(dataDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Creates matching write go through, then answer 500, and the collection read after them fails (503). */
function unreadCreate(tenant, write, read) {
  let on = true;
  const w = afterWrite(tenant);
  tenant.unclear("POST", write, () => on);
  tenant.refuse("GET", read, 503, () => on && w());
  return () => (on = false);
}
/** The same, but the create isn't made. */
function unreadUnmade(tenant, write, read) {
  let on = true;
  const w = afterWrite(tenant);
  tenant.ignore("POST", write, () => on);
  tenant.unclear("POST", write, () => on);
  tenant.refuse("GET", read, 503, () => on && w());
  return () => (on = false);
}
/** Reads of a collection fail (503) until the returned function is called. */
function unreadable(tenant, read) {
  let on = true;
  tenant.refuse("GET", read, 503, () => on);
  return () => (on = false);
}

/** A classic tenant and the pilot options for a profile with a site list (or, with base, the Base Policy's, which has none). */
async function buildSetup(name, { base = false } = {}) {
  const dataDir = await dataDirFor(name);
  const tenant = classicTenant();
  if (base) tenant.policies.set("base", wcPolicy({ id: "base", name: "Base Policy", priority: 0 }));
  const ctx = ctxOf(tenant);
  const { design } = await designFor(dataDir, ctx);
  const pilot = { profileKey: design.profiles.find((p) => (base ? !p.siteLists.length : p.siteLists.length)).key, enabled: false, targets: { endpoints: ["w1"] } };
  return { dataDir, tenant, ctx, pilot };
}
const named = (map, name) => [...map.values()].filter((x) => x.name === name);

// ---------- item 1: a build rollback ----------

test("a rollback looks for an unconfirmed build step by name and deletes it by the id found", async () => {
  const { dataDir, tenant, ctx, pilot } = await buildSetup("v0325-rollback-found");
  const off = unreadCreate(tenant, LISTS, LISTS);
  const built = await execute(dataDir, ctx, pilot, TOOL);
  off();
  const [step] = built.steps;
  assert.deepEqual([built.status, step.status, step.id], ["partial", "unconfirmed", undefined]);
  const [made] = named(tenant.lists, step.name);
  assert.ok(made, "Sophos made it");
  // The dry run of the rollback says it will look for it.
  const plan = await rollback(dataDir, ctx, built.id, { dryRun: true });
  assert.deepEqual(plan.steps.filter((s) => s.status === "unconfirmed" && !s.id).map((s) => s.name), [step.name]);
  const r = await rollback(dataDir, ctx, built.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  assert.deepEqual(r.rollback.steps.filter((o) => o.kind !== "website-management"), [{ kind: "site-list", name: step.name, id: made.id, status: "deleted, 404 on read-back", lookedUp: "found" }]);
  assert.equal(tenant.lists.has(made.id), false, "deleted");
  const saved = await getBuild(dataDir, T, built.id);
  assert.deepEqual([saved.steps[0].status, saved.steps[0].id, saved.steps[0].note], ["deleted", made.id, "Found by name by the rollback: Sophos didn't confirm it was made."]);
  assert.ok(auditOf(dataDir).some((e) => e.action === "delete" && e.resourceId === made.id && e.ok && e.detail.foundByName === true && e.detail.rollbackOf === built.id));
});

test("a rollback that finds nothing by that name says there was nothing to remove", async () => {
  const { dataDir, tenant, ctx, pilot } = await buildSetup("v0325-rollback-not-found");
  const off = unreadUnmade(tenant, LISTS, LISTS);
  const built = await execute(dataDir, ctx, pilot, TOOL);
  off();
  assert.equal(built.steps[0].status, "unconfirmed");
  const deletes = tenant.calls.filter((c) => c.startsWith("DELETE ")).length;
  const r = await rollback(dataDir, ctx, built.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  assert.deepEqual(r.rollback.steps.filter((o) => o.kind !== "website-management"), [{ kind: "site-list", name: built.steps[0].name, status: "not there", lookedUp: "not found" }]);
  assert.equal(tenant.calls.filter((c) => c.startsWith("DELETE ")).length, deletes, "no delete sent");
  assert.deepEqual([(await getBuild(dataDir, T, built.id)).steps[0].status], ["not-found"]);
});

test("a rollback that can't read the tenant to look isn't Rolled back; the step stays unconfirmed, and rolling back again finishes it", async () => {
  const { dataDir, tenant, ctx, pilot } = await buildSetup("v0325-rollback-unread");
  const off = unreadCreate(tenant, LISTS, LISTS);
  const built = await execute(dataDir, ctx, pilot, TOOL);
  off();
  const [made] = named(tenant.lists, built.steps[0].name);
  const on = unreadable(tenant, LISTS);
  const first = await rollback(dataDir, ctx, built.id, { dryRun: false });
  on();
  assert.equal(first.status, "rollback-partial", JSON.stringify(first.rollback.steps));
  assert.deepEqual(first.rollback.steps.filter((o) => o.kind !== "website-management"), [{ kind: "site-list", name: built.steps[0].name, status: "not confirmed", lookedUp: "not read", error: UNREAD_LISTS }]);
  assert.deepEqual([first.steps[0].status, first.steps[0].id], ["unconfirmed", undefined]);
  assert.ok(tenant.lists.has(made.id), "nothing deleted");
  const again = await rollback(dataDir, ctx, built.id, { dryRun: false });
  assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback.steps));
  assert.equal(tenant.lists.has(made.id), false);
});

test("a rollback deletes an unconfirmed profile, and an unconfirmed policy before the profile and list it uses", async () => {
  {
    const { dataDir, tenant, ctx, pilot } = await buildSetup("v0325-rollback-profile", { base: true });
    const off = unreadCreate(tenant, /\/profiles$/, /\/profiles$/);
    const built = await execute(dataDir, ctx, pilot, TOOL);
    off();
    assert.deepEqual(built.steps.map((s) => s.status), ["unconfirmed", "planned"]);
    const r = await rollback(dataDir, ctx, built.id, { dryRun: false });
    assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
    assert.equal(tenant.profiles.size, 0);
  }
  {
    const { dataDir, tenant, ctx, pilot } = await buildSetup("v0325-rollback-policy");
    const off = unreadCreate(tenant, /\/policies$/, /\/policies$/);
    const built = await execute(dataDir, ctx, pilot, TOOL);
    off();
    assert.deepEqual(built.steps.map((s) => s.status), ["created", "created", "unconfirmed"]);
    const [policy] = named(tenant.policies, built.pilot.name);
    assert.ok(policy, "Sophos made the pilot policy");
    const r = await rollback(dataDir, ctx, built.id, { dryRun: false });
    assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
    assert.deepEqual(r.rollback.steps.filter((o) => o.kind !== "website-management").map((o) => [o.kind, o.lookedUp ?? null]), [["policy", "found"], ["profile", null], ["site-list", null]]);
    assert.deepEqual([tenant.policies.has(policy.id), tenant.profiles.size, named(tenant.lists, built.steps[0].name).length], [false, 0, 0]);
  }
});

test("a rollback leaves alone an object by that name that a build has the id of", async () => {
  const { dataDir, tenant, ctx, pilot } = await buildSetup("v0325-rollback-recorded");
  const off = unreadCreate(tenant, LISTS, LISTS);
  const first = await execute(dataDir, ctx, pilot, TOOL);
  off();
  const [made] = named(tenant.lists, first.steps[0].name);
  // A later build used it, found by name, so it has the id now: that build's rollback deletes it, not this one's.
  const second = await execute(dataDir, ctx, pilot, TOOL);
  assert.equal(second.steps[0].id, made.id);
  const r = await rollback(dataDir, ctx, first.id, { dryRun: false });
  assert.equal(r.status, "rolled-back");
  assert.deepEqual(r.rollback.steps.filter((o) => o.kind !== "website-management").map((o) => o.status), ["not there"]);
  assert.ok(tenant.lists.has(made.id), "left for the build that has its id");
});

// ---------- item 1: an Allow's new list, by Undo and by a rollback of its build ----------

test("Undo looks for the list of an Allow that wasn't confirmed by name: found, it's deleted; not there, nothing to remove; not read, it stays not confirmed", async () => {
  const setup = async (name, fault) => {
    const dataDir = await dataDirFor(name);
    const tenant = new Tenant();
    const { build } = seedPilot(tenant, dataDir);
    const off = fault(tenant, LISTS, LISTS);
    const { entry } = await addAllow(dataDir, ctxOf(tenant), "chat.example.org");
    off();
    assert.deepEqual([entry.status, entry.listId], ["unconfirmed", undefined]);
    return { dataDir, tenant, ctx: ctxOf(tenant), entry, build };
  };
  {
    const { dataDir, tenant, ctx, entry, build } = await setup("v0325-undo-found", unreadCreate);
    const [made] = named(tenant.lists, "Example pilot allows");
    const undone = await undoAllow(dataDir, ctx, entry.id);
    assert.deepEqual([undone.status, undone.listId, undone.undo, undone.error], ["undone", made.id, ["The list was found by name.", "List deleted, 404 on read-back."], undefined]);
    assert.equal(tenant.lists.has(made.id), false);
    assert.ok((await getBuild(dataDir, T, build.id)).steps.some((s) => s.id === made.id && s.status === "deleted"), "the build has it, deleted");
  }
  {
    const { dataDir, tenant, ctx, entry } = await setup("v0325-undo-not-found", unreadUnmade);
    const undone = await undoAllow(dataDir, ctx, entry.id);
    assert.deepEqual([undone.status, undone.listId, undone.undo], ["undone", undefined, ["No list by that name in the tenant, so there was nothing to remove."]]);
    assert.equal(tenant.calls.filter((c) => c.startsWith("DELETE ")).length, 0);
  }
  {
    const { dataDir, tenant, ctx, entry } = await setup("v0325-undo-unread", unreadCreate);
    const [made] = named(tenant.lists, "Example pilot allows");
    const on = unreadable(tenant, LISTS);
    const first = await undoAllow(dataDir, ctx, entry.id);
    on();
    assert.deepEqual([first.status, first.listId, first.undoLookUp, first.undo], ["unconfirmed", undefined, `not read: ${UNAVAILABLE}`, [UNREAD_LISTS]]);
    assert.ok(tenant.lists.has(made.id));
    const again = await undoAllow(dataDir, ctx, entry.id);
    assert.deepEqual([again.status, again.undoLookUp], ["undone", undefined]);
    assert.equal(tenant.lists.has(made.id), false);
  }
});

test("a rollback of the build looks for the list of its Allow that wasn't confirmed, by name, and settles the entry", async () => {
  const setup = async (name, fault) => {
    const dataDir = await dataDirFor(name);
    const tenant = new Tenant();
    const { build } = seedPilot(tenant, dataDir);
    const off = fault(tenant, LISTS, LISTS);
    const { entry } = await addAllow(dataDir, ctxOf(tenant), "chat.example.org");
    off();
    return { dataDir, tenant, ctx: ctxOf(tenant), entry, build };
  };
  {
    const { dataDir, tenant, ctx, entry, build } = await setup("v0325-allow-rollback-found", unreadCreate);
    const [made] = named(tenant.lists, "Example pilot allows");
    const plan = await rollback(dataDir, ctx, build.id, { dryRun: true });
    assert.deepEqual(plan.steps.filter((s) => s.status === "unconfirmed").map((s) => s.name), ["Example pilot allows"]);
    const r = await rollback(dataDir, ctx, build.id, { dryRun: false });
    assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
    assert.ok(r.rollback.steps.some((o) => o.name === "Example pilot allows" && o.lookedUp === "found" && o.status === "deleted, 404 on read-back"));
    assert.equal(tenant.lists.size, 0, "every list gone, the Allow's too");
    const held = (await loadPilotRecord(dataDir, T)).allows.find((a) => a.id === entry.id);
    assert.deepEqual([held.status, held.listId, held.undo], ["undone", made.id, ["The list was found by name.", "List deleted with the build, 404 on read-back."]]);
  }
  {
    const { dataDir, ctx, entry, build } = await setup("v0325-allow-rollback-not-found", unreadUnmade);
    const r = await rollback(dataDir, ctx, build.id, { dryRun: false });
    assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
    assert.ok(r.rollback.steps.some((o) => o.name === "Example pilot allows" && o.status === "not there"));
    const held = (await loadPilotRecord(dataDir, T)).allows.find((a) => a.id === entry.id);
    assert.deepEqual([held.status, held.undo], ["undone", ["No list by that name in the tenant, so there was nothing to remove."]]);
  }
  {
    // Not read: the rollback isn't confirmed, the entry stays as it was, and Undo from the Pilot page can finish it.
    const { dataDir, tenant, ctx, entry, build } = await setup("v0325-allow-rollback-unread", unreadCreate);
    const [made] = named(tenant.lists, "Example pilot allows");
    // The pilot policy's delete isn't confirmed either, so the Pilot page still shows the pilot and its note.
    tenant.refuse("DELETE", /\/policies\//, 403);
    const on = unreadable(tenant, LISTS);
    const r = await rollback(dataDir, ctx, build.id, { dryRun: false });
    on();
    tenant.rules.length = 0;
    assert.equal(r.status, "rollback-partial");
    assert.ok(r.rollback.steps.some((o) => o.name === "Example pilot allows" && o.lookedUp === "not read" && o.status === "not confirmed"));
    assert.deepEqual((await loadPilotRecord(dataDir, T)).allows.find((a) => a.id === entry.id).status, "unconfirmed");
    const pilot = await activePilot(dataDir, T);
    assert.ok(pilot.rollbackUnfinished.left.some((l) => l.name === "Example pilot allows"), "may still be in the tenant");
    const undone = await undoAllow(dataDir, ctx, entry.id);
    assert.equal(undone.status, "undone", undone.error);
    assert.equal(tenant.lists.has(made.id), false);
    const saved = await getBuild(dataDir, T, build.id);
    assert.deepEqual(saved.steps.filter((s) => s.name === "Example pilot allows").map((s) => [s.status, s.id]), [["deleted", made.id]], "the build's step for it took the id");
    const again = await rollback(dataDir, ctx, build.id, { dryRun: false });
    assert.equal(again.status, "rolled-back", JSON.stringify(again.rollback.steps));
  }
});

// ---------- item 1: Undo last lists ----------

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com"), result(2, "chat.example.org", "warn")];

test("Undo last lists looks for a list Sophos didn't confirm by name: found, deleted; not there, nothing to remove; not read, Undo again", async () => {
  // The first list goes through; the second is made, then answered 500, with the site lists unread after.
  const second = (tenant) => {
    let on = true;
    const posts = () => tenant.calls.filter((c) => c === "POST /web-filters/v1/site-lists").length;
    tenant.unclear("POST", LISTS, () => on && posts() >= 2);
    tenant.refuse("GET", LISTS, 503, () => on && posts() >= 2);
    return () => (on = false);
  };
  {
    const dataDir = await dataDirFor("v0325-lists-found");
    const tenant = new Tenant();
    const off = second(tenant);
    const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
    off();
    assert.deepEqual(rec.lists.map((l) => l.status), ["created", "unconfirmed"]);
    const [made] = named(tenant.lists, "Example cleaned Warn");
    const undone = await undoLists(dataDir, tenant, T);
    assert.deepEqual(undone.lists.map((l) => [l.status, l.lookedUp ?? null]), [["deleted", null], ["deleted", "found"]]);
    assert.equal(undone.lists[1].id, made.id);
    assert.equal(tenant.lists.size, 0);
  }
  {
    const dataDir = await dataDirFor("v0325-lists-not-found");
    const tenant = new Tenant();
    const off = unreadUnmade(tenant, LISTS, LISTS);
    await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
    off();
    const undone = await undoLists(dataDir, tenant, T);
    assert.deepEqual(undone.lists.map((l) => [l.status, l.lookedUp]), [["not there", "not found"]]);
    assert.equal(tenant.calls.filter((c) => c.startsWith("DELETE ")).length, 0);
  }
  {
    const dataDir = await dataDirFor("v0325-lists-unread");
    const tenant = new Tenant();
    const off = unreadCreate(tenant, LISTS, LISTS);
    await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
    off();
    const [made] = named(tenant.lists, "Example cleaned Block");
    const on = unreadable(tenant, LISTS);
    const first = await undoLists(dataDir, tenant, T);
    on();
    assert.deepEqual(first.lists.map((l) => [l.status, l.id, l.lookedUp]), [["unconfirmed", undefined, `not read: ${UNAVAILABLE}`]]);
    const again = await undoLists(dataDir, tenant, T);
    assert.deepEqual(again.lists.map((l) => [l.status, l.lookedUp]), [["deleted", "found"]]);
    assert.equal(tenant.lists.has(made.id), false);
  }
});

// ---------- item 2: records v0.3.23 saved ----------

/** Puts a build record from the fixture on file, as v0.3.23 saved it, without its snapshot (not in the fixture). */
function onFile(dataDir, { snapshotFile, ...rec }) {
  void snapshotFile;
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  const file = path.join(dataDir, "builds", T, `${rec.id}.json`);
  writeFileSync(file, JSON.stringify(rec, null, 2));
  return { file, text: JSON.stringify(rec, null, 2) };
}

test("the v0.3.23 fixture is that version's shape: failed, no id, and the unread lookup's error", () => {
  assert.equal(V0323.version, "0.3.23");
  const s = V0323.build["unread-site-list"].steps[0];
  assert.deepEqual([s.status, s.id, s.answer, s.readBack, s.error], ["failed", undefined, undefined, undefined, `${UNCLEAR}. A read-back could not read the tenant's site lists (${UNAVAILABLE}). The change may still have gone through: check the tenant before trying again.`]);
  assert.equal(V0323.build["unread-site-list"].status, "failed");
  assert.deepEqual(V0323.allow.unread.pilot.allows.map((a) => [a.status, a.listName, a.listId, a.createdList]), [["failed", "", undefined, false]]);
  assert.deepEqual(V0323.lists.unread.lists.map((l) => [l.status, l.id]), [["failed", undefined]]);
});

test("a v0.3.23 build step in that state is read as not confirmed: the next build uses what it finds by name, and a rollback deletes it", async () => {
  const { dataDir, tenant, ctx, pilot } = await buildSetup("v0325-v0323-build");
  const rec = V0323.build["unread-site-list"];
  const { file, text } = onFile(dataDir, rec);
  // Sophos made it at the time.
  const id = randomUUID();
  tenant.lists.set(id, { id, name: rec.steps[0].name, sites: [{ id: randomUUID(), site: "blocked.example.com" }] });
  const read = await getBuild(dataDir, T, rec.id);
  assert.deepEqual([read.status, read.steps[0].status, read.steps[0].answer, read.steps[0].readBack, read.steps[0].readBackNote, read.steps[0].error], ["partial", "unconfirmed", UNCLEAR, "not-read", UNAVAILABLE, undefined]);
  assert.equal(readFileSync(file, "utf8"), text, "the file isn't changed");
  // The next build's dry run finds it by name.
  const plan = await dryRun(dataDir, ctx, pilot);
  assert.deepEqual(plan.steps[0].found, { id, build: rec.id });
  assert.ok(plan.checks.every((c) => c.ok), JSON.stringify(plan.checks));
  // The rollback of the v0.3.23 build finds it by name and deletes it.
  const r = await rollback(dataDir, ctx, rec.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  assert.deepEqual(r.rollback.steps.filter((o) => o.kind !== "website-management").map((o) => [o.lookedUp, o.status]), [["found", "deleted, 404 on read-back"]]);
  assert.equal(tenant.lists.has(id), false);
});

test("a v0.3.23 build stopped at its policy reads as partial, and a rollback deletes the policy found, then the profile and list", async () => {
  const { dataDir, tenant, ctx } = await buildSetup("v0325-v0323-policy");
  const rec = V0323.build["unread-policy"];
  onFile(dataDir, rec);
  const [list, profile, policy] = rec.steps;
  tenant.lists.set(list.id, { id: list.id, name: list.name, sites: [{ id: randomUUID(), site: "blocked.example.com" }] });
  tenant.profiles.set(profile.id, { id: profile.id, name: profile.name, filterBySiteList: true, siteListActions: [{ id: list.id, action: "block", priority: 1 }] });
  const pid = randomUUID();
  tenant.policies.set(pid, wcPolicy({ id: pid, name: policy.name, settings: { "endpoint.web-control.web-profile-id": { value: profile.id } } }));
  const read = await getBuild(dataDir, T, rec.id);
  assert.deepEqual([read.status, read.steps.map((s) => s.status)], ["partial", ["created", "created", "unconfirmed"]]);
  const r = await rollback(dataDir, ctx, rec.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  assert.deepEqual([tenant.policies.has(pid), tenant.profiles.has(profile.id), tenant.lists.has(list.id)], [false, false, false]);
});

test("v0.3.23 build steps that failed another way stay failed", async () => {
  const dataDir = await dataDirFor("v0325-v0323-failed");
  for (const name of ["refused-site-list", "unmade-site-list"]) {
    const rec = V0323.build[name];
    onFile(dataDir, rec);
    const read = await getBuild(dataDir, T, rec.id);
    assert.deepEqual([read.status, read.steps[0].status, read.steps[0].error], ["failed", "failed", rec.steps[0].error], name);
  }
  assert.ok((await listBuilds(dataDir, T)).every((b) => b.status === "failed"));
});

test("a build rolled back before v0.3.25 with an unconfirmed step left isn't read as rolled back, so it can be rolled back again", async () => {
  const { dataDir, tenant, ctx, pilot } = await buildSetup("v0325-old-rollback");
  const off = unreadCreate(tenant, LISTS, LISTS);
  const built = await execute(dataDir, ctx, pilot, TOOL);
  off();
  // As v0.3.24 saved its rollback: nothing deleted, every step but the unconfirmed one gone, Rolled back.
  const rec = await getBuild(dataDir, T, built.id);
  await saveRecord(dataDir, { ...rec, status: "rolled-back", rollback: { at: new Date().toISOString(), steps: [] } });
  assert.equal((await getBuild(dataDir, T, built.id)).status, "rollback-partial");
  const r = await rollback(dataDir, ctx, built.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  assert.equal(named(tenant.lists, built.steps[0].name).length, 0);
});

test("a v0.3.23 Allow in that state is read as not confirmed, with the list name it asked for: Allow again uses the list, and Undo deletes it", async () => {
  const fixture = V0323.allow.unread;
  const setup = async (name) => {
    const dataDir = await dataDirFor(name);
    const tenant = new Tenant();
    // The v0.3.23 pilot, in the tenant and on file.
    const [list, profile, policy] = fixture.build.steps;
    tenant.lists.set(list.id, { id: list.id, name: list.name, sites: [{ id: randomUUID(), site: "blocked.example.com" }] });
    tenant.profiles.set(profile.id, { id: profile.id, name: profile.name, filterByCategory: false, filterBySiteList: true, siteListActions: [{ id: list.id, action: "block", priority: 1 }] });
    tenant.policies.set(policy.id, wcPolicy({ id: policy.id, name: policy.name, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: { "endpoint.web-control.web-profile-id": { value: profile.id } } }));
    onFile(dataDir, fixture.build);
    mkdirSync(path.join(dataDir, "pilot"), { recursive: true });
    const file = path.join(dataDir, "pilot", `${T}.json`);
    writeFileSync(file, JSON.stringify(fixture.pilot));
    // Sophos made the list at the time.
    const id = randomUUID();
    tenant.lists.set(id, { id, name: "Example pilot allows", sites: [{ id: randomUUID(), site: "chat.example.org" }] });
    return { dataDir, tenant, ctx: ctxOf(tenant), id, file };
  };
  {
    const { dataDir, ctx, id, file } = await setup("v0325-v0323-allow");
    const [a] = (await loadPilotRecord(dataDir, T)).allows;
    assert.deepEqual([a.status, a.listName, a.answer, a.readBack, a.error], ["unconfirmed", "Example pilot allows", UNCLEAR, `not read: ${UNAVAILABLE}`, undefined]);
    assert.equal(readFileSync(file, "utf8"), JSON.stringify(fixture.pilot), "the file isn't changed");
    const plan = await planAllow(dataDir, ctx, "chat.example.org");
    assert.deepEqual([plan.problems, plan.steps.map((s) => s.op)], [[], ["use-list", "link-list"]]);
    const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
    assert.deepEqual([entry.id, entry.status, entry.listId], [a.id, "added", id]);
  }
  {
    const { dataDir, tenant, ctx, id } = await setup("v0325-v0323-allow-undo");
    const [a] = (await loadPilotRecord(dataDir, T)).allows;
    const undone = await undoAllow(dataDir, ctx, a.id);
    assert.deepEqual([undone.status, undone.listId], ["undone", id]);
    assert.equal(tenant.lists.has(id), false);
  }
});

test("v0.3.23 Allows that failed another way stay failed", async () => {
  for (const name of ["refused", "unmade"]) {
    const dataDir = await dataDirFor(`v0325-v0323-allow-${name}`);
    onFile(dataDir, V0323.allow[name].build);
    mkdirSync(path.join(dataDir, "pilot"), { recursive: true });
    writeFileSync(path.join(dataDir, "pilot", `${T}.json`), JSON.stringify(V0323.allow[name].pilot));
    const [a] = (await loadPilotRecord(dataDir, T)).allows;
    assert.deepEqual([a.status, a.listName, a.error], ["failed", "", V0323.allow[name].pilot.allows[0].error], name);
  }
});

test("a v0.3.23 Create site lists record in that state is read as not confirmed: the next create uses the list, and Undo deletes it", async () => {
  const setup = async (name, rec) => {
    const dataDir = await dataDirFor(name);
    mkdirSync(path.join(dataDir, "cleanup"), { recursive: true });
    const file = path.join(dataDir, "cleanup", `${T}.lists.json`);
    writeFileSync(file, JSON.stringify(rec));
    return { dataDir, file };
  };
  {
    const { dataDir, file } = await setup("v0325-v0323-lists", V0323.lists.unread);
    const tenant = new Tenant();
    const id = randomUUID();
    tenant.lists.set(id, { id, name: "Example cleaned Block", sites: [{ id: randomUUID(), site: "app.example.com" }] });
    const read = await lastListsRecord(dataDir, T);
    assert.deepEqual(read.lists.map((l) => [l.status, l.answer, l.readBack, l.error]), [["unconfirmed", UNCLEAR, `not read: ${UNAVAILABLE}`, undefined]]);
    assert.equal(readFileSync(file, "utf8"), JSON.stringify(V0323.lists.unread), "the file isn't changed");
    const plan = await planLists(tenant, T, RESULTS, "Example cleaned", { dataDir, scope: T });
    assert.deepEqual([plan.problems, plan.reuse], [[], [{ name: "Example cleaned Block", id }]]);
    const undone = await undoLists(dataDir, tenant, T);
    assert.deepEqual(undone.lists.map((l) => [l.status, l.lookedUp]), [["deleted", "found"]]);
    assert.equal(tenant.lists.has(id), false);
  }
  for (const name of ["refused", "unmade"]) {
    const { dataDir } = await setup(`v0325-v0323-lists-${name}`, V0323.lists[name]);
    const read = await lastListsRecord(dataDir, T);
    assert.deepEqual(read.lists.map((l) => [l.status, l.error]), [["failed", V0323.lists[name].lists[0].error]], name);
  }
});
