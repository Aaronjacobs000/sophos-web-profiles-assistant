// v0.3.13, as drawn in a headless Chrome or Edge (skipped without one): the
// Allow buttons in the Pilot page's sites table are never off to the side,
// the Pilot page keeps Sophos's answer on a separate Detail line and says
// plainly when the page can't be read, the Readiness card pair fits at phone
// width, and Undo on a moved wave is off while the pilot policy is unread.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { buildScorecard } from "../backend/dist/domain/scorecard.js";
import { inventory } from "./fixtures.mjs";
import { openBrowser, pageServer, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.13", readOnly: false };
const store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } };
const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const now = new Date().toISOString();
const ev = (n, endpoint, url, action, why) => ({ id: `e${n}`, type: "Event::Endpoint::WebControlViolation", name: `'${url}' ${action} due to ${why}`, created_at: now, endpoint_id: endpoint, user_id: `u${n}` });
const events = [
  ev(1, "w1", "https://app.example.com/login", "blocked", "category 'Social Networking'"),
  ev(2, "w1", "https://downloads.example.net/setup.exe", "warned", "filetype 'Windows Executable (exe)'"),
  ev(3, "w2", "https://chat.example.org/", "blocked", "category 'Chat'"),
  ev(4, "w1", "https://files.storage-example.com/share/a1", "warned", "category 'Online Storage and Backup'"),
];
const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) };
const promoPolicy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 };

/** The page's own width and how wide its content is, so a sideways scroll shows. */
const PAGE_WIDTH = `({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth })`;

