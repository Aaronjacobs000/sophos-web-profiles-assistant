// v0.3.25, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant. A rollback of a
// build with a step Sophos didn't confirm was made says what it did with it:
// found by name and deleted, or nothing there to remove, both green; amber,
// saying to check for it, when the tenant couldn't be read to look. Never a
// plain green Rolled back. The same for Undo on an Allow whose new list wasn't
// confirmed (which now has an Undo) and for Undo last lists. And records
// v0.3.23 saved in that state are drawn amber Not confirmed, with the Roll
// back, Undo and Undo last lists that look them up by name.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, execute, getBuild, rollback } from "../backend/dist/services/build-service.js";
import { activePilot, addAllow, loadPilotRecord, readPilotPolicy, undoAllow } from "../backend/dist/services/pilot-service.js";
import { createLists, lastListsRecord, undoLists } from "../backend/dist/services/lists-service.js";
import { wcPolicy } from "./fixtures.mjs";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, classicTenant, ctxOf, dataDirFor, seedPilot } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const V0323 = JSON.parse(readFileSync(path.join(here, "fixtures", "v0323-records.json"), "utf8"));

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.25", readOnly: false };
const now = new Date().toISOString();
const LISTS = /\/site-lists$/;

/** The frontend with an API whose routes answer as set: a body, or a function of the request body. */
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
const TOAST = `(() => {
  const all = document.querySelectorAll(".toast");
  const e = all[all.length - 1];
  if (!e) return null;
  const k = e.cloneNode(true);
  const d = k.querySelector("[data-toast-detail]");
  d?.remove();
  return { kind: [...e.classList].find((c) => c.startsWith("toast-")), text: k.textContent.trim(), detail: d?.textContent ?? null };
})()`;

