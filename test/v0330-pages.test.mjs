// v0.3.30, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant when the server stops
// while an undo's write is in flight. On the Promote page, a wave whose Undo
// was in flight is amber Undo not confirmed, with a Detail line saying the
// tool stopped before it saved the answer, and Undo again finds the devices
// back and says so, or moves them. On the Pilot page, an Allow whose Undo was
// in flight is the same, and Undo again finds the site gone and says so. A
// build whose rollback stopped didn't finish, its delete in flight not
// confirmed; a retire whose Restore stopped didn't finish either.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { moveWave, promotionView, undoWave } from "../backend/dist/services/promote-service.js";
import { activePilot, addAllow, loadPilotRecord, readPilotPolicy, undoAllow } from "../backend/dist/services/pilot-service.js";
import { designFor, getBuild, rollback } from "../backend/dist/services/build-service.js";
import { listRecords, restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { T, TOOL, Tenant, classicTenant, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.30", readOnly: false };
const IN_FLIGHT_DETAIL = "Detail: The tool stopped before it saved what Sophos answered. Read back: none was saved.";
const now = new Date().toISOString();

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

/** Opens the page, runs the steps, and returns the toast and what each confirm asked. */
async function toastAfter(b, url, ready, steps) {
  await b.open(url, 1440, ready);
  await b.evaluate(WATCH);
  for (const s of steps) await b.evaluate(s);
  const t = await waitFor(b, TOAST, "a toast");
  assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
  return { toast: t, confirms: await b.evaluate("window.__confirms") };
}

/** Each row of a card: its tag's text and class, its plain note, its Detail line, a retire's steps and its buttons. */
const ROWS = (card, sel) => `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === ${JSON.stringify(card)});
  return [...c.querySelectorAll(${JSON.stringify(sel)})].map((r) => {
    const t = r.querySelector(".tag");
    return {
      tag: t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null,
      note: r.querySelector(".err-note, .o-note")?.textContent.trim() ?? null,
      detail: r.querySelector("[data-error-detail], [data-allow-detail]")?.textContent.trim() ?? null,
      steps: r.querySelector(".r-steps")?.firstChild?.textContent.trim() ?? null,
      buttons: [...r.querySelectorAll("button")].map((x) => x.textContent.trim()),
    };
  });
})()`;

/** The first write of method that matches is made (or not) and never answered, as when the server stops while it's in flight. Resolves once it's held. */
function hold(tenant, method, pattern, made = true) {
  let held;
  const holding = new Promise((resolve) => (held = resolve));
  const real = tenant.tenantRequest.bind(tenant);
  let on = true;
  tenant.tenantRequest = async (tenantId, p, o = {}) => {
    if (!on || (o.method ?? "GET") !== method || !pattern.test(p)) return real(tenantId, p, o);
    on = false;
    if (made) await real(tenantId, p, o);
    held();
    return new Promise(() => {});
  };
  return holding;
}

// ---------- item 1: a wave's Undo ----------

/** w2 moved onto the pilot, and its Undo stopped while the change was in flight (made by Sophos or not): the page as read, then Undo again. */
async function stoppedWaveUndo(made) {
  const dataDir = await dataDirFor(`v0330-pages-wave-${made}`);
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const wave = await moveWave(dataDir, ctx, ["w2"], false);
  const holding = hold(tenant, "PATCH", /\/policies\/[^/]+$/, made);
  void undoWave(dataDir, ctx, wave.id);
  await holding;
  const view = await promotionView(dataDir, ctx, null);
  return { view, undone: await undoWave(dataDir, ctx, wave.id) };
}

test("Promote: a wave whose Undo was in flight when the server stopped is amber Undo not confirmed, and Undo again finds the devices back and says so, or moves them", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const made = await stoppedWaveUndo(true);
  const unmade = await stoppedWaveUndo(false);
  let shown = made;
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: () => shown.view,
    [`GET /api/retire/${T}`]: { tags: [], records: [] },
    [`POST /api/promote/${T}/wave/${made.view.waves[0].id}/undo`]: made.undone,
    [`POST /api/promote/${T}/wave/${unmade.view.waves[0].id}/undo`]: unmade.undone,
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".wave-list [data-undo-wave]");
    const [r] = await b.evaluate(ROWS("Waves moved", ".wave-list > li"));
    assert.deepEqual(r, {
      tag: ["Undo not confirmed", "tag-warn"],
      note: "Sophos didn't say the undo went through, and the read-back didn't confirm it. Undo again, or check the pilot in Sophos Fusion.",
      detail: IN_FLIGHT_DETAIL,
      steps: null,
      buttons: ["Undo"],
    });
    const toasts = [];
    for (const s of [made, unmade]) {
      shown = s;
      const u = await toastAfter(b, `${base}/promote.html?tenant=${T}`, "[data-undo-wave]", [click("[data-undo-wave]")]);
      assert.deepEqual(u.confirms, ["Put the pilot's assignment back as it was before this wave?"]);
      toasts.push(u.toast);
    }
    assert.deepEqual(toasts, [
      { kind: "toast-ok", text: "Nothing to undo: the pilot read back with its assignment as it was before this wave.", detail: null },
      { kind: "toast-ok", text: "Wave undone and read back.", detail: null },
    ]);
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2: an Allow's Undo ----------

/** Two Allows on the pilot allows list, and the Undo of the second stopped while its site's removal was in flight: the page as read, then Undo again. */
async function stoppedAllowUndo() {
  const dataDir = await dataDirFor("v0330-pages-allow");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  await addAllow(dataDir, ctx, "chat.example.org");
  const { entry } = await addAllow(dataDir, ctx, "video.example.net");
  const holding = hold(tenant, "DELETE", /\/site-lists\/[^/]+\/sites\/[^/]+$/);
  void undoAllow(dataDir, ctx, entry.id);
  await holding;
  const pilot = await activePilot(dataDir, T);
  const page = { pilot, policy: (await readPilotPolicy(ctx, pilot)).policy, allows: (await loadPilotRecord(dataDir, T)).allows };
  return { entry, page, undone: await undoAllow(dataDir, ctx, entry.id) };
}

test("Pilot: an Allow whose Undo was in flight when the server stopped is amber Undo not confirmed, and Undo again finds the site gone and says so", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const s = await stoppedAllowUndo();
  const { server: srv, base } = await server({
    [`GET /api/pilot/${T}`]: () => ({ pilot: s.page.pilot, policy: s.page.policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: s.page.allows.map((a) => ({ ...a, buildStatus: "built" })) }),
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([]) },
    [`POST /api/pilot/${T}/allow/${s.entry.id}/undo`]: s.undone,
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, `[data-undo="${s.entry.id}"]`);
    const rows = await b.evaluate(ROWS("Allow entries", ".order-list > li"));
    assert.deepEqual(rows.map((r) => [r.tag, r.note, r.detail, r.buttons]), [
      [["Undo not confirmed", "tag-warn"], "Sophos didn't say the undo went through, and the read-back didn't confirm it. Undo again, or check the list in Sophos Fusion.", IN_FLIGHT_DETAIL, ["Undo"]],
      [["Added", "tag-ok"], null, null, ["Undo"]],
    ]);
    const u = await toastAfter(b, `${base}/pilot.html?tenant=${T}`, `[data-undo="${s.entry.id}"]`, [click(`[data-undo="${s.entry.id}"]`)]);
    assert.deepEqual(u.confirms, ["Undo the Allow for video.example.net?"]);
    assert.deepEqual(u.toast, { kind: "toast-ok", text: "Undone. Site removed, confirmed on read-back.", detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- other undo paths: a rollback and a Restore ----------

const STEPS = `[...document.querySelectorAll(".steps-list > li")].map((r) => { const t = r.querySelector(".tag"); return { tag: t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null, note: r.querySelector(".err-note")?.textContent.trim() ?? null, detail: r.querySelector("[data-error-detail]")?.textContent.trim() ?? null }; })`;

test("Build: a rollback stopped while a delete was in flight didn't finish, with that delete not confirmed, and Roll back finishes it", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const dataDir = await dataDirFor("v0330-pages-rollback");
  const tenant = new Tenant();
  const { build } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const holding = hold(tenant, "DELETE", /\/profiles\/[^/]+$/);
  void rollback(dataDir, ctx, build.id, { dryRun: false });
  await holding;
  const stopped = await getBuild(dataDir, T, build.id);
  const plan = await rollback(dataDir, ctx, build.id, { dryRun: true });
  const done = await rollback(dataDir, ctx, build.id, { dryRun: false });
  const forForm = await dataDirFor("v0330-pages-design");
  const { design } = await designFor(forForm, ctxOf(classicTenant()));
  let shown = stopped;
  const { server: srv, base } = await server({
    [`GET /api/design/${T}`]: { design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
    [`GET /api/build/${T}`]: () => ({ items: [shown] }),
    [`POST /api/build/${T}/${build.id}/rollback`]: (body) => (body.dryRun ? plan : ((shown = done), done)),
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/build.html?tenant=${T}`, 1440, "[data-rollback]");
    assert.equal(await b.evaluate(`document.querySelector("h1").textContent.trim()`), "Rollback didn't finish");
    assert.deepEqual(await b.evaluate(STEPS), [
      { tag: ["Created", "tag-ok"], note: null, detail: null },
      { tag: ["Delete not confirmed", "tag-warn"], note: "Sophos didn't say the delete went through, and the read-back didn't confirm it's gone. Roll back again, or check it in Sophos Fusion.", detail: IN_FLIGHT_DETAIL },
      { tag: ["Rolled back", "tag-muted"], note: null, detail: null },
    ]);
    await b.evaluate(WATCH);
    await b.evaluate(click("[data-rollback]"));
    const t = await waitFor(b, TOAST, "the rollback's toast");
    assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
    assert.deepEqual(t, { kind: "toast-ok", text: "Rolled back.", detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});

test("Promote: a Restore stopped while a write was in flight didn't finish, with that step not confirmed, and Restore finishes it", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const dataDir = await dataDirFor("v0330-pages-restore");
  const { tenant } = await retireTenant(dataDir);
  const ctx = ctxOf(tenant);
  const rec = await retire(dataDir, ctx, ["old"], true, TOOL);
  const holding = hold(tenant, "POST", /\/local-sites$/);
  void restoreRetire(dataDir, ctx, rec.id);
  await holding;
  const [stopped] = await listRecords(dataDir, T);
  const restored = await restoreRetire(dataDir, ctx, rec.id);
  let shown = stopped;
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: { pilot: null, policy: null, mode: "none", plan: null, waves: [], waveSize: 25 },
    [`GET /api/retire/${T}`]: () => ({ tags: [], records: [shown] }),
    [`POST /api/retire/${T}/${rec.id}/restore`]: () => ((shown = restored), restored),
  });
  let b;
  try {
    b = await openBrowser();
    const row = async () => {
      await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".retired-table");
      return (await b.evaluate(ROWS("Retired", ".retired-table tbody tr")))[0];
    };
    assert.deepEqual(await row(), {
      tag: ["Restore didn't finish", "tag-warn"],
      note: null,
      detail: `Detail: a.example.com: ${IN_FLIGHT_DETAIL.replace(/^Detail: /, "")}`,
      steps: "Sales: done (tags match); a.example.com: restore not confirmed (not read); b.example.com: done (tags match)",
      buttons: ["Restore", "Compare with snapshot"],
    });
    const r = await toastAfter(b, `${base}/promote.html?tenant=${T}`, "[data-restore]", [click("[data-restore]")]);
    assert.deepEqual(r.toast, { kind: "toast-ok", text: "Restored.", detail: null });
    const after = await row();
    assert.deepEqual([after.tag, after.steps], [["Restored", "tag-muted"], "Sales: restored (tags match); a.example.com: restored (already there); b.example.com: restored (tags match)"]);
  } finally {
    srv.close();
    await b?.close();
  }
});