/** The frontend with an API whose handlers answer [status, body], so a read can fail. */
async function failingServer(api) {
  const app = express();
  app.use(express.json());
  app.all("/api/*", (req, res) => {
    const found = api[req.path];
    if (!found) return res.status(404).json({ error: "not_found" });
    const [code, body] = found();
    res.status(code).json(body);
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("the Allow buttons in the Pilot page's sites table sit inside its box, with no sideways scroll, at 390 px and at every other width", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: { pilot, policy, store, allows: [] }, [`/api/pilot/${T}/digest`]: digest });
  // Each Allow button and whether it sits wholly inside the table's box, whether the box scrolls sideways, and each row's text.
  const SITES = `(() => {
    const wrap = document.querySelector("[data-allow]").closest(".table-wrap");
    const box = wrap.getBoundingClientRect();
    const buttons = [...wrap.querySelectorAll("[data-allow]")].map((b) => { const r = b.getBoundingClientRect(); return { host: b.dataset.allow, inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.width > 0 }; });
    return { outside: buttons.filter((b) => !b.inside).map((b) => b.host), count: buttons.length, scrolls: wrap.scrollWidth > wrap.clientWidth, header: getComputedStyle(wrap.querySelector("thead")).display !== "none",
      rows: [...wrap.querySelectorAll("tbody tr")].map((tr) => tr.innerText.replace(/\\s+/g, " ").trim()) };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [390, 800, 1024, 1300, 1440]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-allow]");
      const r = await b.evaluate(SITES);
      assert.deepEqual([r.outside, r.count, r.scrolls], [[], 4, false], `${width} px: ${JSON.stringify(r)}`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
      if (width === 1440 || width === 1024) assert.equal(r.header, true, `${width} px: a wide card keeps the table`);
    }
    // At phone width each site stacks: the site with Allow beside it, then each count named under them.
    await b.open(`${base}/pilot.html?tenant=${T}`, 390, "[data-allow]");
    const narrow = await b.evaluate(SITES);
    assert.equal(narrow.header, false);
    const row = narrow.rows.find((x) => x.startsWith("app.example.com"));
    assert.match(row, /^app\.example\.com Category: Social Networking Warned 0 Blocked 1 Users 1 Devices 1 Last seen \d\d\/\d\d\/\d{4}, \d\d:\d\d Allow$/, row);
    const sameLine = await b.evaluate(`(() => { const tr = document.querySelector("[data-allow]").closest("tr"); const site = tr.querySelector("b").getBoundingClientRect(); const allow = tr.querySelector("[data-allow]").getBoundingClientRect(); const first = tr.querySelector("td.s-count").getBoundingClientRect(); return { beside: allow.top < site.bottom && allow.left >= site.right, countsBelow: first.top >= allow.bottom }; })()`);
    assert.deepEqual(sameLine, { beside: true, countsBelow: true });
  } finally {
    server.close();
    await b?.close();
  }
});

/** The Pilot policy card: its tag, its main text without the detail line, the detail line, and its buttons. */
const PILOT_CARD = `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Pilot policy").cloneNode(true);
  const detail = c.querySelector("[data-unread-detail]");
  detail?.remove();
  return { tag: c.querySelector(".card-head .tag")?.textContent, text: c.textContent.replace(/\\s+/g, " ").trim(), detail: detail?.textContent.trim() ?? null, buttons: [...c.querySelectorAll("button")].map((x) => x.textContent.trim()) };
})()`;

test("the Pilot page's Not read card keeps Sophos's answer out of its main text, on a separate Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const unread = "Sophos API error 403: Forbidden";
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: { pilot, policy: null, policyUnread: unread, store, allows: [] }, [`/api/pilot/${T}/digest`]: digest });
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, ".order-list");
      const card = await b.evaluate(PILOT_CARD);
      assert.equal(card.tag, "Not read");
      assert.ok(card.text.includes("The tool couldn't read the pilot policy. That doesn't mean it's gone. Retry, or check it in Sophos Fusion."), card.text);
      assert.ok(!card.text.includes(unread) && !/403|Forbidden/.test(card.text), `no raw detail in the main text: ${card.text}`);
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

/** The Pilot page's headline, main text without the detail line, the detail line, and whether it shows a raw error banner. */
const PILOT_PAGE = `(() => {
  const main = document.querySelector("#main").cloneNode(true);
  const detail = main.querySelector("[data-unread-detail]");
  detail?.remove();
  return { h1: main.querySelector("h1")?.textContent.trim() ?? null, text: main.textContent.replace(/\\s+/g, " ").trim(), detail: detail?.textContent.trim() ?? null, retry: main.querySelectorAll("[data-retry]").length, errBanner: !!main.querySelector(".banner-err") };
})()`;

test("when the Pilot page can't be read at all, it says so plainly with a retry instead of the raw error, and Retry reads again", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const raw = `Sophos auth failed (401): {"error":"invalid_client"}`;
  let fail = true;
  let reads = 0;
  const { server, base } = await failingServer({
    "/api/status": () => [200, { ...status, status: "configured-invalid", error: raw, tenant: null }],
    [`/api/readiness/${T}`]: () => [503, { error: "configured-invalid", message: raw }],
    [`/api/pilot/${T}`]: () => (reads++, fail ? [503, { error: "configured-invalid", message: raw }] : [200, { pilot, policy, store, allows: [] }]),
    [`/api/pilot/${T}/digest`]: () => (fail ? [503, { error: "configured-invalid", message: raw }] : [200, digest]),
  });
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-retry]");
      const p = await b.evaluate(PILOT_PAGE);
      assert.equal(p.h1, "Couldn't read the pilot");
      assert.ok(p.text.includes("The tool couldn't read the pilot or its events, so there's nothing to show yet. Retry, or check the tenant in Sophos Fusion."), p.text);
      assert.ok(!/401|invalid_client|auth failed/.test(p.text), `no raw detail in the main text: ${p.text}`);
      assert.equal(p.detail, `Detail: ${raw}.`);
      assert.deepEqual([p.retry, p.errBanner], [1, false]);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
    // Retry: still failing, it says so again; then it reads and draws the page.
    const before = reads;
    await b.evaluate(`document.querySelector("[data-retry]").click(); true`);
    for (let i = 0; i < 50 && reads < before + 1; i++) await new Promise((r) => setTimeout(r, 100));
    await b.waitFor("[data-retry]:not([disabled])");
    assert.equal((await b.evaluate(PILOT_PAGE)).h1, "Couldn't read the pilot");
    fail = false;
    await b.evaluate(`document.querySelector("[data-retry]").click(); true`);
    await b.waitFor("[data-allow]");
    const read = await b.evaluate(PILOT_PAGE);
    assert.deepEqual([read.h1, read.detail, read.retry, read.errBanner], ["2 warned and 2 blocked in the last 7 days", null, 0, false]);
    assert.equal(reads, before + 2);
  } finally {
    server.close();
    await b?.close();
  }
});

test("the Readiness page's card pair fits at 390 px with nothing cut off, even with large numbers, and the page never scrolls sideways", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const scorecard = buildScorecard(inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" } }));
  scorecard.facts.websiteManagement = { ...scorecard.facts.websiteManagement, entries: 123456, tags: 1234 };
  scorecard.facts.profiles = { count: 20, limit: 20 };
  scorecard.facts.siteLists = { count: 20, sites: 15000 };
  const result = { readAt: now, durationMs: 4200, calls: 21, scorecard, snapshot: { file: "Example_Tenant_20261016-010000.json", hash: "0".repeat(64), bytes: 1000 } };
  const { server, base } = await pageServer({ "/api/status": status, [`/api/readiness/${T}`]: { tenant: { id: T, name: "Example Tenant", region: "us01" }, result, running: false } });
  // Each card in the pair inside the pair's box and the page, and anything in them past their edge or clipped.
  const PAIR = `(() => {
    const iw = document.documentElement.clientWidth;
    const pair = document.querySelector(".kpi-pair");
    const pr = pair.getBoundingClientRect();
    const cards = [...pair.children].map((c) => { const r = c.getBoundingClientRect(); return r.left >= pr.left - 0.5 && r.right <= Math.min(pr.right, iw) + 0.5; });
    const cut = [...pair.querySelectorAll(".kpi-num, .kpi-label")].filter((e) => { const r = e.getBoundingClientRect(); const c = e.closest(".panel-card").getBoundingClientRect(); return r.right > c.right + 0.5 || e.scrollWidth > e.clientWidth + 1; }).map((e) => e.textContent.trim());
    return { cards, cut, text: [...pair.children].map((c) => c.innerText.replace(/\\s+/g, " ").trim()) };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [390, 800, 1024, 1440]) {
      await b.open(`${base}/readiness.html?tenant=${T}`, width, ".kpi-pair");
      const r = await b.evaluate(PAIR);
      assert.deepEqual([r.cards, r.cut], [[true, true], []], `${width} px: ${JSON.stringify(r)}`);
      assert.deepEqual(r.text, ["123,456 Website Management entries in 1,234 tags", "20 / 20 web filtering profiles in use, 20 site lists"]);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
  } finally {
    server.close();
    await b?.close();
  }
});

