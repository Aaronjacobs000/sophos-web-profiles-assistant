// v0.3.28, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant when the server stops
// while a create is in flight. On the Pilot page, an Allow whose new list was
// in flight shows Not confirmed, amber, with the same note as a create Sophos
// answered with a 5xx that couldn't be looked for, and a Detail line saying
// the tool stopped before it saved the answer; Undo and Allow it again find
// the list by name. On the Clean up page, Undo last lists deletes the lists on
// record and finds the one in flight by name, and the next create uses a list
// in flight it finds, and says so.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { createLists, lastListsRecord, planLists, undoLists } from "../backend/dist/services/lists-service.js";
import { activePilot, addAllow, loadPilotRecord, planAllow, readPilotPolicy, undoAllow } from "../backend/dist/services/pilot-service.js";
import { T, Tenant, afterWrite, ctxOf, dataDirFor, seedPilot } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.28", readOnly: false };
const now = new Date().toISOString();
const LISTS = /\/site-lists$/;
const IN_FLIGHT_DETAIL = "Detail: The tool stopped before it saved what Sophos answered. Read back: none was saved.";

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
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
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

/** Opens the page, runs the steps (a script, or { until }), and returns the toast and what each confirm asked. */
async function toastAfter(b, url, ready, steps) {
  await b.open(url, 1440, ready);
  await b.evaluate(WATCH);
  for (const s of steps) {
    if (typeof s === "string") await b.evaluate(s);
    else await waitFor(b, s.until, s.until);
  }
  const t = await waitFor(b, TOAST, "a toast");
  assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
  return { toast: t, confirms: await b.evaluate("window.__confirms") };
}

/**
 * The first write that matches is made and never answered, as when the server stops while it's in flight. Resolves
 * once it's held. Later writes go through.
 */
function holdCreate(tenant, nth = 1) {
  let held;
  const holding = new Promise((resolve) => (held = resolve));
  const real = tenant.tenantRequest.bind(tenant);
  let n = 0;
  tenant.tenantRequest = async (tenantId, p, o = {}) => {
    if ((o.method ?? "GET") !== "POST" || !LISTS.test(p) || ++n !== nth) return real(tenantId, p, o);
    await real(tenantId, p, o);
    held();
    return new Promise(() => {});
  };
  return holding;
}

// ---------- item 2: an Allow's new list ----------

/** A built pilot, and an Allow of chat.example.org stopped while its new list's create was in flight. */
async function stoppedAllow(name) {
  const dataDir = await dataDirFor(`v0328-pages-${name}`);
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const holding = holdCreate(tenant);
  void addAllow(dataDir, ctx, "chat.example.org");
  await holding;
  return { dataDir, tenant, ctx, entry: (await loadPilotRecord(dataDir, T)).allows[0] };
}

/** Each row on the Allow entries card: its tag's text and class, its note and its Detail line. */
const ALLOW_ROWS = `[...[...document.querySelectorAll(".panel-card")].find((c) => c.querySelector("h2")?.textContent === "Allow entries").querySelectorAll(".order-list > li")].map((r) => { const t = r.querySelector(".tag"); return [t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null, r.querySelector(".o-note")?.textContent.trim() ?? null, r.querySelector("[data-allow-detail]")?.textContent.trim() ?? null]; })`;

