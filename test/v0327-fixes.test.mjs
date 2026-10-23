// v0.3.27, in what the services record. A build step whose create was in
// flight when the server stopped was saved as planned with no id, the same as
// a step never sent, so it showed Not sent, a rollback left it, and the next
// build was refused its name. Each step is now marked as sending, and saved,
// before its create goes, and a step saved that way is read as not
// confirmed: the next build looks for it by name and uses it, or creates it
// when it isn't there, and a rollback looks for it by name and deletes it.
// The server stopping is a create held in flight that never answers, with
// the records read from disk as a server started again would read them. Each
// case runs against an in-memory tenant (memory-tenant.mjs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, dryRun, execute, listBuilds, rollback } from "../backend/dist/services/build-service.js";
import { T, TOOL, classicTenant, ctxOf, dataDirFor } from "./memory-tenant.mjs";

const LISTS = /\/site-lists$/;
const PROFILES = /\/profiles$/;
const POLICIES = /\/policies$/;
const IN_FLIGHT = { answer: "The tool stopped before it saved what Sophos answered", readBack: "not-read", readBackNote: "none was saved" };
const FOUND_NOTE = "Found by name: an earlier build asked for it and Sophos didn't confirm it, so it's used, not made again.";

before(() => setReadBackDelays([0, 0]));

/** A classic tenant and the pilot options for its profile, which has a site list: a list, the profile, then the pilot policy. */
async function buildSetup(name) {
  const dataDir = await dataDirFor(name);
  const tenant = classicTenant();
  const ctx = ctxOf(tenant);
  const { design } = await designFor(dataDir, ctx);
  const pilot = { profileKey: design.profiles.find((p) => p.siteLists.length).key, enabled: false, targets: { endpoints: ["w1"] } };
  return { dataDir, tenant, ctx, pilot };
}

/**
 * The first create that matches is made (or not, with made false) and never answered, as when the server stops while
 * it's in flight. Resolves once it's held. Later creates go through.
 */
function holdCreate(tenant, pattern, made = true) {
  let held;
  const holding = new Promise((resolve) => (held = resolve));
  const real = tenant.tenantRequest.bind(tenant);
  let on = true;
  tenant.tenantRequest = async (tenantId, p, o = {}) => {
    if (!on || (o.method ?? "GET") !== "POST" || !pattern.test(p)) return real(tenantId, p, o);
    on = false;
    if (made) await real(tenantId, p, o);
    else tenant.calls.push(`POST ${p}`);
    held();
    return new Promise(() => {});
  };
  return holding;
}

/** Starts a build and stops it while the matching create is held: the build as a server started again reads it. */
async function stoppedBuild(s, pattern, made = true) {
  const holding = holdCreate(s.tenant, pattern, made);
  // Never answers: the server stopped while the create was out.
  void execute(s.dataDir, s.ctx, s.pilot, TOOL);
  await holding;
  const [b] = await listBuilds(s.dataDir, T);
  return b;
}

const rawRecords = (dataDir) => readdirSync(path.join(dataDir, "builds", T)).map((n) => JSON.parse(readFileSync(path.join(dataDir, "builds", T, n), "utf8")));
const posts = (tenant, pattern) => tenant.calls.filter((c) => c.startsWith("POST ") && pattern.test(c.slice(5))).length;
const named = (map, name) => [...map.values()].filter((x) => x.name === name);
const fields = (s) => ({ status: s.status, id: s.id, answer: s.answer, readBack: s.readBack, readBackNote: s.readBackNote, sending: s.sending });

test("the step a build was sending is marked and saved before its create goes; read back, it's not confirmed, and the steps after it weren't sent", async () => {
  const s = await buildSetup("v0327-mark");
  const holding = holdCreate(s.tenant, LISTS);
  void execute(s.dataDir, s.ctx, s.pilot, TOOL);
  await holding;
  const [raw] = rawRecords(s.dataDir);
  assert.deepEqual(raw.steps.map((x) => [x.status, x.sending ?? false]), [["planned", true], ["planned", false], ["planned", false]], "saved before the create went");
  const [b] = await listBuilds(s.dataDir, T);
  assert.equal(b.status, "partial");
  assert.deepEqual(fields(b.steps[0]), { status: "unconfirmed", id: undefined, ...IN_FLIGHT, sending: undefined });
  assert.deepEqual(b.steps.slice(1).map((x) => x.status), ["planned", "planned"]);
});

