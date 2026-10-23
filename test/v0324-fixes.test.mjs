// v0.3.24, in what the services record: a create Sophos answered with a 5xx,
// whose name lookup after couldn't be read (a build step, an Allow's new list,
// Create site lists), is kept as not confirmed, with what Sophos said and why
// nothing was read, not as failed. The next run looks for it by name before
// it creates anything: found, and no record has its id, it's used and said
// so; not found, it's created. auditedDelete is gone. And no service answer,
// record or error carries the client's advice to check the destination after
// a read-back has said what happened. Each case runs against an in-memory
// tenant (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, dryRun, execute, getBuild, listBuilds, rollback, saveRecord } from "../backend/dist/services/build-service.js";
import { addAllow, loadPilotRecord, planAllow, undoAllow } from "../backend/dist/services/pilot-service.js";
import { createLists, lastListsRecord, planLists, undoLists } from "../backend/dist/services/lists-service.js";
import { moveWave, setPilotEnabled, undoWave } from "../backend/dist/services/promote-service.js";
import { restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { runReadiness } from "../backend/dist/services/readiness.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { wcPolicy } from "./fixtures.mjs";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, classicTenant, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOT_READ = `not read: ${UNAVAILABLE}`;

before(() => setReadBackDelays([0, 0]));

const auditOf = (dataDir) => readFileSync(path.join(dataDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const posts = (tenant, pattern) => tenant.calls.filter((c) => c.startsWith("POST ") && pattern.test(c.slice(5))).length;

/** Creates matching write go through, then answer 500, and the collection read after them fails (503): nothing says whether they were made. */
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

// ---------- item 1: a build step ----------

/** A classic tenant and the pilot options for the Sales profile, which has a site list. */
async function buildSetup(name) {
  const dataDir = await dataDirFor(name);
  const tenant = classicTenant();
  const ctx = ctxOf(tenant);
  const { design } = await designFor(dataDir, ctx);
  const pilot = { profileKey: design.profiles.find((p) => p.siteLists.length).key, enabled: false, targets: { endpoints: ["w1"] } };
  return { dataDir, tenant, ctx, pilot };
}

test("a build step Sophos answered 500, whose name lookup couldn't be read, is not confirmed, and the next build uses it, saying so", async () => {
  const { dataDir, tenant, ctx, pilot } = await buildSetup("v0324-build");
  const off = unreadCreate(tenant, /\/site-lists$/, /\/site-lists$/);
  const first = await execute(dataDir, ctx, pilot, TOOL);
  off();
  const [list] = first.steps;
  assert.deepEqual([first.status, list.kind, list.status, list.id, list.answer, list.readBack, list.readBackNote, list.error], ["partial", "site-list", "unconfirmed", undefined, UNCLEAR, "not-read", UNAVAILABLE, undefined]);
  assert.deepEqual(first.steps.slice(1).map((s) => s.status), ["planned", "planned"], "the build stopped at it");
  const made = [...tenant.lists.values()].find((l) => l.name === list.name);
  assert.ok(made, "Sophos made it");
  // The next build: its dry run finds the list by name and says it will use it.
  const plan = await dryRun(dataDir, ctx, pilot);
  assert.deepEqual(plan.steps[0].found, { id: made.id, build: first.id });
  assert.ok(plan.checks.every((c) => c.ok), JSON.stringify(plan.checks));
  assert.ok(plan.checks.some((c) => c.level === "warn" && c.text === `The site list "${list.name}" is in the tenant. An earlier build asked for it and Sophos didn't confirm it was made, so this build uses it rather than making another.`));
  assert.ok(plan.checks.some((c) => c.text === "Site lists: 1 in the account, 0 to add, limit 20."), "the list found isn't counted as one to add");
  const before = posts(tenant, /\/site-lists$/);
  const second = await execute(dataDir, ctx, pilot, TOOL);
  assert.equal(second.status, "built", JSON.stringify(second.steps));
  assert.equal(posts(tenant, /\/site-lists$/), before, "no create sent for it");
  assert.equal([...tenant.lists.values()].filter((l) => l.name === list.name).length, 1, "not made twice");
  assert.deepEqual([second.steps[0].id, second.steps[0].status, second.steps[0].readBack, second.steps[0].note], [made.id, "created", "matches", "Found by name: an earlier build asked for it and Sophos didn't confirm it, so it's used, not made again."]);
  assert.ok(auditOf(dataDir).some((e) => e.action === "reuse" && e.resourceId === made.id && e.ok));
  // A third build doesn't take it: a build has its id now.
  const third = await dryRun(dataDir, ctx, pilot);
  assert.ok(third.checks.some((c) => !c.ok && /A site list named ".+" already exists/.test(c.text)), JSON.stringify(third.checks));
  // A rollback of the build that used it deletes it.
  const r = await rollback(dataDir, ctx, second.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  assert.ok(![...tenant.lists.values()].some((l) => l.name === list.name));
});

test("a build step not confirmed that Sophos didn't make is created by the next build", async () => {
  const { dataDir, tenant, ctx, pilot } = await buildSetup("v0324-build-unmade");
  const off = unreadUnmade(tenant, /\/site-lists$/, /\/site-lists$/);
  const first = await execute(dataDir, ctx, pilot, TOOL);
  off();
  assert.equal(first.steps[0].status, "unconfirmed");
  const plan = await dryRun(dataDir, ctx, pilot);
  assert.equal(plan.steps[0].found, undefined);
  const second = await execute(dataDir, ctx, pilot, TOOL);
  assert.equal(second.status, "built", JSON.stringify(second.steps));
  assert.equal(second.steps[0].note, undefined);
});

test("a profile step not confirmed is used by the next build; a name another build has the id for isn't", async () => {
  const dataDir = await dataDirFor("v0324-build-profile");
  const tenant = classicTenant();
  // A Base Policy gives a profile with no site lists, so the profile is the build's first create.
  tenant.policies.set("base", wcPolicy({ id: "base", name: "Base Policy", priority: 0 }));
  const ctx = ctxOf(tenant);
  const { design } = await designFor(dataDir, ctx);
  const pilot = { profileKey: design.profiles.find((p) => !p.siteLists.length).key, enabled: false, targets: { endpoints: ["w1"] } };
  const off = unreadCreate(tenant, /\/profiles$/, /\/profiles$/);
  const first = await execute(dataDir, ctx, pilot, TOOL);
  off();
  assert.deepEqual(first.steps.map((s) => [s.kind, s.status]), [["profile", "unconfirmed"], ["policy", "planned"]]);
  const made = [...tenant.profiles.values()].find((p) => p.name === first.steps[0].name);
  const second = await execute(dataDir, ctx, pilot, TOOL);
  assert.equal(second.status, "built", JSON.stringify(second.steps));
  assert.deepEqual([second.steps[0].id, second.steps[0].status], [made.id, "created"]);
  assert.equal(tenant.profiles.size, 1, "not made twice");
  // A record whose id is on file, under an earlier build's unconfirmed step of the same name, isn't taken.
  const rec = (await listBuilds(dataDir, T)).find((b) => b.id === first.id);
  await saveRecord(dataDir, { ...rec, id: randomUUID(), createdAt: new Date(0).toISOString() });
  const third = await dryRun(dataDir, ctx, pilot);
  assert.equal(third.steps[0].found, undefined);
  assert.ok(third.checks.some((c) => !c.ok && c.text.startsWith(`A profile named "${made.name}" already exists.`)));
});

// ---------- item 1: an Allow's new list ----------

const LISTS = /\/site-lists$/;

test("an Allow whose new list Sophos answered 500, with the site lists not read after, is not confirmed; Allow it again uses the list it finds, on the same entry", async () => {
  const dataDir = await dataDirFor("v0324-allow");
  const tenant = new Tenant();
  const { build, profileId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const off = unreadCreate(tenant, LISTS, LISTS);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  off();
  assert.deepEqual([entry.status, entry.listId, entry.createdList, entry.listName, entry.answer, entry.readBack, entry.error], ["unconfirmed", undefined, false, "Example pilot allows", UNCLEAR, NOT_READ, undefined]);
  assert.equal((await getBuild(dataDir, T, build.id)).steps.length, 3, "no list on the build without an id");
  const made = [...tenant.lists.values()].find((l) => l.name === "Example pilot allows");
  assert.ok(made, "Sophos made it");
  const plan = await planAllow(dataDir, ctx, "chat.example.org");
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.steps.map((s) => s.op), ["use-list", "link-list"]);
  assert.ok(plan.notes.includes(`The site list "Example pilot allows" from the Allow for chat.example.org is in the tenant. Sophos didn't confirm it was made, so this Allow uses it rather than making another.`));
  const before = posts(tenant, LISTS);
  const { entry: again } = await addAllow(dataDir, ctx, "chat.example.org");
  assert.equal(posts(tenant, LISTS), before, "no create sent");
  assert.deepEqual([again.id, again.status, again.listId, again.createdList, again.readBack, again.answer], [entry.id, "added", made.id, true, "list holds the site; profile links it as allow", undefined]);
  assert.equal(again.note, 'The site list "Example pilot allows" was found by name and used, not made again.');
  const record = await loadPilotRecord(dataDir, T);
  assert.equal(record.allows.length, 1, "one entry for the site");
  assert.ok((await getBuild(dataDir, T, build.id)).steps.some((s) => s.id === made.id), "the build owns it, so a rollback deletes it");
  assert.ok(tenant.profiles.get(profileId).siteListActions.some((a) => a.id === made.id && a.action === "allow"));
  assert.ok(auditOf(dataDir).some((e) => e.action === "reuse" && e.resourceId === made.id));
  // Undo deletes it.
  const undone = await undoAllow(dataDir, ctx, entry.id);
  assert.equal(undone.status, "undone", undone.error);
  assert.ok(!tenant.lists.has(made.id));
});

test("an Allow for another site uses the list an unconfirmed Allow asked for, and both entries can be undone", async () => {
  const dataDir = await dataDirFor("v0324-allow-other");
  const tenant = new Tenant();
  const { profileId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const off = unreadCreate(tenant, LISTS, LISTS);
  const { entry: first } = await addAllow(dataDir, ctx, "chat.example.org");
  off();
  assert.equal(first.status, "unconfirmed");
  const plan = await planAllow(dataDir, ctx, "video.example.net");
  assert.deepEqual(plan.steps.map((s) => s.op), ["use-list", "link-list", "add-site"]);
  const { entry: second } = await addAllow(dataDir, ctx, "video.example.net");
  const list = [...tenant.lists.values()].find((l) => l.name === "Example pilot allows");
  assert.deepEqual([second.status, second.listId, second.createdList, second.readBack], ["added", list.id, false, "site listed; profile links it as allow"]);
  const held = (await loadPilotRecord(dataDir, T)).allows.find((a) => a.id === first.id);
  assert.deepEqual([held.status, held.listId, held.createdList, held.readBack, held.answer], ["added", list.id, true, "list holds the site; profile links it as allow", undefined]);
  assert.deepEqual(list.sites.map((s) => s.site).sort(), ["chat.example.org", "video.example.net"]);
  assert.equal((await undoAllow(dataDir, ctx, second.id)).status, "undone");
  assert.deepEqual(tenant.lists.get(list.id).sites.map((s) => s.site), ["chat.example.org"]);
  assert.equal((await undoAllow(dataDir, ctx, first.id)).status, "undone");
  assert.ok(!tenant.lists.has(list.id));
  assert.ok(!tenant.profiles.get(profileId).siteListActions.some((a) => a.id === list.id));
});

test("an Allow not confirmed whose list Sophos didn't make is made by the next Allow of the site, on the same entry", async () => {
  const dataDir = await dataDirFor("v0324-allow-unmade");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const off = unreadUnmade(tenant, LISTS, LISTS);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  off();
  assert.equal(entry.status, "unconfirmed");
  assert.deepEqual((await planAllow(dataDir, ctx, "chat.example.org")).steps.map((s) => s.op), ["create-list", "link-list"]);
  const { entry: again } = await addAllow(dataDir, ctx, "chat.example.org");
  assert.deepEqual([again.id, again.status, again.note], [entry.id, "added", undefined]);
  assert.equal((await loadPilotRecord(dataDir, T)).allows.length, 1);
});

// ---------- item 1: Create site lists ----------

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com"), result(2, "chat.example.org", "warn")];

test("Create site lists: a list Sophos answered 500, with the site lists not read after, is not confirmed, and the next create uses it, saying so", async () => {
  const dataDir = await dataDirFor("v0324-lists");
  const tenant = new Tenant();
  const off = unreadCreate(tenant, LISTS, LISTS);
  const first = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  off();
  // It stops there, as a failed create does: the list after it isn't sent.
  assert.deepEqual(first.lists.map((l) => [l.name, l.status, l.id, l.answer, l.readBack, l.error]), [["Example cleaned Block", "unconfirmed", undefined, UNCLEAR, NOT_READ, undefined]]);
  assert.equal(posts(tenant, LISTS), 1);
  const made = [...tenant.lists.values()].find((l) => l.name === "Example cleaned Block");
  // Without the record to look in, the name is taken, as before.
  assert.deepEqual((await planLists(tenant, T, RESULTS, "Example cleaned")).problems, ['A site list named "Example cleaned Block" already exists.']);
  const plan = await planLists(tenant, T, RESULTS, "Example cleaned", { dataDir, scope: T });
  assert.deepEqual([plan.problems, plan.reuse], [[], [{ name: "Example cleaned Block", id: made.id }]]);
  assert.deepEqual(plan.notes, ['"Example cleaned Block" is in the tenant. The last create asked for it and Sophos didn\'t confirm it was made, so this one uses it rather than making another.']);
  const before = posts(tenant, LISTS);
  const second = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  assert.equal(posts(tenant, LISTS), before + 1, "only the other list is created");
  assert.deepEqual(second.lists.map((l) => [l.status, l.readBack]), [["created", "matches"], ["created", "matches"]]);
  assert.deepEqual([second.lists[0].id, second.lists[0].note], [made.id, "Found by name: the last create asked for it and Sophos didn't confirm it, so it's used, not made again."]);
  assert.ok(auditOf(dataDir).some((e) => e.action === "reuse" && e.resourceId === made.id));
  // Undo last lists deletes both.
  const undone = await undoLists(dataDir, tenant, T);
  assert.deepEqual(undone.lists.map((l) => l.status), ["deleted", "deleted"]);
  assert.equal(tenant.lists.size, 0);
  // Not found: created.
  const d2 = await dataDirFor("v0324-lists-unmade");
  const t2 = new Tenant();
  const off2 = unreadUnmade(t2, LISTS, LISTS);
  await createLists(d2, t2, T, T, RESULTS, "Example cleaned");
  off2();
  assert.equal((await lastListsRecord(d2, T)).lists[0].status, "unconfirmed");
  const again = await createLists(d2, t2, T, T, RESULTS, "Example cleaned");
  assert.deepEqual(again.lists.map((l) => [l.status, l.note]), [["created", undefined], ["created", undefined]]);
});

// ---------- item 3: the unused helper ----------

test("auditedDelete is gone, and nothing refers to it", () => {
  const files = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (/\.(ts|js|mjs|md|html)$/.test(d.name) && !p.endsWith("v0324-fixes.test.mjs")) files.push(p);
    }
  };
  walk(root);
  assert.ok(files.length > 50);
  assert.deepEqual(files.filter((f) => readFileSync(f, "utf8").includes("auditedDelete")).map((f) => path.relative(root, f)), []);
});

// ---------- item 4: no default advice once a read-back has answered ----------

test("no answer, record or error says to check the destination once a read-back has said whether a write Sophos answered 500 was made", { timeout: 120_000 }, async () => {
  const ADVICE = /check the destination/;
  const hits = [];
  const scan = (where, v, p = "") => {
    if (typeof v === "string") ADVICE.test(v) && hits.push(`${where}${p}: ${v}`);
    else if (Array.isArray(v)) v.forEach((x, i) => scan(where, x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) scan(where, x, `${p}.${k}`);
  };
  const run = async (where, fn) => scan(where, await fn().catch((err) => ({ thrown: err.message })));
  const saved = (where, dataDir) => {
    const walk = (dir) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (d.name.endsWith(".json")) scan(`${where} [${path.relative(dataDir, p)}]`, JSON.parse(readFileSync(p, "utf8")));
      }
    };
    walk(dataDir);
  };
  // A write answered 500 that went through, and one that didn't: the read-back finds which.
  const MODES = { made: (t, m, w) => t.unclear(m, w), unmade: (t, m, w) => (t.ignore(m, w), t.unclear(m, w)) };
  for (const [mode, rule] of Object.entries(MODES)) {
    for (const [what, write] of [["site-list", LISTS], ["profile", /\/profiles$/], ["policy", /\/policies$/]]) {
      const { dataDir, tenant, ctx, pilot } = await buildSetup(`v0324-advice-build-${what}-${mode}`);
      rule(tenant, "POST", write);
      await run(`build ${what} ${mode}`, () => execute(dataDir, ctx, pilot, TOOL));
      saved(`build ${what} ${mode}`, dataDir);
    }
    for (const [what, method, write] of [["policy delete", "DELETE", /\/policies\/[^/]+$/], ["list delete", "DELETE", /\/site-lists\/[^/]+$/], ["entry create", "POST", /\/local-sites$/]]) {
      const dataDir = await dataDirFor(`v0324-advice-rollback-${mode}`);
      const tenant = new Tenant();
      const { build } = seedPilot(tenant, dataDir);
      const id = randomUUID();
      tenant.localSites.set(id, { id, url: "kept.example.com", tags: ["staff"] });
      const snap = await runReadiness(dataDir, tenant, { id: T, name: "Example Tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, TOOL);
      await saveRecord(dataDir, { ...(await getBuild(dataDir, T, build.id)), snapshotFile: snap.snapshot.file });
      tenant.localSites.delete(id);
      rule(tenant, method, write);
      await run(`rollback ${what} ${mode}`, () => rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false }));
      saved(`rollback ${what} ${mode}`, dataDir);
    }
    for (const [what, method, write, seed] of [["new list", "POST", LISTS], ["link", "PUT", /\/profiles\/[^/]+$/], ["site", "POST", /\/sites$/, "video.example.net"]]) {
      const dataDir = await dataDirFor(`v0324-advice-allow-${mode}`);
      const tenant = new Tenant();
      seedPilot(tenant, dataDir);
      if (seed) await addAllow(dataDir, ctxOf(tenant), seed);
      rule(tenant, method, write);
      await run(`allow ${what} ${mode}`, () => addAllow(dataDir, ctxOf(tenant), "chat.example.org"));
      saved(`allow ${what} ${mode}`, dataDir);
    }
    for (const [what, method, write, two] of [["unlink", "PUT", /\/profiles\/[^/]+$/], ["list delete", "DELETE", /\/site-lists\/[^/]+$/], ["site delete", "DELETE", /\/sites\/[^/]+$/, true]]) {
      const dataDir = await dataDirFor(`v0324-advice-undo-${mode}`);
      const tenant = new Tenant();
      seedPilot(tenant, dataDir);
      const { entry } = await addAllow(dataDir, ctxOf(tenant), "chat.example.org");
      const last = two ? (await addAllow(dataDir, ctxOf(tenant), "video.example.net")).entry : entry;
      rule(tenant, method, write);
      await run(`undo ${what} ${mode}`, () => undoAllow(dataDir, ctxOf(tenant), last.id));
      saved(`undo ${what} ${mode}`, dataDir);
    }
    {
      const dataDir = await dataDirFor(`v0324-advice-promote-${mode}`);
      const tenant = new Tenant();
      const { policyId } = seedPilot(tenant, dataDir);
      const POLICY = new RegExp(`/policies/${policyId}$`);
      rule(tenant, "PATCH", POLICY);
      await run(`wave ${mode}`, () => moveWave(dataDir, ctxOf(tenant), ["w2"], false));
      tenant.rules.length = 0;
      const w = await moveWave(dataDir, ctxOf(tenant), ["w3"], false);
      rule(tenant, "PATCH", POLICY);
      await run(`wave undo ${mode}`, () => undoWave(dataDir, ctxOf(tenant), w.id));
      await run(`switch ${mode}`, () => setPilotEnabled(dataDir, ctxOf(tenant), true));
      saved(`promote ${mode}`, dataDir);
    }
    for (const [what, method, write] of [["tags", "PATCH", /\/policies\/[^/]+$/], ["entry delete", "DELETE", /\/local-sites\/[^/]+$/], ["entry patch", "PATCH", /\/local-sites\/[^/]+$/]]) {
      const dataDir = await dataDirFor(`v0324-advice-retire-${mode}`);
      const { tenant } = await retireTenant(dataDir);
      rule(tenant, method, write);
      await run(`retire ${what} ${mode}`, () => retire(dataDir, ctxOf(tenant), ["old"], true, TOOL));
      saved(`retire ${what} ${mode}`, dataDir);
      const d2 = await dataDirFor(`v0324-advice-restore-${mode}`);
      const r2 = await retireTenant(d2);
      const rec = await retire(d2, ctxOf(r2.tenant), ["old"], true, TOOL);
      rule(r2.tenant, method === "DELETE" ? "POST" : method, method === "DELETE" ? /\/local-sites$/ : write);
      await run(`restore ${what} ${mode}`, () => restoreRetire(d2, ctxOf(r2.tenant), rec.id));
      saved(`restore ${what} ${mode}`, d2);
    }
    {
      const dataDir = await dataDirFor(`v0324-advice-lists-${mode}`);
      const tenant = new Tenant();
      rule(tenant, "POST", LISTS);
      await run(`lists ${mode}`, () => createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned"));
      tenant.rules.length = 0;
      rule(tenant, "DELETE", /\/site-lists\/[^/]+$/);
      await run(`lists undo ${mode}`, () => undoLists(dataDir, tenant, T));
      saved(`lists ${mode}`, dataDir);
    }
  }
  assert.deepEqual(hits, []);
});
