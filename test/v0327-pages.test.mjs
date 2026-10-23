// v0.3.27, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant. The rollback's
// confirm lists what it deletes in the order the rollback deletes it: the
// policy, then the profile, then the site lists, last made first. And a step
// whose create was in flight when the server stopped shows Not confirmed,
// amber, with the same note as a create Sophos answered with a 5xx that
// couldn't be looked for, and a Detail line saying the tool stopped before
// it saved the answer.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, execute, listBuilds, rollback } from "../backend/dist/services/build-service.js";
import { T, TOOL, afterWrite, classicTenant, ctxOf, dataDirFor } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.27", readOnly: false };
const LISTS = /\/site-lists$/;
const PROFILES = /\/profiles$/;

/** The frontend with an API whose routes answer as set: a body, or a function of the request body. Routes are read on each request. */
async function server(routes) {
  const app = express();
  app.use(express.json());
  app.all("/api/*", async (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(status);
    const route = routes[key];
    if (route === undefined) return res.status(404).json({ error: "not_found" });
    res.json(typeof route === "function" ? await route(req.body ?? {}) : route);
  });
  app.use(express.static(path.join(here, "..", "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}` };
}

// Every confirm is answered yes and kept.
const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__unhandled.push(String(e.message))); window.__confirms = []; window.confirm = (m) => (window.__confirms.push(String(m)), true); true`;
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); e.click(); return true; })()`;

async function waitFor(b, expr, what) {
  for (let i = 0; i < 150; i++) {
    const v = await b.evaluate(expr);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Each step on the Plan card: its tag's text and class, its note, and its Detail line. */
const STEPS = `[...document.querySelectorAll(".steps-list > li")].map((r) => { const t = r.querySelector(".tag"); return { tag: t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null, note: r.querySelector(".err-note")?.textContent.trim() ?? null, detail: r.querySelector("[data-error-detail]")?.textContent.trim() ?? null }; })`;
const TOAST = `(() => { const e = [...document.querySelectorAll(".toast")].pop(); if (!e) return null; const k = e.cloneNode(true); k.querySelector("[data-toast-detail]")?.remove(); return k.textContent.trim(); })()`;

/** The classic tenant with a second tag, an Allow, so its profile has two site lists: a build makes both, then the profile and the pilot policy. */
async function setup(name) {
  const dataDir = await dataDirFor(`v0327-pages-${name}`);
  const tenant = classicTenant();
  const sales = [...tenant.policies.values()].find((p) => p.name === "Sales");
  sales.settings["endpoint.web-control.tags.settings"].value.push({ tag: "guest", action: "allow" });
  const id = randomUUID();
  tenant.localSites.set(id, { id, url: "allowed.example.com", tags: ["guest"] });
  const ctx = ctxOf(tenant);
  const { design } = await designFor(dataDir, ctx);
  const pilot = { profileKey: design.profiles.find((p) => p.siteLists.length === 2).key, enabled: false, targets: { endpoints: ["w1"] } };
  return { dataDir, tenant, ctx, design, pilot };
}

/** The first create that matches is made and never answered, as when the server stops while it's in flight. Resolves once it's held. */
function holdCreate(tenant, pattern) {
  let held;
  const holding = new Promise((resolve) => (held = resolve));
  const real = tenant.tenantRequest.bind(tenant);
  let on = true;
  tenant.tenantRequest = async (tenantId, p, o = {}) => {
    if (!on || (o.method ?? "GET") !== "POST" || !pattern.test(p)) return real(tenantId, p, o);
    on = false;
    await real(tenantId, p, o);
    held();
    return new Promise(() => {});
  };
  return holding;
}

/** A build stopped while the matching create was held: the record as a server started again reads it. */
async function stopped(s, pattern) {
  const holding = holdCreate(s.tenant, pattern);
  // Never answers: the server stopped while the create was out.
  void execute(s.dataDir, s.ctx, s.pilot, TOOL);
  await holding;
  return (await listBuilds(s.dataDir, T))[0];
}

/** The objects a rollback sent deletes for, in order, named as the confirm names them. */
function deletesOf(tenant, rec, from) {
  const names = new Map(rec.steps.filter((s) => s.id).map((s) => [s.id, `${s.kind === "site-list" ? "site list" : s.kind} "${s.name}"`]));
  return tenant.calls.slice(from).filter((c) => /^DELETE \/(web-filters|endpoint)\/v1\/(site-lists|profiles|policies)\/[^/]+$/.test(c)).map((c) => names.get(c.split("/").pop()));
}

/** Opens the Build page on the build given, and clicks Roll back with the plan and outcome given: what the confirm asked, and the toast. */
async function rollbackOnPage(b, base, routes, rec, plan, done) {
  routes[`GET /api/build/${T}`] = () => ({ items: [routes.shown ?? rec] });
  routes.shown = rec;
  routes[`POST /api/build/${T}/${rec.id}/rollback`] = (body) => (body.dryRun ? plan : ((routes.shown = done), done));
  await b.open(`${base}/build.html?tenant=${T}`, 1440, "[data-rollback]");
  await b.evaluate(WATCH);
  await b.evaluate(click("[data-rollback]"));
  await waitFor(b, `document.querySelectorAll(".toast").length > 0`, "the rollback's toast");
  assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
  return { asked: await b.evaluate("window.__confirms"), toast: await b.evaluate(TOAST) };
}

// ---------- item 1: the rollback's confirm, in the order the rollback deletes ----------

/** The Build page's routes for a design, with no targets; the builds list is set per case. */
const pageRoutes = (design) => ({
  [`GET /api/design/${T}`]: { design, genAi: {} },
  [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
});

test("Build: the rollback's confirm lists what it deletes in the order it deletes it", { skip: skipBrowser, timeout: 120_000 }, async () => {
  // A full build: two site lists, the profile, the pilot policy.
  const full = await setup("full");
  const built = await execute(full.dataDir, full.ctx, full.pilot, TOOL);
  assert.equal(built.status, "built", JSON.stringify(built.steps));
  const [listA, listB, profile, policy] = built.steps;
  assert.deepEqual(built.steps.map((s) => s.kind), ["site-list", "site-list", "profile", "policy"]);
  const plan = await rollback(full.dataDir, full.ctx, built.id, { dryRun: true });
  const from = full.tenant.calls.length;
  const done = await rollback(full.dataDir, full.ctx, built.id, { dryRun: false });
  assert.equal(done.status, "rolled-back");
  const deletes = deletesOf(full.tenant, built, from);
  assert.deepEqual(deletes, [`policy "${policy.name}"`, `profile "${profile.name}"`, `site list "${listB.name}"`, `site list "${listA.name}"`]);

  const routes = pageRoutes(full.design);
  const { server: srv, base } = await server(routes);
  let b;
  try {
    b = await openBrowser();
    const { asked } = await rollbackOnPage(b, base, routes, built, plan, done);
    assert.deepEqual(asked, [`Roll back: delete ${deletes.join(", ")} in that order?`]);
  } finally {
    srv.close();
    await b?.close();
  }
});

test("Build: with a step to look for by name, the confirm still lists what it deletes in the order it deletes it", { skip: skipBrowser, timeout: 120_000 }, async () => {
  // Stopped while the profile was in flight: the lists have ids, and the profile is looked for by name.
  const part = await setup("part");
  const rec = await stopped(part, PROFILES);
  assert.deepEqual(rec.steps.map((s) => s.status), ["created", "created", "unconfirmed", "planned"]);
  const plan = await rollback(part.dataDir, part.ctx, rec.id, { dryRun: true });
  const done = await rollback(part.dataDir, part.ctx, rec.id, { dryRun: false });
  assert.equal(done.status, "rolled-back", JSON.stringify(done.rollback.steps));

  const routes = pageRoutes(part.design);
  const { server: srv, base } = await server(routes);
  let b;
  try {
    b = await openBrowser();
    const { asked } = await rollbackOnPage(b, base, routes, rec, plan, done);
    const [listA, listB, profile] = rec.steps;
    assert.deepEqual(asked, [`Roll back: delete site list "${listB.name}", site list "${listA.name}" in that order, and look for profile "${profile.name}" by name, which Sophos didn't confirm was made, and delete it if there?`]);
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2: a step in flight when the server stopped ----------

test("Build: a step in flight when the server stopped shows Not confirmed, amber, with the same note as other unconfirmed steps; a rollback finds it by name", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const s = await setup("flight");
  const rec = await stopped(s, LISTS);
  // A create Sophos answered 500, with the site lists unread after: the note to match.
  const u = await setup("unread");
  const w = afterWrite(u.tenant);
  u.tenant.unclear("POST", LISTS);
  u.tenant.refuse("GET", LISTS, 503, w);
  const unread = await execute(u.dataDir, u.ctx, u.pilot, TOOL);
  u.tenant.rules.length = 0;
  assert.deepEqual(unread.steps.map((x) => x.status), ["unconfirmed", "planned", "planned", "planned"]);
  const plan = await rollback(s.dataDir, s.ctx, rec.id, { dryRun: true });
  const done = await rollback(s.dataDir, s.ctx, rec.id, { dryRun: false });
  assert.equal(done.status, "rolled-back", JSON.stringify(done.rollback.steps));

  const routes = pageRoutes(s.design);
  const { server: srv, base } = await server(routes);
  let b;
  try {
    b = await openBrowser();
    const stepsOf = async (shown) => {
      routes[`GET /api/build/${T}`] = { items: [shown] };
      await b.open(`${base}/build.html?tenant=${T}`, 1440, ".steps-list");
      return b.evaluate(STEPS);
    };
    const NOT_SENT = { tag: ["Not sent", "tag-muted"], note: null, detail: null };
    const [other] = await stepsOf(unread);
    const steps = await stepsOf(rec);
    assert.deepEqual(steps, [{ tag: ["Not confirmed", "tag-warn"], note: other.note, detail: "Detail: The tool stopped before it saved what Sophos answered. Read back: none was saved." }, NOT_SENT, NOT_SENT, NOT_SENT]);
    assert.equal(other.note, "Sophos didn't say it was made, and the read-back didn't confirm it. The next build looks for it by name first and uses it if it's there.");
    const r = await rollbackOnPage(b, base, routes, rec, plan, done);
    assert.deepEqual(r.asked, [`Roll back: look for site list "${rec.steps[0].name}" by name, which Sophos didn't confirm was made, and delete it if there?`]);
    assert.equal(r.toast, `Rolled back. The site list "${rec.steps[0].name}", which Sophos didn't confirm was made, was found by name and deleted.`);
    assert.deepEqual((await b.evaluate(STEPS)).map((x) => x.tag), [["Rolled back", "tag-muted"], NOT_SENT.tag, NOT_SENT.tag, NOT_SENT.tag]);
  } finally {
    srv.close();
    await b?.close();
  }
});