test("while the pilot policy is unread, Undo on its moved waves is off and says why", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const wave = (id, s, policyId = "p1") => ({ id, at: "2026-10-15T03:00:00.000Z", buildId: "b1", policyId, devices: [{ id: "w1", hostname: "EXAMPLE-PC-01" }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: ["w1"], endpointGroups: [] }, status: s, readBack: "assignment matches" });
  const waves = [wave("88888888-0000-4000-8000-000000000002", "undo-failed"), wave("88888888-0000-4000-8000-000000000001", "moved")];
  let promo = { pilot, policy: null, mode: "none", plan: null, waves, waveSize: 25, policyUnread: "Sophos API error 403: Forbidden" };
  const { server, base } = await pageServer({ "/api/status": status, [`/api/promote/${T}`]: () => promo, [`/api/retire/${T}`]: { tags: [], records: [] } });
  const UNDO = `({ buttons: [...document.querySelectorAll("[data-undo-wave]")].map((x) => ({ disabled: x.disabled, title: x.title })), hint: document.querySelector("[data-undo-off]")?.textContent.trim() ?? null })`;
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, "[data-undo-wave]");
    const why = "Undo is off: the tool couldn't read the pilot policy.";
    const off = { disabled: true, title: why };
    assert.deepEqual(await b.evaluate(UNDO), { buttons: [off, off], hint: why });
    // Read again, Undo is on and the note goes.
    promo = { pilot, policy: promoPolicy, mode: "devices", plan: { waves: [], inPilot: [{ id: "w1" }], notEligible: [] }, waves, waveSize: 25 };
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, "[data-undo-wave]");
    const on = { disabled: false, title: "" };
    assert.deepEqual(await b.evaluate(UNDO), { buttons: [on, on], hint: null });
  } finally {
    server.close();
    await b?.close();
  }
});
