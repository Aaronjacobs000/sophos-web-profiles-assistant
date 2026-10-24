// v0.3.29, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant when the server stops
// while a retire step or a promotion wave is in flight. On the Promote page,
// the retire's step in flight reads as not confirmed, with a Detail line
// saying the tool stopped before it saved the answer, and Restore re-creates
// the entry it was deleting, or finds it still there and says so. The wave in
// flight is amber Not confirmed with Undo, which moves the devices back, or
// finds them not moved and sends nothing.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { listRecords, restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { moveWave, promotionView, undoWave } from "../backend/dist/services/promote-service.js";
import { T, TOOL, Tenant, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.29", readOnly: false };
const IN_FLIGHT_DETAIL = "The tool stopped before it saved what Sophos answered. Read back: none was saved.";

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
      note: r.querySelector(".err-note")?.textContent.trim() ?? null,
      detail: r.querySelector("[data-error-detail]")?.textContent.trim() ?? null,
      steps: r.querySelector(".r-steps")?.firstChild?.textContent.trim() ?? null,
      buttons: [...r.querySelectorAll("button")].map((x) => x.textContent.trim()),
    };
  });
})()`;

/**
 * The first write of method that matches is made (or not, with made false) and never answered, as when the server
 * stops while it's in flight. Resolves once it's held. Later writes go through.
 */
function hold(tenant, method, pattern, made) {
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

// ---------- item 1: a retire ----------

/** A retire of old stopped while its entry delete was in flight (made by Sophos or not): the record as read, then the restore. */
async function stoppedRetire(made) {
  const dataDir = await dataDirFor(`v0329-pages-retire-${made}`);
  const { tenant } = await retireTenant(dataDir);
  const ctx = ctxOf(tenant);
  const holding = hold(tenant, "DELETE", /\/local-sites\/[^/]+$/, made);
  void retire(dataDir, ctx, ["old"], true, TOOL);
  await holding;
  const [stopped] = await listRecords(dataDir, T);
  return { stopped, restored: await restoreRetire(dataDir, ctx, stopped.id) };
}

test("Promote: a retire step in flight when the server stopped is not confirmed, and Restore re-creates the entry, or finds it still there and says so", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const made = await stoppedRetire(true);
  const unmade = await stoppedRetire(false);
  let shown = made.stopped;
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: { pilot: null, policy: null, mode: "none", plan: null, waves: [], waveSize: 25 },
    [`GET /api/retire/${T}`]: () => ({ tags: [], records: [shown] }),
    [`POST /api/retire/${T}/${made.stopped.id}/restore`]: made.restored,
    [`POST /api/retire/${T}/${unmade.stopped.id}/restore`]: unmade.restored,
  });
  let b;
  try {
    b = await openBrowser();
    const row = async () => {
      await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".retired-table");
      return (await b.evaluate(ROWS("Retired", ".retired-table tbody tr")))[0];
    };
    assert.deepEqual(await row(), {
      tag: ["Retire didn't finish", "tag-warn"],
      note: null,
      detail: `Detail: a.example.com: ${IN_FLIGHT_DETAIL}`,
      steps: "Sales: done (tags match); a.example.com: not confirmed (not read); b.example.com: not sent",
      buttons: ["Restore", "Compare with snapshot"],
    });
    for (const [rec, back] of [[made, "re-created, matches"], [unmade, "already there"]]) {
      shown = rec.stopped;
      const r = await toastAfter(b, `${base}/promote.html?tenant=${T}`, "[data-restore]", [click("[data-restore]")]);
      assert.deepEqual(r.confirms, ["Restore: re-create and re-tag the entries, then put the tags back in each policy?"]);
      assert.deepEqual(r.toast, { kind: "toast-ok", text: "Restored.", detail: null });
      shown = rec.restored;
      const after = await row();
      assert.deepEqual([after.tag, after.steps, after.buttons], [["Restored", "tag-muted"], `Sales: restored (tags match); a.example.com: restored (${back}); b.example.com: not sent`, ["Compare with snapshot"]]);
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2: a promotion wave ----------

/** A move of w2 onto the pilot stopped while its change was in flight (made by Sophos or not): the page as read, then the undo. */
async function stoppedWave(made) {
  const dataDir = await dataDirFor(`v0329-pages-wave-${made}`);
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const holding = hold(tenant, "PATCH", /\/policies\/[^/]+$/, made);
  void moveWave(dataDir, ctx, ["w2"], false);
  await holding;
  const view = await promotionView(dataDir, ctx, null);
  return { view, undone: await undoWave(dataDir, ctx, view.waves[0].id) };
}

test("Promote: a wave in flight when the server stopped is amber Not confirmed with Undo, which moves the devices back, or finds them not moved", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const made = await stoppedWave(true);
  const unmade = await stoppedWave(false);
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
      tag: ["Not confirmed", "tag-warn"],
      note: "Sophos didn't say the move went through, and the read-back didn't confirm it. Check the pilot in Sophos Fusion.",
      detail: `Detail: ${IN_FLIGHT_DETAIL}`,
      steps: null,
      buttons: ["Undo"],
    });
    assert.equal(await b.evaluate(`[...document.querySelectorAll(".panel-card")].find((c) => c.querySelector("h2")?.textContent === "Waves moved").querySelector(".w-devs").textContent`), "W2. Read back: not read");
    const toasts = [];
    for (const s of [made, unmade]) {
      shown = s;
      const u = await toastAfter(b, `${base}/promote.html?tenant=${T}`, "[data-undo-wave]", [click("[data-undo-wave]")]);
      assert.deepEqual(u.confirms, ["Put the pilot's assignment back as it was before this wave?"]);
      toasts.push(u.toast);
    }
    assert.deepEqual(toasts, [
      { kind: "toast-ok", text: "Wave undone and read back.", detail: null },
      { kind: "toast-ok", text: "Nothing to undo: the pilot read back with its assignment as it was before this wave.", detail: null },
    ]);
  } finally {
    srv.close();
    await b?.close();
  }
});
