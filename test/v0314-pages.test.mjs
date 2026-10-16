// v0.3.14, as drawn in a headless Chrome or Edge (skipped without one): the
// Pilot page's Pilot devices only card keeps Sophos's answer on a separate
// Detail line, a read that fails after a change on the Pilot page says so
// plainly with a retry and keeps what was on screen, and Undo on a moved wave
// is off once the pilot policy is no longer in the tenant.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { openBrowser, pageServer, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.14", readOnly: false };
const store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } };
const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const now = new Date().toISOString();
const ev = (n, endpoint, url, action, why) => ({ id: `e${n}`, type: "Event::Endpoint::WebControlViolation", name: `'${url}' ${action} due to ${why}`, created_at: now, endpoint_id: endpoint, user_id: `u${n}` });
const events = [
  ev(1, "w1", "https://app.example.com/login", "blocked", "category 'Social Networking'"),
  ev(2, "w1", "https://downloads.example.net/setup.exe", "warned", "filetype 'Windows Executable (exe)'"),
  ev(3, "w2", "https://chat.example.org/", "blocked", "category 'Chat'"),
];
const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) };
const allow = { id: "a1", at: now, host: "chat.example.org", site: "chat.example.org", buildId: "b1", profileId: "pr1", listName: "Example pilot allows", createdList: true, status: "added", readBack: "site listed", buildStatus: "built" };

/** The page's own width and how wide its content is, so a sideways scroll shows. */
const PAGE_WIDTH = `({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth })`;

test("the Pilot page's Pilot devices only card keeps Sophos's answer out of its main text, on a separate Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const unread = "Sophos API error 403: Forbidden";
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: { pilot, policy, store, allows: [] }, [`/api/pilot/${T}/digest`]: { ...digest, pilotOnly: true, pilotUnread: unread } });
  const CARD = `(() => {
    const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Pilot devices only").cloneNode(true);
    const detail = c.querySelector("[data-unread-detail]");
    detail?.remove();
    return { text: c.textContent.replace(/\\s+/g, " ").trim(), detail: detail?.textContent.trim() ?? null, buttons: [...c.querySelectorAll("button")].map((x) => x.textContent.trim()) };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-retry]");
      const card = await b.evaluate(CARD);
      assert.equal(card.text, "Pilot devices only The tool couldn't read which devices are on the pilot, so the digest isn't shown. Retry, or untick Pilot devices only to see every device. Retry");
      assert.ok(!/403|Forbidden|Sophos API/.test(card.text), `no raw detail in the main text: ${card.text}`);
      assert.equal(card.detail, `Detail: ${unread}.`);
      assert.deepEqual(card.buttons, ["Retry"]);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
  } finally {
    server.close();
    await b?.close();
  }
});

/**
 * The frontend with an API that can fail its reads on demand: reads answer
 * "ok", "fail" (a 503 with Sophos's raw answer, as when the credential stops
 * working) or "drop" (the connection closes, as when the tool stops). Writes
 * always go through, so only the read after them fails.
 */
async function flakyServer() {
  const raw = `Sophos auth failed (401): {"error":"invalid_client"}`;
  const s = { reads: "ok", digestQueries: [] };
  const app = express();
  app.use(express.json());
  const read = (res, body) => (s.reads === "drop" ? res.socket.destroy() : s.reads === "fail" ? res.status(503).json({ error: "configured-invalid", message: raw }) : res.json(body));
  app.get("/api/status", (_req, res) => res.json(status));
  app.get(`/api/pilot/${T}`, (_req, res) => read(res, { pilot, policy, store, allows: [allow] }));
  app.get(`/api/pilot/${T}/digest`, (req, res) => {
    s.digestQueries.push({ days: Number(req.query.days), pilotOnly: req.query.pilotOnly === "1" });
    read(res, { ...digest, days: Number(req.query.days), pilotOnly: req.query.pilotOnly === "1" });
  });
  app.post(`/api/pilot/${T}/collect`, (_req, res) => res.json({ ok: true, added: 0, web: 0, fetched: 0 }));
  app.post(`/api/pilot/${T}/import`, (_req, res) => res.json({ added: 0 }));
  app.post(`/api/pilot/${T}/allow`, (req, res) =>
    res.json(req.body.dryRun === false ? { dryRun: false, entry: { site: req.body.host, readBack: "site listed" } } : { dryRun: true, plan: { pilot, host: req.body.host, site: req.body.host, steps: [{ op: "add-site", listId: "l1", listName: "Example pilot allows", site: req.body.host }], problems: [], notes: [] } }),
  );
  app.post(`/api/pilot/${T}/allow/a1/undo`, (_req, res) => res.json({ ...allow, status: "undone", undo: ["Site removed, confirmed on read-back."] }));
  app.all("/api/*", (_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, s, raw };
}

/** What the Pilot page shows: the headline, the sites table, the controls, and the note on a read that failed (main text and detail apart). */
const PILOT = `(() => {
  const main = document.querySelector("#main");
  const note = main.querySelector("[data-reread-failed]");
  const clone = note?.cloneNode(true);
  const detail = clone?.querySelector("[data-unread-detail]");
  detail?.remove();
  const r = note?.getBoundingClientRect();
  // In view means below the sticky top bar, not under it.
  const bar = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
  const collect = main.querySelector("#collect");
  return {
    h1: main.querySelector("h1").textContent.trim(),
    sites: [...main.querySelectorAll(".sites-table tbody tr")].map((tr) => tr.querySelector("b").textContent),
    allows: [...main.querySelectorAll("[data-undo]")].length,
    period: main.querySelector("#days").value,
    pilotOnly: main.querySelector("#pilotonly").checked,
    collect: [collect.textContent.trim(), collect.disabled],
    note: note ? { text: clone.textContent.replace(/\\s+/g, " ").trim(), detail: detail?.textContent.trim() ?? null, buttons: [...note.querySelectorAll("button")].map((x) => x.textContent.trim()), inView: r.top >= bar && r.bottom <= innerHeight } : null,
    notes: main.querySelectorAll("[data-reread-failed]").length,
    unhandled: window.__unhandled ?? [],
  };
})()`;
const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.confirm = () => true; true`;
const NOTE_TEXT = "Couldn't read the pilot The tool couldn't read the pilot or its events, so the page still shows what it read before. Retry, or check the tenant in Sophos Fusion. Retry";

