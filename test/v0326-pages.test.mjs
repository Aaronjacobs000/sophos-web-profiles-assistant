// v0.3.26, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant. A step a build
// stopped before was never sent: the Build page shows it Not sent, muted,
// before and after a rollback, and a dry run still shows Dry run OK. The
// rollback's confirm says there's nothing to delete when no step has an id
// or is looked for by name, and writes "site list", not "site-list".

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, dryRun, execute, rollback } from "../backend/dist/services/build-service.js";
import { T, TOOL, afterWrite, classicTenant, ctxOf, dataDirFor } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.26", readOnly: false };
const LISTS = /\/site-lists$/;
const PROFILES = /\/profiles$/;
const LOCAL = /\/local-sites$/;

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

/** Each step on the Plan card: its tag's text and class. */
const TAGS = `[...document.querySelectorAll(".steps-list > li")].map((r) => { const t = r.querySelector(".tag"); return t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null; })`;

/** Creates of site lists are made, then answered 500, with the site lists unread after: not confirmed. */
function unreadCreate(tenant) {
  let on = true;
  const w = afterWrite(tenant);
  tenant.unclear("POST", LISTS, () => on);
  tenant.refuse("GET", LISTS, 503, () => on && w());
  return () => (on = false);
}

/** A build of the classic tenant's profile, with what's set to happen to it first. */
async function built(name, setUp) {
  const dataDir = await dataDirFor(`v0326-pages-${name}`);
  const tenant = classicTenant();
  const ctx = ctxOf(tenant);
  const { design } = await designFor(dataDir, ctx);
  const pilot = { profileKey: design.profiles.find((p) => p.siteLists.length).key, enabled: false, targets: { endpoints: ["w1"] } };
  const off = setUp(tenant);
  const rec = await execute(dataDir, ctx, pilot, TOOL);
  off();
  return { dataDir, tenant, ctx, design, pilot, rec };
}

// ---------- item 1: steps a stopped build never sent ----------

