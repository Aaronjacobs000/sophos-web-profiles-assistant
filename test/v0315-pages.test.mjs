// v0.3.15, as drawn in a headless Chrome or Edge (skipped without one): a
// failed Collect, Import, Allow or Undo on the Pilot page says so in plain
// words in its toast with the raw detail on a separate line, the Retry in the
// Not read and Pilot devices only cards keeps what's on screen while the read
// fails, a failed save of Collect every few hours says so and leaves the box
// as saved, and toasts don't cover the top bar at phone width.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { openBrowser, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.15", readOnly: false };
const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const now = new Date().toISOString();
const ev = (n, endpoint, url, action, why) => ({ id: `e${n}`, type: "Event::Endpoint::WebControlViolation", name: `'${url}' ${action} due to ${why}`, created_at: now, endpoint_id: endpoint, user_id: `u${n}` });
const events = [
  ev(1, "w1", "https://app.example.com/login", "blocked", "category 'Social Networking'"),
  ev(2, "w1", "https://downloads.example.net/setup.exe", "warned", "filetype 'Windows Executable (exe)'"),
  ev(3, "w2", "https://chat.example.org/", "blocked", "category 'Chat'"),
];
const allow = { id: "a1", at: now, host: "chat.example.org", site: "chat.example.org", buildId: "b1", profileId: "pr1", listName: "Example pilot allows", createdList: true, status: "added", readBack: "site listed" };
const RAW = `Sophos auth failed (401): {"error":"invalid_client","error_description":"mock refuses the credential"}`;
const UNREAD = "Sophos API error 403: Forbidden";

/** The page's own width and how wide its content is, so a sideways scroll shows. */
const PAGE_WIDTH = `({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth })`;

/**
 * The frontend with an API that can fail on demand. Reads (the pilot and its
 * digest) and actions (Collect, Import, Allow, Undo and the collection setting)
 * answer "ok", or "fail": a 503 with Sophos's raw answer, as when the
 * credential stops working. collectRun and undoResult replace what a Collect
 * or an Undo that went through answers.
 */