/** Each change on the Pilot page that reads it again, as a click or a change in the page. */
const CHANGES = {
  // Scrolled to first, as at phone width it's far down the page.
  period: `(() => { const s = document.querySelector("#days"); s.scrollIntoView({ block: "center" }); s.value = "30"; s.dispatchEvent(new Event("change")); return true; })()`,
  "pilot devices only": `document.querySelector("#pilotonly").click(); true`,
  "collect now": `document.querySelector("#collect").click(); true`,
  import: `(() => { const i = document.querySelector("#import"); const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ items: [] })], "events.json", { type: "application/json" })); i.files = dt.files; i.dispatchEvent(new Event("change")); return true; })()`,
  allow: `document.querySelector("#allow-go").click(); true`,
  undo: `document.querySelector("[data-undo]").click(); true`,
};

test("a read that fails after any change on the Pilot page says so plainly with a retry, keeps the raw detail out of the main text, and keeps what was on screen", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const { server, base, s, raw } = await flakyServer();
  let b;
  try {
    b = await openBrowser();
    for (const [change, act] of Object.entries(CHANGES)) {
      s.reads = "ok";
      await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "[data-allow]");
      await b.evaluate(WATCH);
      const before = await b.evaluate(PILOT);
      if (change === "allow") {
        await b.evaluate(`document.querySelector('[data-allow="chat.example.org"]').click(); true`);
        await b.waitFor("#allow-go");
      }
      s.reads = "fail";
      await b.evaluate(act);
      await b.waitFor("[data-reread-failed]");
      const after = await b.evaluate(PILOT);
      assert.deepEqual(after.note, { text: NOTE_TEXT, detail: `Detail: ${raw}.`, buttons: ["Retry"], inView: true }, change);
      assert.ok(!/401|invalid_client|auth failed/.test(after.note.text), `${change}: no raw detail in the main text`);
      assert.deepEqual([after.h1, after.sites, after.allows], [before.h1, before.sites, before.allows], `${change}: what was on screen stays`);
      assert.deepEqual([after.collect, after.notes, after.unhandled], [["Collect now", false], 1, []], change);
    }
  } finally {
    server.close();
    await b?.close();
  }
});

