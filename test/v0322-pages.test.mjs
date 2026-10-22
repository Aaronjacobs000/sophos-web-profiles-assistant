// v0.3.22, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant: a wave, a wave undo,
// an Allow, an Allow undo and a retire that Sophos answered with a 5xx, and
// that no read-back could read after, aren't called accepted in their toast
// or row, and say what Sophos said on the Detail line; ones Sophos accepted
// still are; the pilot switch never says accepted after a 5xx; and an Allow
// undo whose list delete isn't confirmed shows on the Build page as not
// confirmed (amber), not as a failed delete (red).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { getBuild } from "../backend/dist/services/build-service.js";
import { activePilot, addAllow, loadPilotRecord, readPilotPolicy, undoAllow } from "../backend/dist/services/pilot-service.js";
import { moveWave, promotionView, setPilotEnabled, undoWave } from "../backend/dist/services/promote-service.js";
import { retire, retireOverview } from "../backend/dist/services/retire-service.js";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";
import { device } from "./fixtures.mjs";

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.22", readOnly: false };
const now = new Date().toISOString();
/** What a page's Detail line says for a write Sophos answered 500 that no read-back could read after. */
const SAID = `Detail: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`;

/** The frontend with an API whose routes answer as set: a body, a function of the request body, or { status, body }. */
async function server(routes) {
  const app = express();
  app.use(express.json());
  app.all("/api/*", async (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(status);
    const route = routes[key];
    if (route === undefined) return res.status(404).json({ error: "not_found" });
    const out = typeof route === "function" ? await route(req.body ?? {}) : route;
    if (out?.status && out.body) return res.status(out.status).json(out.body);
    res.json(out);
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}` };
}

const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__unhandled.push(String(e.message))); window.confirm = () => true; true`;
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

async function toastAfter(b, url, ready, steps) {
  await b.open(url, 1440, ready);
  await b.evaluate(WATCH);
  for (const s of steps) {
    if (typeof s === "string") await b.evaluate(s);
    else await waitFor(b, s.until, s.until);
  }
  const t = await waitFor(b, TOAST, "a toast");
  assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
  return t;
}

/** Each row of a card: its tag's text and class, its plain note and its Detail line. */
const ROWS = (card, sel) => `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === ${JSON.stringify(card)});
  return [...c.querySelectorAll(${JSON.stringify(sel)})].map((r) => {
    const t = r.querySelector(".tag");
    return [t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null, r.querySelector(".err-note, .o-note")?.textContent.trim() ?? null, r.querySelector("[data-error-detail], [data-allow-detail]")?.textContent.trim() ?? null];
  });
})()`;

/** Matching writes answered 500, and the reads matching read refused (503) from the next write on, until off(). */
function unanswered(tenant, method, write, read) {
  let on = true;
  const w = afterWrite(tenant);
  tenant.unclear(method, write, () => on);
  tenant.refuse("GET", read, 503, () => on && w());
  return () => (on = false);
}

/** Only the read refused (503) from the next write on: Sophos accepted the write. */
function unread(tenant, read) {
  let on = true;
  const w = afterWrite(tenant);
  tenant.refuse("GET", read, 503, () => on && w());
  return () => (on = false);
}

// ---------- item 1: Promote ----------

test("Promote: a wave move or undo Sophos didn't answer with a success isn't called accepted, in its toast or its row; the pilot switch never is", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0322-pages-wave");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  // A device left for the next wave.
  tenant.endpoints.push(device("w4", "windows", "2026.2.2.1.0"));
  const ctx = ctxOf(tenant);
  const POLICY = new RegExp(`/policies/${policyId}$`);
  let off = unread(tenant, POLICY);
  const accepted = await moveWave(dataDir, ctx, ["w2"], false);
  off();
  off = unanswered(tenant, "PATCH", POLICY, POLICY);
  const moved = await moveWave(dataDir, ctx, ["w3"], false);
  off();
  off = unanswered(tenant, "PATCH", POLICY, POLICY);
  const undo = await undoWave(dataDir, ctx, moved.id);
  off();
  let answer = moved;
  const view = await promotionView(dataDir, ctx, null);
  // The pilot switch (off in the view): a 5xx is refused, as the route refuses it.
  tenant.unclear("PATCH", POLICY);
  const switchError = await setPilotEnabled(dataDir, ctx, true).then(() => null, (err) => err.message);
  tenant.rules.length = 0;
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: view,
    [`GET /api/retire/${T}`]: { tags: [], records: [] },
    [`POST /api/promote/${T}/wave`]: (body) => (body.dryRun ? { problems: [], policyName: "WF pilot: Example profile", before: { endpoints: ["w1"], endpointGroups: [] }, after: { endpoints: ["w1", "w3"], endpointGroups: [] }, devices: [{ id: "w3", hostname: "W3" }], enabled: false } : answer),
    [`POST /api/promote/${T}/wave/${moved.id}/undo`]: undo,
    [`POST /api/promote/${T}/enabled`]: { status: 400, body: { error: "failed", message: switchError } },
  });
  let b;
  try {
    b = await openBrowser();
    // Undo-failed after the 500 (moved), then accepted and not read back.
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".wave-list [data-undo-wave]");
    assert.deepEqual(await b.evaluate(ROWS("Waves moved", ".wave-list > li")), [
      [["Undo not confirmed", "tag-warn"], "Sophos didn't say the undo went through, and the read-back didn't confirm it. Undo again, or check the pilot in Sophos Fusion.", SAID],
      [["Not confirmed", "tag-warn"], "Sophos accepted the move, but the read-back didn't confirm it. Check the pilot in Sophos Fusion.", `Detail: ${UNAVAILABLE}.`],
    ]);
    const move = () => toastAfter(b, `${base}/promote.html?tenant=${T}`, "[data-wave]", [click("[data-wave]")]);
    assert.deepEqual(await move(), { kind: "toast-warn", text: "Sophos didn't say the move of wave 1 went through, and the read-back didn't confirm it.", detail: SAID });
    answer = accepted;
    assert.deepEqual(await move(), { kind: "toast-warn", text: "Sophos accepted wave 1, but the read-back didn't confirm the move.", detail: `Detail: ${UNAVAILABLE}.` });
    assert.deepEqual(await toastAfter(b, `${base}/promote.html?tenant=${T}`, `[data-undo-wave="${moved.id}"]`, [click(`[data-undo-wave="${moved.id}"]`)]), { kind: "toast-warn", text: "Sophos didn't say the undo went through, and the read-back didn't confirm it.", detail: SAID });
    // The wave's row before its undo, as the move left it.
    view.waves = [moved];
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".wave-list [data-undo-wave]");
    assert.deepEqual(await b.evaluate(ROWS("Waves moved", ".wave-list > li")), [[["Not confirmed", "tag-warn"], "Sophos didn't say the move went through, and the read-back didn't confirm it. Check the pilot in Sophos Fusion.", `Detail: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`]]);
    const toggled = await toastAfter(b, `${base}/promote.html?tenant=${T}`, "#toggle", [click("#toggle")]);
    assert.equal(toggled.kind, "toast-err");
    assert.equal(toggled.text, "Couldn't turn the pilot on.");
    assert.doesNotMatch(`${toggled.text} ${toggled.detail}`, /accepted/i);
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 1: Pilot ----------