test("Build: a step the build stopped before shows Not sent, before and after a rollback, and a dry run still shows Dry run OK", { skip: skipBrowser, timeout: 120_000 }, async () => {
  // The profile refused: the site list was made, the policy never sent. Then a rollback that deletes the list.
  const refused = await built("refused", (tenant) => {
    tenant.refuse("POST", PROFILES, 403);
    return () => (tenant.rules.length = 0);
  });
  assert.deepEqual(refused.rec.steps.map((s) => s.status), ["created", "failed", "planned"]);
  const refusedBack = await rollback(refused.dataDir, refused.ctx, refused.rec.id, { dryRun: false });
  assert.deepEqual([refusedBack.status, refusedBack.steps.map((s) => s.status)], ["rolled-back", ["deleted", "failed", "planned"]]);
  // The site list not confirmed: the profile and policy never sent. Then a rollback that can't look for the list by name.
  const unread = await built("unread", unreadCreate);
  assert.deepEqual(unread.rec.steps.map((s) => s.status), ["unconfirmed", "planned", "planned"]);
  unread.tenant.refuse("GET", LISTS, 503);
  const unreadBack = await rollback(unread.dataDir, unread.ctx, unread.rec.id, { dryRun: false });
  unread.tenant.rules.length = 0;
  assert.deepEqual([unreadBack.status, unreadBack.steps.map((s) => s.status)], ["rollback-partial", ["unconfirmed", "planned", "planned"]]);
  // A dry run is only planned.
  const dry = await dryRun(refused.dataDir, refused.ctx, refused.pilot);
  assert.equal(dry.status, "dry-run");

  let shown;
  const routes = {
    [`GET /api/design/${T}`]: { design: refused.design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
    [`GET /api/build/${T}`]: () => ({ items: [shown] }),
    [`POST /api/build/${T}/dry-run`]: () => dry,
  };
  const { server: srv, base } = await server(routes);
  let b;
  try {
    b = await openBrowser();
    const tags = async (rec) => {
      shown = rec;
      await b.open(`${base}/build.html?tenant=${T}`, 1440, ".steps-list");
      return b.evaluate(TAGS);
    };
    const NOT_SENT = ["Not sent", "tag-muted"];
    assert.deepEqual(await tags(refused.rec), [["Created", "tag-ok"], ["Failed", "tag-bad"], NOT_SENT]);
    assert.deepEqual(await tags(refusedBack), [["Rolled back", "tag-muted"], ["Failed", "tag-bad"], NOT_SENT]);
    assert.deepEqual(await tags(unread.rec), [["Not confirmed", "tag-warn"], NOT_SENT, NOT_SENT]);
    assert.deepEqual(await tags(unreadBack), [["Not confirmed", "tag-warn"], NOT_SENT, NOT_SENT]);
    // The page's own dry run, on top of a stopped build: every step is only planned.
    await tags(refusedBack);
    await b.evaluate(click("#dry"));
    await waitFor(b, `!document.querySelector("#go").disabled`, "the dry run");
    assert.deepEqual(await b.evaluate(TAGS), [["Dry run OK", "tag-muted"], ["Dry run OK", "tag-muted"], ["Dry run OK", "tag-muted"]]);
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2: the rollback's confirm ----------

test("Build: the rollback's confirm says there's nothing to delete when nothing has an id, and writes site list", { skip: skipBrowser, timeout: 120_000 }, async () => {
  // Built, then the tenant's Website Management entry deleted, so a rollback puts it back. That create refused (403):
  // every object is deleted, but the rollback didn't finish, and the entry is still to put back.
  const wm = await built("wm", () => () => {});
  wm.tenant.localSites.clear();
  const first = await rollback(wm.dataDir, wm.ctx, wm.rec.id, { dryRun: true });
  wm.tenant.refuse("POST", LOCAL, 403);
  const wmBack = await rollback(wm.dataDir, wm.ctx, wm.rec.id, { dryRun: false });
  wm.tenant.rules.length = 0;
  assert.deepEqual([wmBack.status, wmBack.steps.map((s) => s.status)], ["rollback-partial", ["deleted", "deleted", "deleted"]]);
  const wmPlan = await rollback(wm.dataDir, wm.ctx, wm.rec.id, { dryRun: true });
  assert.equal(wmPlan.restorePlan.length, 1);
  const wmDone = await rollback(wm.dataDir, wm.ctx, wm.rec.id, { dryRun: false });
  // The same, but that create made and answered 500, with Website Management unread after: not confirmed. It went
  // through, so the next rollback has nothing to delete and nothing to put back.
  const none = await built("none", () => () => {});
  none.tenant.localSites.clear();
  const made = () => none.tenant.calls.some((c) => c.startsWith("POST /endpoint/v1/settings/web-control/local-sites"));
  none.tenant.unclear("POST", LOCAL);
  none.tenant.refuse("GET", LOCAL, 503, made);
  const noneBack = await rollback(none.dataDir, none.ctx, none.rec.id, { dryRun: false });
  none.tenant.rules.length = 0;
  assert.deepEqual([noneBack.status, noneBack.steps.map((s) => s.status)], ["rollback-partial", ["deleted", "deleted", "deleted"]]);
  const nonePlan = await rollback(none.dataDir, none.ctx, none.rec.id, { dryRun: true });
  assert.equal(nonePlan.restorePlan.length, 0);
  const noneDone = await rollback(none.dataDir, none.ctx, none.rec.id, { dryRun: false });
  // A build whose site list Sophos didn't confirm: the rollback looks for it by name.
  const asked = await built("asked", unreadCreate);
  const askedPlan = await rollback(asked.dataDir, asked.ctx, asked.rec.id, { dryRun: true });
  const askedDone = await rollback(asked.dataDir, asked.ctx, asked.rec.id, { dryRun: false });

  let c;
  let shown;
  const routes = {
    [`GET /api/design/${T}`]: { design: wm.design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
    [`GET /api/build/${T}`]: () => ({ items: [shown] }),
  };
  const { server: srv, base } = await server(routes);
  let b;
  try {
    b = await openBrowser();
    /** Clicks Roll back on the build as shown, with the plan and outcome given: what the confirm asked. */
    const ask = async (rec, plan, done) => {
      shown = rec;
      c = { plan, done };
      routes[`POST /api/build/${T}/${rec.id}/rollback`] = (body) => (body.dryRun ? c.plan : ((shown = c.done), c.done));
      await b.open(`${base}/build.html?tenant=${T}`, 1440, "[data-rollback]");
      await b.evaluate(WATCH);
      await b.evaluate(click("[data-rollback]"));
      await waitFor(b, `document.querySelectorAll(".toast").length > 0`, "the rollback's toast");
      assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
      return b.evaluate("window.__confirms");
    };
    const [firstAsked] = await ask(wm.rec, first, wmBack);
    assert.match(firstAsked, /^Roll back: delete /);
    for (const s of wm.rec.steps) assert.ok(firstAsked.includes(`${s.kind === "site-list" ? "site list" : s.kind} "${s.name}"`), `${s.kind} "${s.name}" in: ${firstAsked}`);
    assert.doesNotMatch(firstAsked, /site-list/);
    assert.deepEqual(await ask(wmBack, wmPlan, wmDone), ["Roll back: there's nothing to delete. Put back 1 Website Management change from the snapshot?"]);
    assert.deepEqual(await ask(noneBack, nonePlan, noneDone), ["There's nothing to delete and no Website Management changes to put back. Roll back anyway?"]);
    assert.deepEqual(await ask(asked.rec, askedPlan, askedDone), [`Roll back: look for site list "${asked.rec.steps[0].name}" by name, which Sophos didn't confirm was made, and delete it if there?`]);
  } finally {
    srv.close();
    await b?.close();
  }
});