test("Retry after a read that failed keeps the page while it still fails, then reads the page with the choice that was made", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const { server, base, s } = await flakyServer();
  let b;
  try {
    b = await openBrowser();
    for (const width of [390, 1440]) {
      s.reads = "ok";
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-allow]");
      await b.evaluate(WATCH);
      const shown = await b.evaluate(PILOT);
      assert.equal(shown.h1, "1 warned and 2 blocked in the last 7 days");
      // The tool stops: the connection closes.
      s.reads = "drop";
      await b.evaluate(CHANGES.period);
      await b.waitFor("[data-reread-failed]");
      let p = await b.evaluate(PILOT);
      assert.deepEqual([p.note.detail, p.note.inView, p.h1, p.sites, p.period], ["Detail: Failed to fetch.", true, shown.h1, shown.sites, "30"], `${width} px`);
      assert.equal((await b.evaluate(PAGE_WIDTH)).scrollWidth, (await b.evaluate(PAGE_WIDTH)).width, `${width} px: no sideways scroll`);
      // Retry while it still fails: the same note, once, and the page as it was.
      s.reads = "fail";
      await b.evaluate(`document.querySelector("[data-reread-failed] button").click(); true`);
      await b.waitFor("[data-reread-failed] button:not([disabled])");
      p = await b.evaluate(PILOT);
      assert.deepEqual([p.notes, p.note.text, p.h1, p.sites], [1, NOTE_TEXT, shown.h1, shown.sites]);
      // Retry once it reads: the page is drawn for the last 30 days and the note goes.
      s.reads = "ok";
      s.digestQueries.length = 0;
      await b.evaluate(`document.querySelector("[data-reread-failed] button").click(); true`);
      for (let i = 0; i < 100 && (await b.evaluate(`!!document.querySelector("[data-reread-failed]")`)); i++) await new Promise((r) => setTimeout(r, 100));
      p = await b.evaluate(PILOT);
      assert.deepEqual([p.notes, p.h1, p.period, s.digestQueries], [0, "1 warned and 2 blocked in the last 30 days", "30", [{ days: 30, pilotOnly: false }]]);
      assert.deepEqual(p.unhandled, []);
    }
  } finally {
    server.close();
    await b?.close();
  }
});

test("once the pilot policy is no longer in the tenant, Undo on its moved waves is off and says why", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const wave = (id, s) => ({ id, at: "2026-10-15T03:00:00.000Z", buildId: "b1", policyId: "p1", devices: [{ id: "w1", hostname: "EXAMPLE-PC-01" }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: ["w1"], endpointGroups: [] }, status: s, readBack: "assignment matches" });
  const waves = [wave("88888888-0000-4000-8000-000000000002", "undo-failed"), wave("88888888-0000-4000-8000-000000000001", "moved")];
  const promo = { pilot, policy: null, mode: "none", plan: { waves: [], inPilot: [], notEligible: [] }, waves, waveSize: 25, problem: `The pilot policy "${pilot.policyName}" is no longer in the tenant, so there's nothing to promote. Roll the build back on the Build page to remove what's left of it, or build a new pilot.` };
  const { server, base } = await pageServer({ "/api/status": status, [`/api/promote/${T}`]: promo, [`/api/retire/${T}`]: { tags: [], records: [] } });
  const UNDO = `({ buttons: [...document.querySelectorAll("[data-undo-wave]")].map((x) => ({ disabled: x.disabled, title: x.title })), hint: document.querySelector("[data-undo-off]")?.textContent.trim() ?? null })`;
  let b;
  try {
    b = await openBrowser();
    const why = "Undo is off: the pilot policy is no longer in the tenant.";
    const off = { disabled: true, title: why };
    for (const width of [1440, 390]) {
      await b.open(`${base}/promote.html?tenant=${T}`, width, "[data-undo-wave]");
      assert.deepEqual(await b.evaluate(UNDO), { buttons: [off, off], hint: why }, `${width} px`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
  } finally {
    server.close();
    await b?.close();
  }
});