test("a site list in flight when the server stopped, which Sophos made, is used by the next build, which says so and doesn't make it again", async () => {
  const s = await buildSetup("v0327-list-made");
  const stopped = await stoppedBuild(s, LISTS);
  const list = stopped.steps[0];
  assert.deepEqual(fields(list), { status: "unconfirmed", id: undefined, ...IN_FLIGHT, sending: undefined });
  const [made] = named(s.tenant.lists, list.name);
  assert.ok(made, "Sophos made it");
  const plan = await dryRun(s.dataDir, s.ctx, s.pilot);
  assert.deepEqual(plan.steps[0].found, { id: made.id, build: stopped.id });
  assert.ok(plan.checks.every((c) => c.ok), JSON.stringify(plan.checks));
  assert.ok(plan.checks.some((c) => c.level === "warn" && c.text === `The site list "${list.name}" is in the tenant. An earlier build asked for it and Sophos didn't confirm it was made, so this build uses it rather than making another.`));
  const sent = posts(s.tenant, LISTS);
  const next = await execute(s.dataDir, s.ctx, s.pilot, TOOL);
  assert.equal(next.status, "built", JSON.stringify(next.steps));
  assert.equal(posts(s.tenant, LISTS), sent, "no create sent for it");
  assert.equal(named(s.tenant.lists, list.name).length, 1, "not made twice");
  assert.deepEqual([next.steps[0].id, next.steps[0].status, next.steps[0].note], [made.id, "created", FOUND_NOTE]);
});

test("a site list in flight when the server stopped, which Sophos didn't make, is created by the next build", async () => {
  const s = await buildSetup("v0327-list-unmade");
  const stopped = await stoppedBuild(s, LISTS, false);
  const list = stopped.steps[0];
  assert.deepEqual(fields(list), { status: "unconfirmed", id: undefined, ...IN_FLIGHT, sending: undefined });
  assert.equal(named(s.tenant.lists, list.name).length, 0);
  const plan = await dryRun(s.dataDir, s.ctx, s.pilot);
  assert.equal(plan.steps[0].found, undefined);
  const next = await execute(s.dataDir, s.ctx, s.pilot, TOOL);
  assert.equal(next.status, "built", JSON.stringify(next.steps));
  assert.equal(next.steps[0].note, undefined);
  assert.equal(named(s.tenant.lists, list.name).length, 1);
});

test("a rollback looks for a profile in flight when the server stopped by name and deletes it, then the site list", async () => {
  const s = await buildSetup("v0327-profile");
  const stopped = await stoppedBuild(s, PROFILES);
  assert.deepEqual(stopped.steps.map((x) => [x.kind, x.status, !!x.id]), [["site-list", "created", true], ["profile", "unconfirmed", false], ["policy", "planned", false]]);
  assert.deepEqual(fields(stopped.steps[1]), { status: "unconfirmed", id: undefined, ...IN_FLIGHT, sending: undefined });
  assert.equal(named(s.tenant.profiles, stopped.steps[1].name).length, 1, "Sophos made it");
  const r = await rollback(s.dataDir, s.ctx, stopped.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  assert.deepEqual(r.rollback.steps.filter((o) => o.kind !== "website-management").map((o) => [o.kind, o.lookedUp ?? null]), [["profile", "found"], ["site-list", null]]);
  assert.deepEqual([s.tenant.profiles.size, s.tenant.lists.size], [0, 0]);
});

test("a rollback looks for a pilot policy in flight when the server stopped by name and deletes it before the profile and list", async () => {
  const s = await buildSetup("v0327-policy");
  const stopped = await stoppedBuild(s, POLICIES);
  assert.deepEqual(stopped.steps.map((x) => x.status), ["created", "created", "unconfirmed"]);
  const [policy] = named(s.tenant.policies, stopped.pilot.name);
  assert.ok(policy, "Sophos made the pilot policy");
  const r = await rollback(s.dataDir, s.ctx, stopped.id, { dryRun: false });
  assert.equal(r.status, "rolled-back", JSON.stringify(r.rollback.steps));
  assert.deepEqual(r.rollback.steps.filter((o) => o.kind !== "website-management").map((o) => [o.kind, o.lookedUp ?? null]), [["policy", "found"], ["profile", null], ["site-list", null]]);
  assert.deepEqual([s.tenant.policies.has(policy.id), s.tenant.profiles.size, s.tenant.lists.size], [false, 0, 0]);
});

test("once a step's outcome is recorded, its record keeps no sending mark: built, refused, or not confirmed after a 5xx", async () => {
  const built = await buildSetup("v0327-clear-built");
  assert.equal((await execute(built.dataDir, built.ctx, built.pilot, TOOL)).status, "built");
  const refused = await buildSetup("v0327-clear-refused");
  refused.tenant.refuse("POST", PROFILES, 403);
  assert.deepEqual((await execute(refused.dataDir, refused.ctx, refused.pilot, TOOL)).steps.map((x) => x.status), ["created", "failed", "planned"]);
  const unclear = await buildSetup("v0327-clear-unclear");
  unclear.tenant.unclear("POST", LISTS);
  unclear.tenant.refuse("GET", LISTS, 503, () => unclear.tenant.writes > 0);
  assert.deepEqual((await execute(unclear.dataDir, unclear.ctx, unclear.pilot, TOOL)).steps.map((x) => x.status), ["unconfirmed", "planned", "planned"]);
  for (const s of [built, refused, unclear]) {
    for (const r of rawRecords(s.dataDir)) assert.deepEqual(r.steps.filter((x) => "sending" in x), [], "no sending mark left");
  }
  // And a step never sent isn't read as not confirmed.
  assert.deepEqual((await listBuilds(refused.dataDir, T))[0].steps.map((x) => x.status), ["created", "failed", "planned"]);
});