test("Pilot: an Allow whose new list was in flight when the server stopped is amber Not confirmed, with the note of a create Sophos didn't confirm; Undo and Allow it again find the list by name", { skip: skipBrowser, timeout: 120_000 }, async () => {
  /** What the Pilot page is sent for a tenant: its pilot, the pilot policy, and the Allow entries given. */
  const pageOf = async (dataDir, ctx, allows) => {
    const pilot = await activePilot(dataDir, T);
    return { pilot, policy: (await readPilotPolicy(ctx, pilot)).policy, allows };
  };
  // A create Sophos answered 500, with the site lists unread after: the note to match.
  const u = new Tenant();
  const uDir = await dataDirFor("v0328-pages-unread");
  seedPilot(u, uDir);
  const w = afterWrite(u);
  u.unclear("POST", LISTS);
  u.refuse("GET", LISTS, 503, w);
  const other = (await addAllow(uDir, ctxOf(u), "chat.example.org")).entry;
  assert.equal(other.status, "unconfirmed");
  u.rules.length = 0;
  // Stopped once for Undo, and once for Allow it again.
  const toUndo = await stoppedAllow("undo");
  const undoPage = await pageOf(toUndo.dataDir, toUndo.ctx, [toUndo.entry]);
  const undone = await undoAllow(toUndo.dataDir, toUndo.ctx, toUndo.entry.id);
  const again = await stoppedAllow("again");
  const againPage = await pageOf(again.dataDir, again.ctx, [again.entry]);
  const plan = await planAllow(again.dataDir, again.ctx, "chat.example.org");
  const second = (await addAllow(again.dataDir, again.ctx, "chat.example.org")).entry;

  let shown = await pageOf(uDir, ctxOf(u), [other]);
  const events = [{ id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://chat.example.org/' blocked due to category 'Chat'", created_at: now, endpoint_id: "w1", user_id: "u1" }];
  const { server: srv, base } = await server({
    [`GET /api/pilot/${T}`]: () => ({ pilot: shown.pilot, policy: shown.policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: shown.allows.map((a) => ({ ...a, buildStatus: "built" })) }),
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) },
    [`POST /api/pilot/${T}/allow/${toUndo.entry.id}/undo`]: undone,
    [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun ? { dryRun: true, plan } : { dryRun: false, plan, entry: second }),
  });
  let b;
  try {
    b = await openBrowser();
    const rows = async () => {
      await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
      return b.evaluate(ALLOW_ROWS);
    };
    const [[, otherNote]] = await rows();
    assert.equal(otherNote, "Sophos didn't say the Allow went through, and the read-back didn't confirm it. Allow it again or undo it: the tool looks for the list by name first.");
    shown = undoPage;
    assert.deepEqual(await rows(), [[["Not confirmed", "tag-warn"], otherNote, IN_FLIGHT_DETAIL]]);
    // Undo looks for the list by name, finds it, and deletes it.
    const u1 = await toastAfter(b, `${base}/pilot.html?tenant=${T}`, `[data-undo="${toUndo.entry.id}"]`, [click(`[data-undo="${toUndo.entry.id}"]`)]);
    assert.deepEqual(u1.confirms, ["Undo the Allow for chat.example.org? Sophos didn't confirm its list was made, so the tool looks for it by name first."]);
    assert.deepEqual(u1.toast, { kind: "toast-ok", text: "Undone. The list was found by name. List deleted, 404 on read-back.", detail: null });
    // Allow it again: the dry run says it uses the list it found, and the toast says so.
    shown = againPage;
    const a1 = await toastAfter(b, `${base}/pilot.html?tenant=${T}`, '[data-allow="chat.example.org"]', [click('[data-allow="chat.example.org"]'), { until: "!!document.querySelector('#allow-go')" }, `(() => { window.__modal = document.querySelector("#results-modal .modal-body").innerText; return true; })()`, click("#allow-go")]);
    const modal = await b.evaluate("window.__modal");
    assert.match(modal, /Use the site list "Example pilot allows" the Allow for chat\.example\.org asked for, found by name, rather than make another\./);
    assert.match(modal, /The site list "Example pilot allows" from the Allow for chat\.example\.org is in the tenant\. Sophos didn't confirm it was made, so this Allow uses it rather than making another\./);
    assert.deepEqual(a1.toast, { kind: "toast-ok", text: 'Allowed chat.example.org: list holds the site; profile links it as allow. The site list "Example pilot allows" was found by name and used, not made again.', detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 1: Create site lists ----------

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com"), result(2, "chat.example.org", "warn")];
const PREFIX = "Example cleaned";

/** Create site lists stopped while the nth list's create was in flight. */
async function stoppedLists(name, nth) {
  const dataDir = await dataDirFor(`v0328-pages-${name}`);
  const tenant = new Tenant();
  const holding = holdCreate(tenant, nth);
  void createLists(dataDir, tenant, T, T, RESULTS, PREFIX);
  await holding;
  return { dataDir, tenant };
}

test("Clean up: after a stop during Create site lists, Undo last lists deletes the list on record and finds the one in flight by name; the next create uses a list in flight it finds, and says so", { skip: skipBrowser, timeout: 120_000 }, async () => {
  // Stopped while the second list was in flight: Undo.
  const second = await stoppedLists("lists-second", 2);
  const onRecord = await lastListsRecord(second.dataDir, T);
  const undone = await undoLists(second.dataDir, second.tenant, T);
  // Stopped while the first was in flight: the next create.
  const first = await stoppedLists("lists-first", 1);
  const inFlight = await lastListsRecord(first.dataDir, T);
  const plan = await planLists(first.tenant, T, RESULTS, PREFIX, { dataDir: first.dataDir, scope: T });
  const made = await createLists(first.dataDir, first.tenant, T, T, RESULTS, PREFIX);

  let lastLists = onRecord;
  const view = () => ({ run: { scope: T, options: { dns: false, intelix: false }, intelixLookups: 0, running: false }, results: RESULTS.map((r) => ({ ...r, dns: null, lookup: null })), summary: { total: 2, covered: 0, remove: 0, exception: 2, needsDecision: 0 }, lists: [{ name: `${PREFIX} Block`, action: "block", sites: 1 }, { name: `${PREFIX} Warn`, action: "warn", sites: 1 }], leftOut: 0, lastLists, intelix: false });
  const { server: srv, base } = await server({
    [`GET /api/readiness/${T}`]: { tenant: { id: T, name: "Example Tenant", region: "us01" }, running: false, result: null },
    [`GET /api/cleanup/${T}`]: view,
    [`POST /api/cleanup/${T}/lists`]: (body) => (body.undo ? undone : body.dryRun ? plan : made),
  });
  let b;
  try {
    b = await openBrowser();
    const u = await toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#undo-lists", [`(() => { window.__undo = document.querySelector("#undo-lists").textContent.trim(); return true; })()`, click("#undo-lists")]);
    assert.equal(await b.evaluate("window.__undo"), "Undo last lists");
    assert.deepEqual(u.confirms, ["Delete the site lists the last create made? Lists a profile uses are left. A list Sophos didn't confirm was made is looked for by name first."]);
    assert.deepEqual(u.toast, { kind: "toast-ok", text: `Undone: "${PREFIX} Block" deleted and read back. "${PREFIX} Warn", which Sophos didn't confirm was made, was found by name, deleted and read back.`, detail: null });
    lastLists = inFlight;
    const c = await toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#create-lists", [click("#create-lists")]);
    assert.match(c.confirms[0], new RegExp(`\\n\\n"${PREFIX} Block" is in the tenant\\. The last create asked for it and Sophos didn't confirm it was made, so this one uses it rather than making another\\.$`));
    assert.deepEqual(c.toast, { kind: "toast-ok", text: `2 site lists created and read back. "${PREFIX} Block" was found by name and used, not made again.`, detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});