test("Pilot: an Allow or its undo Sophos didn't answer with a success isn't called accepted, in its toast or its row", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0322-pages-allow");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const SITES = /\/site-lists\/[^/]+\/sites$/;
  await addAllow(dataDir, ctx, "chat.example.org");
  let off = unanswered(tenant, "POST", SITES, SITES);
  const { entry } = await addAllow(dataDir, ctx, "app.example.com");
  off();
  off = unanswered(tenant, "DELETE", /\/sites\/[^/]+$/, SITES);
  const undo = await undoAllow(dataDir, ctx, entry.id);
  off();
  const pilot = await activePilot(dataDir, T);
  const { policy } = await readPilotPolicy(ctx, pilot);
  const allows = async () => (await loadPilotRecord(dataDir, T)).allows.map((a) => ({ ...a, buildStatus: "built" }));
  let view = { pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: await allows() };
  const events = ["files.example.net", "chat.example.org"].map((h, i) => ({ id: `e${i}`, type: "Event::Endpoint::WebControlViolation", name: `'https://${h}/' blocked due to category 'Chat'`, created_at: now, endpoint_id: "w1", user_id: `u${i}` }));
  const { server: srv, base } = await server({
    [`GET /api/pilot/${T}`]: () => view,
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) },
    [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun ? { plan: { host: "files.example.net", site: "files.example.net", pilot, steps: [{ op: "add-site", listId: entry.listId, listName: entry.listName, site: "files.example.net" }], problems: [], notes: [] } } : { plan: {}, entry }),
    [`POST /api/pilot/${T}/allow/${entry.id}/undo`]: undo,
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    assert.deepEqual(await b.evaluate(ROWS("Allow entries", ".order-list > li")), [
      [["Undo not confirmed", "tag-warn"], "Sophos didn't say the undo went through, and the read-back didn't confirm it. Undo again, or check the list in Sophos Fusion.", SAID],
      [["Added", "tag-ok"], null, null],
    ]);
    assert.deepEqual(await toastAfter(b, `${base}/pilot.html?tenant=${T}`, `[data-undo="${entry.id}"]`, [click(`[data-undo="${entry.id}"]`)]), { kind: "toast-warn", text: "Sophos didn't say the undo for app.example.com went through, and the read-back didn't confirm it.", detail: SAID });
    // The Allow's row before its undo, as the Allow left it, and its toast.
    view = { ...view, allows: [{ ...entry, buildStatus: "built" }] };
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    assert.deepEqual(await b.evaluate(ROWS("Allow entries", ".order-list > li")), [[["Not confirmed", "tag-warn"], "Sophos didn't say the Allow went through, and the read-back didn't confirm it.", SAID]]);
    assert.deepEqual(await toastAfter(b, `${base}/pilot.html?tenant=${T}`, `[data-allow="files.example.net"]`, [click(`[data-allow="files.example.net"]`), { until: "!!document.querySelector('#allow-go')" }, click("#allow-go")]), { kind: "toast-warn", text: "Sophos didn't say the Allow for app.example.com went through, and the read-back didn't confirm it.", detail: SAID });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 1: Retire ----------

test("Promote: a retire with a step Sophos didn't answer with a success isn't called accepted, in its toast or its row", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0322-pages-retire");
  const { tenant, pol } = await retireTenant(dataDir);
  const ctx = ctxOf(tenant);
  const POLICY = new RegExp(`/policies/${pol.id}$`);
  const off = unanswered(tenant, "PATCH", POLICY, POLICY);
  const rec = await retire(dataDir, ctx, ["old"], true, TOOL);
  off();
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: await promotionView(dataDir, ctx, null),
    [`GET /api/retire/${T}`]: await retireOverview(dataDir, ctx),
    [`POST /api/retire/${T}/plan`]: { tags: ["keep"], steps: [{ op: "delete-entry", id: "x", url: "b.example.com", tags: ["keep"] }], problems: [], warnings: [] },
    [`POST /api/retire/${T}/execute`]: rec,
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".retired-table");
    const [row] = await b.evaluate(ROWS("Retired", ".retired-table tbody tr"));
    assert.deepEqual([row[0], row[2]], [["Retire not confirmed", "tag-warn"], `Detail: Sales: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`]);
    assert.deepEqual(await toastAfter(b, `${base}/promote.html?tenant=${T}`, 'input[name="tag"]', [click('input[name="tag"]'), click("#plan-retire"), { until: "!!document.querySelector('#go-retire')" }, click("#go-retire")]), {
      kind: "toast-warn",
      text: "The retire isn't confirmed: Sophos didn't say a step went through, and the read-back didn't confirm it.",
      detail: `Detail: Sales: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`,
    });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 5: the Build page after an Allow undo ----------

test("Build: an Allow undo whose list delete isn't confirmed shows as not confirmed, not as a failed delete", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0322-pages-build");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  const LIST = new RegExp(`/site-lists/${entry.listId}$`);
  const off = unanswered(tenant, "DELETE", LIST, LIST);
  await undoAllow(dataDir, ctx, entry.id);
  off();
  let rec = await getBuild(dataDir, T, entry.buildId);
  const design = { policies: [], profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [], flags: [], diff: [], siteLists: [], categoryActions: {} }], siteLists: [], limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
  const { server: srv, base } = await server({
    [`GET /api/design/${T}`]: { design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
    [`GET /api/build/${T}`]: () => ({ items: [rec] }),
  });
  let b;
  try {
    b = await openBrowser();
    const lastStep = async () => {
      await b.open(`${base}/build.html?tenant=${T}`, 1440, ".steps-list");
      return (await b.evaluate(ROWS("Plan", ".steps-list > li"))).pop();
    };
    assert.deepEqual(await lastStep(), [["Delete not confirmed", "tag-warn"], "Sophos didn't say the delete went through, and the read-back didn't confirm it's gone. Roll back again, or check it in Sophos Fusion.", SAID]);
    // Accepted, and not read back.
    tenant.lists.set(entry.listId, { id: entry.listId, name: entry.listName, sites: [{ id: "s1", site: "chat.example.org" }] });
    [...tenant.profiles.values()][0].siteListActions.push({ id: entry.listId, action: "allow", priority: 2 });
    const off2 = unread(tenant, LIST);
    await undoAllow(dataDir, ctx, entry.id);
    off2();
    rec = await getBuild(dataDir, T, entry.buildId);
    assert.deepEqual(await lastStep(), [["Delete not confirmed", "tag-warn"], "Sophos accepted the delete, but the read-back didn't confirm it's gone. Roll back again, or check it in Sophos Fusion.", `Detail: ${UNAVAILABLE}.`]);
  } finally {
    srv.close();
    await b?.close();
  }
});