async function waitFor(b, expr, what) {
  for (let i = 0; i < 150; i++) {
    const v = await b.evaluate(expr);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Opens the page, runs the steps, and returns the toast and what was asked in a confirm. */
async function toastAfter(b, url, ready, steps) {
  await b.open(url, 1440, ready);
  await b.evaluate(WATCH);
  for (const s of steps) await b.evaluate(s);
  const t = await waitFor(b, TOAST, "a toast");
  assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
  return { ...t, asked: await b.evaluate("window.__confirms") };
}

/** Each row of a card: its tag's text and class, its plain note and its Detail line. */
const ROWS = (card, sel) => `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === ${JSON.stringify(card)});
  return [...c.querySelectorAll(${JSON.stringify(sel)})].map((r) => {
    const t = r.querySelector(".tag");
    return [t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null, r.querySelector(".err-note, .o-note")?.textContent.trim() ?? null, r.querySelector("[data-error-detail], [data-allow-detail]")?.textContent.trim() ?? null];
  });
})()`;

/** Creates matching write go through (or, with made false, don't), then answer 500, with the collection read after failing. */
function unreadCreate(tenant, made = true) {
  let on = true;
  const w = afterWrite(tenant);
  if (!made) tenant.ignore("POST", LISTS, () => on);
  tenant.unclear("POST", LISTS, () => on);
  tenant.refuse("GET", LISTS, 503, () => on && w());
  return () => (on = false);
}
/** Reads of the site lists fail (503) until the returned function is called. */
function unreadable(tenant) {
  let on = true;
  tenant.refuse("GET", LISTS, 503, () => on);
  return () => (on = false);
}

const pilotTargets = { endpoints: [], endpointGroups: [], userGroups: [] };
const LOOK_UNREAD = `The tool couldn't read the tenant's site lists to look for it by name (${UNAVAILABLE}), so it may be in the tenant.`;

// ---------- item 1: Build, Roll back ----------

test("Build: Roll back says what it did with a step Sophos didn't confirm, found and deleted, not there, or not looked for, and is never a plain Rolled back", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const cases = {};
  for (const [name, made, readable] of [["found", true, true], ["not-found", false, true], ["unread", true, false]]) {
    const dataDir = await dataDirFor(`v0325-pages-rollback-${name}`);
    const tenant = classicTenant();
    const ctx = ctxOf(tenant);
    const { design } = await designFor(dataDir, ctx);
    const pilot = { profileKey: design.profiles.find((p) => p.siteLists.length).key, enabled: false, targets: { endpoints: ["w1"] } };
    const off = unreadCreate(tenant, made);
    const built = await execute(dataDir, ctx, pilot, TOOL);
    off();
    const plan = await rollback(dataDir, ctx, built.id, { dryRun: true });
    const on = readable ? () => {} : unreadable(tenant);
    const done = await rollback(dataDir, ctx, built.id, { dryRun: false });
    on();
    cases[name] = { design, built, plan, done };
  }
  // The routes are read on each request, so each case sets its own.
  const routes = { [`GET /api/pilot-targets/${T}`]: pilotTargets };
  const { server: srv, base } = await server(routes);
  let b;
  try {
    b = await openBrowser();
    const name = cases.found.built.steps[0].name;
    const run = async (key) => {
      const c = cases[key];
      let shown = c.built;
      Object.assign(routes, {
        [`GET /api/design/${T}`]: { design: c.design, genAi: {} },
        [`GET /api/build/${T}`]: () => ({ items: [shown] }),
        [`POST /api/build/${T}/${c.built.id}/rollback`]: (body) => (body.dryRun ? c.plan : ((shown = c.done), c.done)),
      });
      return toastAfter(b, `${base}/build.html?tenant=${T}`, "[data-rollback]", [click("[data-rollback]")]);
    };

    const found = await run("found");
    assert.deepEqual([found.kind, found.text, found.detail], ["toast-ok", `Rolled back. The site list "${name}", which Sophos didn't confirm was made, was found by name and deleted.`, null]);
    assert.match(found.asked[0], new RegExp(`look for site-list "${name}" by name, which Sophos didn't confirm was made, and delete it if there\\?$`));
    assert.deepEqual((await b.evaluate(ROWS("Plan", ".steps-list > li")))[0], [["Rolled back", "tag-muted"], null, null]);

    const notFound = await run("not-found");
    assert.deepEqual([notFound.kind, notFound.text], ["toast-ok", `Rolled back. The site list "${name}", which Sophos didn't confirm was made, isn't in the tenant, so there was nothing to remove.`]);
    assert.deepEqual((await b.evaluate(ROWS("Plan", ".steps-list > li")))[0], [["Nothing to remove", "tag-muted"], "Sophos didn't say it was made, and the rollback found nothing by that name, so there was nothing to remove.", null]);

    const unread = await run("unread");
    assert.deepEqual([unread.kind, unread.text, unread.detail], ["toast-warn", `The rollback couldn't confirm whether the site list "${name}" is in the tenant: Sophos didn't confirm it was made, and the rollback couldn't look for it by name. Check for it in Sophos Fusion, or roll back again.`, `Detail: ${name}: ${LOOK_UNREAD}`]);
    assert.deepEqual((await b.evaluate(ROWS("Plan", ".steps-list > li")))[0], [["Not confirmed", "tag-warn"], "Sophos didn't say it was made, and the rollback couldn't look for it by name, so it may be in the tenant. Roll back again, or check for it in Sophos Fusion.", `Detail: ${UNCLEAR}. ${LOOK_UNREAD}`]);
    assert.equal(await b.evaluate(`!!document.querySelector("[data-rollback]")`), true, "it can be rolled back again");
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 1: Pilot, Undo an Allow not confirmed ----------

test("Pilot: an Allow whose new list Sophos didn't confirm has an Undo that looks for the list by name, and says what it found", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const made = {};
  for (const [name, readable] of [["found", true], ["unread", false]]) {
    const dataDir = await dataDirFor(`v0325-pages-undo-${name}`);
    const tenant = new Tenant();
    seedPilot(tenant, dataDir);
    const ctx = ctxOf(tenant);
    const off = unreadCreate(tenant);
    const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
    off();
    const pilot = await activePilot(dataDir, T);
    const { policy } = await readPilotPolicy(ctx, pilot);
    const on = readable ? () => {} : unreadable(tenant);
    const undone = await undoAllow(dataDir, ctx, entry.id);
    on();
    made[name] = { entry, undone, pilot, policy };
  }
  let c;
  let shown;
  const events = [{ id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://chat.example.org/' blocked due to category 'Chat'", created_at: now, endpoint_id: "w1", user_id: "u1" }];
  const routes = {
    [`GET /api/pilot/${T}`]: () => ({ pilot: c.pilot, policy: c.policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [{ ...(shown ?? c.entry), buildStatus: "built" }] }),
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) },
  };
  const { server: srv, base } = await server(routes);
  let b;
  try {
    b = await openBrowser();
    const undo = async (key) => {
      c = made[key];
      shown = undefined;
      routes[`POST /api/pilot/${T}/allow/${c.entry.id}/undo`] = () => ((shown = c.undone), c.undone);
      return toastAfter(b, `${base}/pilot.html?tenant=${T}`, `[data-undo="${c.entry.id}"]`, [click(`[data-undo="${c.entry.id}"]`)]);
    };
    const found = await undo("found");
    assert.deepEqual([found.kind, found.text, found.detail], ["toast-ok", "Undone. The list was found by name. List deleted, 404 on read-back.", null]);
    assert.deepEqual(found.asked, ["Undo the Allow for chat.example.org? Sophos didn't confirm its list was made, so the tool looks for it by name first."]);
    const unread = await undo("unread");
    assert.deepEqual([unread.kind, unread.text, unread.detail], ["toast-warn", "Couldn't confirm whether the list for chat.example.org is in the tenant: Sophos didn't confirm it was made, and Undo couldn't look for it by name. Check the site lists in Sophos Fusion, or undo again.", `Detail: ${UNAVAILABLE}.`]);
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    assert.deepEqual(await b.evaluate(ROWS("Allow entries", ".order-list > li")), [[["Not confirmed", "tag-warn"], "Sophos didn't say the Allow went through, and Undo couldn't look for its list by name, so it may be in the tenant. Undo again, or check the site lists in Sophos Fusion.", `Detail: ${UNCLEAR}. Looked up by name: ${UNAVAILABLE}.`]]);
    assert.equal(await b.evaluate(`!!document.querySelector("[data-undo]")`), true, "Undo again");
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 1: Clean up, Undo last lists ----------

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com")];

test("Clean up: Undo last lists is offered for a list Sophos didn't confirm, looks for it by name, and says what it found", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const made = {};
  for (const [name, readable] of [["found", true], ["unread", false]]) {
    const dataDir = await dataDirFor(`v0325-pages-lists-${name}`);
    const tenant = new Tenant();
    const off = unreadCreate(tenant);
    const created = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
    off();
    const on = readable ? () => {} : unreadable(tenant);
    const undone = await undoLists(dataDir, tenant, T);
    on();
    made[name] = { created, undone };
  }
  let c;
  let last;
  const view = () => ({ run: { scope: T, options: { dns: false, intelix: false }, intelixLookups: 0, running: false }, results: RESULTS.map((r) => ({ ...r, dns: null, lookup: null })), summary: { total: 1, covered: 0, remove: 0, exception: 1, needsDecision: 0 }, lists: [{ name: "Example cleaned Block", action: "block", sites: 1 }], leftOut: 0, lastLists: last, intelix: false });
  const { server: srv, base } = await server({
    [`GET /api/readiness/${T}`]: { tenant: { id: T, name: "Example Tenant", region: "us01" }, running: false, result: null },
    [`GET /api/cleanup/${T}`]: () => view(),
    [`POST /api/cleanup/${T}/lists`]: (body) => (body.undo ? c.undone : null),
  });
  let b;
  try {
    b = await openBrowser();
    const undo = async (key) => {
      c = made[key];
      last = c.created;
      return toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#undo-lists", [click("#undo-lists")]);
    };
    const found = await undo("found");
    assert.deepEqual([found.kind, found.text], ["toast-ok", `Undone. "Example cleaned Block", which Sophos didn't confirm was made, was found by name, deleted and read back.`]);
    assert.deepEqual(found.asked, ["Delete the site lists the last create made? Lists a profile uses are left. A list Sophos didn't confirm was made is looked for by name first."]);
    const unread = await undo("unread");
    assert.deepEqual([unread.kind, unread.text, unread.detail], ["toast-warn", `Couldn't confirm whether "Example cleaned Block" is in the tenant: Sophos didn't confirm it was made, and the undo couldn't look for it by name. Check the site lists in Sophos Fusion, or undo again.`, `Detail: "Example cleaned Block": ${UNAVAILABLE}.`]);
    // After it, the page offers Undo again and says why.
    last = c.undone;
    await b.open(`${base}/cleanup.html?tenant=${T}`, 1440, "#undo-lists");
    assert.deepEqual([await b.evaluate(`document.querySelector("#undo-lists").textContent`), await b.evaluate(`document.querySelector("[data-undo-open]").textContent`)], ["Undo again", `The last undo couldn't look for "Example cleaned Block" by name, so it may be in the tenant. Undo again to look again, or check the site lists in Sophos Fusion.`]);
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2: records v0.3.23 saved ----------

test("records v0.3.23 saved in that state are drawn amber Not confirmed, with the Roll back, Undo and Undo last lists that look them up by name", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const dataDir = await dataDirFor("v0325-pages-v0323");
  const tenant = new Tenant();
  // The v0.3.23 build, Allow (on its own pilot build) and lists record, on file as that version saved them.
  const put = (rel, rec) => {
    mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
    writeFileSync(path.join(dataDir, rel), JSON.stringify(rec));
  };
  const { snapshotFile, ...stopped } = V0323.build["unread-site-list"];
  void snapshotFile;
  put(`builds/${T}/${stopped.id}.json`, stopped);
  put(`builds/${T}/${V0323.allow.unread.build.id}.json`, V0323.allow.unread.build);
  put(`pilot/${T}.json`, V0323.allow.unread.pilot);
  put(`cleanup/${T}.lists.json`, V0323.lists.unread);
  const [list, profile, policyStep] = V0323.allow.unread.build.steps;
  tenant.lists.set(list.id, { id: list.id, name: list.name, sites: [] });
  tenant.profiles.set(profile.id, { id: profile.id, name: profile.name, filterBySiteList: true, siteListActions: [{ id: list.id, action: "block", priority: 1 }] });
  tenant.policies.set(policyStep.id, wcPolicy({ id: policyStep.id, name: policyStep.name, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: { "endpoint.web-control.web-profile-id": { value: profile.id } } }));
  const ctx = ctxOf(tenant);
  const build = await getBuild(dataDir, T, stopped.id);
  const pilot = await activePilot(dataDir, T);
  const { policy } = await readPilotPolicy(ctx, pilot);
  const allows = (await loadPilotRecord(dataDir, T)).allows;
  const lastLists = await lastListsRecord(dataDir, T);
  const design = { policies: [], profiles: [], siteLists: [], limits: { profiles: { planned: 0, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
  const { server: srv, base } = await server({
    [`GET /api/design/${T}`]: { design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: pilotTargets,
    [`GET /api/build/${T}`]: { items: [build] },
    [`GET /api/pilot/${T}`]: { pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: allows.map((a) => ({ ...a, buildStatus: "built" })) },
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([]) },
    [`GET /api/readiness/${T}`]: { tenant: { id: T, name: "Example Tenant", region: "us01" }, running: false, result: null },
    [`GET /api/cleanup/${T}`]: { run: { scope: T, options: { dns: false, intelix: false }, intelixLookups: 0, running: false }, results: [], summary: { total: 1, covered: 0, remove: 0, exception: 1, needsDecision: 0 }, lists: [{ name: "Example cleaned Block", action: "block", sites: 1 }], leftOut: 0, lastLists, intelix: false },
  });
  let b;
  try {
    b = await openBrowser();
    const SAID = `Detail: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`;
    await b.open(`${base}/build.html?tenant=${T}`, 1440, ".steps-list");
    assert.deepEqual((await b.evaluate(ROWS("Plan", ".steps-list > li")))[0], [["Not confirmed", "tag-warn"], "Sophos didn't say it was made, and the read-back didn't confirm it. The next build looks for it by name first and uses it if it's there.", SAID]);
    assert.equal(await b.evaluate(`!!document.querySelector('[data-rollback="${stopped.id}"]')`), true, "it can be rolled back");
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    assert.deepEqual(await b.evaluate(ROWS("Allow entries", ".order-list > li")), [[["Not confirmed", "tag-warn"], "Sophos didn't say the Allow went through, and the read-back didn't confirm it. Allow it again or undo it: the tool looks for the list by name first.", SAID]]);
    assert.equal(await b.evaluate(`[...document.querySelectorAll(".panel-card")].find((c) => c.querySelector("h2")?.textContent === "Allow entries").querySelector(".o-kind").textContent.startsWith("Example pilot allows")`), true, "with the list name it asked for");
    assert.equal(await b.evaluate(`!!document.querySelector('[data-undo="${allows[0].id}"]')`), true);
    await b.open(`${base}/cleanup.html?tenant=${T}`, 1440, "#create-lists");
    assert.equal(await b.evaluate(`document.querySelector("#undo-lists")?.textContent ?? null`), "Undo last lists");
  } finally {
    srv.close();
    await b?.close();
  }
});