async function server() {
  const s = { reads: "ok", actions: "ok", policyUnread: false, filterUnread: false, enabled: false, collectRun: null, undoResult: null };
  const app = express();
  app.use(express.json());
  const fail = (res) => res.status(503).json({ error: "configured-invalid", message: RAW });
  const read = (res, body) => (s.reads === "fail" ? fail(res) : res.json(body));
  const act = (res, body) => (s.actions === "fail" ? fail(res) : res.json(typeof body === "function" ? body() : body));
  const store = () => ({ days: [], total: 0, imported: 0, state: { tenantId: T, enabled: s.enabled, runs: [] } });
  app.get("/api/status", (_req, res) => res.json(status));
  app.get(`/api/readiness/${T}`, (_req, res) => res.status(404).json({ error: "not_found" }));
  app.get(`/api/pilot/${T}`, (_req, res) => read(res, { pilot, policy: s.policyUnread ? null : policy, ...(s.policyUnread ? { policyUnread: UNREAD } : {}), store: store(), allows: [allow] }));
  app.get(`/api/pilot/${T}/digest`, (req, res) => {
    const pilotOnly = req.query.pilotOnly === "1";
    read(res, { days: Number(req.query.days), since: null, pilotOnly, pilotDevices: null, imported: 0, otherWebEvents: 0, ...(pilotOnly && s.filterUnread ? { pilotUnread: UNREAD } : {}), ...summarize(events) });
  });
  app.post(`/api/pilot/${T}/collect`, (_req, res) => act(res, () => s.collectRun ?? { ok: true, added: 0, web: 0, fetched: 0 }));
  app.post(`/api/pilot/${T}/import`, (_req, res) => act(res, { added: 0 }));
  app.put(`/api/pilot/${T}/schedule`, (req, res) => act(res, () => ((s.enabled = req.body.enabled === true), store().state)));
  app.post(`/api/pilot/${T}/allow`, (req, res) =>
    act(res, req.body.dryRun === false ? { dryRun: false, entry: { site: req.body.host, readBack: "site listed" } } : { dryRun: true, plan: { pilot, host: req.body.host, site: req.body.host, steps: [{ op: "add-site", listId: "l1", listName: "Example pilot allows", site: req.body.host }], problems: [], notes: [] } }),
  );
  app.post(`/api/pilot/${T}/allow/a1/undo`, (_req, res) => act(res, () => s.undoResult ?? { ...allow, status: "undone", undo: ["Site removed, confirmed on read-back."] }));
  app.all("/api/*", (_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}`, s };
}

/** Each toast on screen: its main text and its detail line apart. */
const TOASTS = `[...document.querySelectorAll(".toast")].map((e) => {
  const k = e.cloneNode(true);
  const d = k.querySelector("[data-toast-detail]");
  d?.remove();
  return { text: k.textContent.replace(/\\s+/g, " ").trim(), detail: d?.textContent.trim() ?? null };
})`;
const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.confirm = () => true; true`;
const IMPORT = `(() => { const i = document.querySelector("#import"); const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ items: [] })], "events.json", { type: "application/json" })); i.files = dt.files; i.dispatchEvent(new Event("change")); return true; })()`;

/** Waits until n toasts show, for up to 10 s, and returns them. */
async function toasts(b, n = 1) {
  for (let i = 0; i < 100; i++) {
    const t = await b.evaluate(TOASTS);
    if (t.length >= n) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Fewer than ${n} toasts showed.`);
}

test("a failed Collect, Import, Allow or Undo on the Pilot page says so in plain words in its toast, with the raw detail on a separate line", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const { server: srv, base, s } = await server();
  // Each failure: how to set it up, what to click, and the toast it should give.
  const cases = [
    { name: "Collect, refused", fail: { actions: "fail" }, act: `document.querySelector("#collect").click(); true`, text: "Couldn't collect events.", detail: RAW },
    { name: "Collect, a failed run", fail: { collectRun: { ok: false, pages: 0, fetched: 0, web: 0, added: 0, error: UNREAD } }, act: `document.querySelector("#collect").click(); true`, text: "Couldn't collect events.", detail: UNREAD },
    { name: "Import", fail: { actions: "fail" }, act: IMPORT, text: "Couldn't import events from events.json.", detail: RAW },
    { name: "Allow, dry run", fail: { actions: "fail" }, act: `document.querySelector('[data-allow="chat.example.org"]').click(); true`, text: "Couldn't run the dry run for chat.example.org.", detail: RAW },
    { name: "Allow", modal: true, fail: { actions: "fail" }, act: `document.querySelector("#allow-go").click(); true`, text: "Couldn't allow chat.example.org.", detail: RAW },
    { name: "Undo, refused", fail: { actions: "fail" }, act: `document.querySelector("[data-undo]").click(); true`, text: "Couldn't undo the Allow for chat.example.org.", detail: RAW },
    { name: "Undo, failed", fail: { undoResult: { ...allow, status: "undo-failed", error: "Sophos API error 500: InternalServerError" } }, act: `document.querySelector("[data-undo]").click(); true`, text: "Couldn't undo the Allow for chat.example.org.", detail: "Sophos API error 500: InternalServerError" },
  ];
  let b;
  try {
    b = await openBrowser();
    for (const c of cases) {
      Object.assign(s, { actions: "ok", collectRun: null, undoResult: null });
      await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "[data-allow]");
      await b.evaluate(WATCH);
      if (c.modal) {
        await b.evaluate(`document.querySelector('[data-allow="chat.example.org"]').click(); true`);
        await b.waitFor("#allow-go");
      }
      Object.assign(s, c.fail);
      await b.evaluate(c.act);
      const [t] = await toasts(b);
      assert.deepEqual(t, { text: c.text, detail: `Detail: ${c.detail}.` }, c.name);
      assert.ok(!/401|403|500|invalid_client|auth failed|Sophos/.test(t.text), `${c.name}: no raw detail in the main text`);
      assert.deepEqual(await b.evaluate(`window.__unhandled`), [], c.name);
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

/** What the Pilot page shows: the headline, the pilot card's tag, the cards, the sites, and the note on a read that failed. */
const PILOT = `(() => {
  const main = document.querySelector("#main");
  const card = (t) => [...main.querySelectorAll(".panel-card")].find((c) => c.querySelector("h2")?.textContent === t);
  const note = main.querySelector("[data-reread-failed]");
  const clone = note?.cloneNode(true);
  clone?.querySelector("[data-unread-detail]")?.remove();
  return {
    h1: main.querySelector("h1").textContent.trim(),
    nothingYet: /nothing to show yet/.test(main.textContent),
    pilotTag: card("Pilot policy")?.querySelector(".tag")?.textContent.trim() ?? null,
    filterCard: !!card("Pilot devices only"),
    pilotOnly: main.querySelector("#pilotonly")?.checked ?? null,
    sites: [...main.querySelectorAll(".sites-table tbody tr")].map((tr) => tr.querySelector("b").textContent),
    note: note ? { text: clone.textContent.replace(/\\s+/g, " ").trim(), detail: note.querySelector("[data-unread-detail]")?.textContent.trim() ?? null } : null,
    notes: main.querySelectorAll("[data-reread-failed]").length,
    unhandled: window.__unhandled ?? [],
  };
})()`;
const NOTE = { text: "Couldn't read the pilot The tool couldn't read the pilot or its events, so the page still shows what it read before. Retry, or check the tenant in Sophos Fusion. Retry", detail: `Detail: ${RAW}.` };
const CARD_RETRY = `(() => { const r = document.querySelector("section:not([data-reread-failed]) [data-retry]"); r.scrollIntoView({ block: "center" }); r.click(); return true; })()`;

test("the Retry in the Not read and Pilot devices only cards keeps what's on screen while the read fails, then reads the page", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const { server: srv, base, s } = await server();
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      // The Not read card: the pilot policy couldn't be read.
      Object.assign(s, { reads: "ok", policyUnread: true, filterUnread: false });
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-retry]");
      await b.evaluate(WATCH);
      const shown = await b.evaluate(PILOT);
      assert.equal(shown.pilotTag, "Not read", `${width} px`);
      s.reads = "fail";
      await b.evaluate(CARD_RETRY);
      await b.waitFor("[data-reread-failed]");
      let p = await b.evaluate(PILOT);
      assert.deepEqual([p.nothingYet, p.h1, p.pilotTag, p.sites, p.note, p.notes], [false, shown.h1, "Not read", shown.sites, NOTE, 1], `${width} px: Not read card, read fails`);
      // Retry again from the card while it still fails: still one note, and the page as it was.
      await b.evaluate(CARD_RETRY);
      await b.waitFor("section:not([data-reread-failed]) [data-retry]:not([disabled])");
      p = await b.evaluate(PILOT);
      assert.deepEqual([p.nothingYet, p.pilotTag, p.notes], [false, "Not read", 1], `${width} px: Not read card, read still fails`);
      // Once it reads: the pilot policy shows and the note goes.
      Object.assign(s, { reads: "ok", policyUnread: false });
      await b.evaluate(CARD_RETRY);
      for (let i = 0; i < 100 && (await b.evaluate(`!!document.querySelector("[data-reread-failed]")`)); i++) await new Promise((r) => setTimeout(r, 100));
      p = await b.evaluate(PILOT);
      assert.deepEqual([p.notes, p.pilotTag, p.unhandled], [0, "Off", []], `${width} px: Not read card, read works`);

      // The Pilot devices only card: the pilot's devices couldn't be read.
      Object.assign(s, { reads: "ok", policyUnread: false, filterUnread: true });
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-allow]");
      await b.evaluate(WATCH);
      await b.evaluate(`document.querySelector("#pilotonly").click(); true`);
      await b.waitFor("[data-retry]");
      const filtered = await b.evaluate(PILOT);
      assert.deepEqual([filtered.filterCard, filtered.h1], [true, "Couldn't read the pilot's devices"], `${width} px`);
      s.reads = "fail";
      await b.evaluate(CARD_RETRY);
      await b.waitFor("[data-reread-failed]");
      p = await b.evaluate(PILOT);
      assert.deepEqual([p.nothingYet, p.h1, p.filterCard, p.pilotOnly, p.pilotTag, p.note, p.notes], [false, filtered.h1, true, true, "Off", NOTE, 1], `${width} px: Pilot devices only card, read fails`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
      // Once it reads: the digest for the pilot's devices shows and the note goes.
      Object.assign(s, { reads: "ok", filterUnread: false });
      await b.evaluate(CARD_RETRY);
      for (let i = 0; i < 100 && (await b.evaluate(`!!document.querySelector("[data-reread-failed]")`)); i++) await new Promise((r) => setTimeout(r, 100));
      p = await b.evaluate(PILOT);
      assert.deepEqual([p.notes, p.filterCard, p.pilotOnly, p.sites.length, p.unhandled], [0, false, true, 3, []], `${width} px: Pilot devices only card, read works`);
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

test("a failed save of Collect every few hours says so plainly and leaves the box showing the saved setting", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server: srv, base, s } = await server();
  const BOX = `document.querySelector("#schedule").checked`;
  let b;
  try {
    b = await openBrowser();
    Object.assign(s, { actions: "fail", enabled: false });
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "#schedule");
    await b.evaluate(WATCH);
    // Ticked while the save fails: the box goes back to off.
    await b.evaluate(`document.querySelector("#schedule").click(); true`);
    let t = await toasts(b);
    assert.deepEqual(t, [{ text: "Couldn't turn collection on, so it's still off.", detail: `Detail: ${RAW}.` }]);
    assert.deepEqual([await b.evaluate(BOX), s.enabled], [false, false]);
    // Ticked once it saves: on.
    s.actions = "ok";
    await b.evaluate(`document.querySelector("#schedule").click(); true`);
    t = await toasts(b, 2);
    assert.deepEqual(t[1], { text: "Collection is on while the tool runs.", detail: null });
    assert.deepEqual([await b.evaluate(BOX), s.enabled], [true, true]);
    // Unticked while the save fails: the box goes back to on.
    s.actions = "fail";
    await b.evaluate(`document.querySelector("#schedule").click(); true`);
    t = await toasts(b, 3);
    assert.deepEqual(t[2], { text: "Couldn't turn collection off, so it's still on.", detail: `Detail: ${RAW}.` });
    assert.deepEqual([await b.evaluate(BOX), s.enabled], [true, true]);
    assert.deepEqual(await b.evaluate(`window.__unhandled`), []);
  } finally {
    srv.close();
    await b?.close();
  }
});

test("toasts don't cover the top bar or the rail, at 390 px or on a desktop, at the top of the page or scrolled down", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const { server: srv, base, s } = await server();
  // Where the toasts sit against the top bar, the rail and the window.
  const PLACE = `(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const stack = r("#toast-stack");
    const over = (a, c) => a.top < c.bottom && a.bottom > c.top && a.left < c.right && a.right > c.left;
    return { toasts: document.querySelectorAll(".toast").length, bar: over(stack, r(".topbar")), rail: over(stack, r("#app-rail")), inside: stack.top >= 0 && stack.left >= 0 && stack.right <= innerWidth && stack.bottom <= innerHeight };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [390, 1440]) {
      for (const scrolled of [false, true]) {
        Object.assign(s, { actions: "ok", enabled: false });
        await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-allow]");
        if (scrolled) await b.evaluate(`window.scrollTo(0, 600); true`);
        // A short toast, then one with a long raw detail.
        await b.evaluate(`document.querySelector("#schedule").click(); true`);
        await toasts(b);
        s.actions = "fail";
        await b.evaluate(`document.querySelector("#collect").click(); true`);
        await toasts(b, 2);
        const at = `${width} px, ${scrolled ? "scrolled down" : "at the top"}`;
        assert.deepEqual(await b.evaluate(PLACE), { toasts: 2, bar: false, rail: false, inside: true }, at);
        const page = await b.evaluate(PAGE_WIDTH);
        assert.equal(page.scrollWidth, page.width, `${at}: no sideways scroll`);
      }
    }
  } finally {
    srv.close();
    await b?.close();
  }
});
