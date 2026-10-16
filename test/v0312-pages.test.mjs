// v0.3.12, as drawn in a headless Chrome or Edge (skipped without one): the
// Pilot page never scrolls sideways at phone width, the Retired table shows
// every status and button in full at any width, Allow says why it's off when
// there's no pilot, and the Promote page says plainly when a read failed, with
// a retry, instead of the raw error in place of the page.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { openBrowser, pageServer, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.12", readOnly: false };
const store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } };
const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const now = new Date().toISOString();
const events = [
  { id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://app.example.com/login' blocked due to category 'Social Networking'", created_at: now, endpoint_id: "w1", user_id: "u1" },
  { id: "e2", type: "Event::Endpoint::WebControlViolation", name: "'https://downloads.example.net/setup.exe' warned due to filetype 'Windows Executable (exe)'", created_at: now, endpoint_id: "w1", user_id: "u1" },
  { id: "e3", type: "Event::Endpoint::WebControlViolation", name: "'https://chat.example.org/' blocked due to category 'Chat'", created_at: now, endpoint_id: "w2", user_id: "u2" },
];
const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) };
const promoPolicy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 };
const promo = { pilot, policy: promoPolicy, mode: "devices", plan: { waves: [], inPilot: [{ id: "w1" }], notEligible: [] }, waves: [], waveSize: 25 };

const tagStep = (s, extra = {}) => ({ op: "policy-tags", policyId: "b", policyName: "Base Policy", before: [{ tag: "Example tag", action: "block" }], after: [], status: s, ...extra });
const delStep = (s, extra = {}) => ({ op: "delete-entry", id: "s1", url: "blocked.example.com", tags: ["Example tag"], status: s, ...extra });
const patchStep = (s, extra = {}) => ({ op: "patch-entry", id: "s2", url: "shared.example.com", before: ["Example tag", "Other tag"], after: ["Other tag"], status: s, ...extra });
const rec = (n, s, steps) => ({ id: `77777777-0000-4000-8000-00000000000${n}`, tenantId: T, at: `2026-10-1${n}T01:00:00.000Z`, tags: ["Example tag"], snapshotFile: `Example_Tenant_2026101${n}-010000.json`, status: s, steps, warnings: [] });
const records = [
  rec(5, "restore-partial", [tagStep("restore-failed", { readBack: "tags differ" }), delStep("restored", { readBack: "re-created, matches" })]),
  rec(4, "failed", [tagStep("failed", { error: "Sophos API error 403: Forbidden" }), delStep("planned")]),
  rec(3, "partial", [tagStep("done", { readBack: "tags match" }), delStep("failed"), patchStep("planned")]),
  rec(2, "restored", [tagStep("restored", { readBack: "tags match" }), delStep("restored", { readBack: "re-created, matches" })]),
  rec(1, "retired", [tagStep("done", { readBack: "tags match" }), delStep("done", { readBack: "404 on read-back" }), patchStep("done", { readBack: "tags match" })]),
];

/** The page's own width and how wide its content is, so a sideways scroll shows. */
const PAGE_WIDTH = `({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth })`;

test("at phone width the Pilot page's By day and Top reasons cards stack, so the page never scrolls sideways", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: { pilot, policy, store, allows: [] }, [`/api/pilot/${T}/digest`]: digest });
  const PAIR = `(() => { const [a, b] = [...document.querySelector(".kpi-pair").children].map((c) => c.getBoundingClientRect()); return { stacked: b.top >= a.bottom, reasons: document.querySelectorAll(".kpi-pair .order-list li").length }; })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [390, 760]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, ".kpi-pair .order-list");
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll: ${JSON.stringify(page)}`);
      assert.deepEqual(await b.evaluate(PAIR), { stacked: true, reasons: 3 }, `${width} px`);
    }
    // Wider, they stay side by side.
    for (const width of [800, 1440]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, ".kpi-pair .order-list");
      assert.equal((await b.evaluate(PAIR)).stacked, false, `${width} px`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px`);
    }
  } finally {
    server.close();
    await b?.close();
  }
});

test("the Retired table shows every status and button in full, inside its box, at any width", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const { server, base } = await pageServer({ "/api/status": status, [`/api/promote/${T}`]: promo, [`/api/retire/${T}`]: { tags: [], records } });
  // Each status and button in the Retired card, and whether it sits wholly inside the table's box.
  const RETIRED = `(() => {
    const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Retired");
    const wrap = c.querySelector(".table-wrap");
    const box = wrap.getBoundingClientRect();
    const items = [...c.querySelectorAll("tbody .tag, tbody button")].map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent.trim(), inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.width > 0 }; });
    return { cut: items.filter((i) => !i.inside).map((i) => i.text), count: items.length, scrolls: wrap.scrollWidth > wrap.clientWidth };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 1300, 1024, 800, 390]) {
      await b.open(`${base}/promote.html?tenant=${T}`, width, "[data-diff]");
      const r = await b.evaluate(RETIRED);
      assert.deepEqual(r, { cut: [], count: 14, scrolls: false }, `${width} px`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
    // The status words and steps are still the record's, in plain words.
    const rows = await b.evaluate(`[...document.querySelectorAll(".retired-table tbody tr")].map((tr) => [tr.children[2].textContent.trim(), [...tr.querySelectorAll("button")].map((x) => x.textContent.trim()).join(", ")])`);
    // From v0.3.19 a restore Sophos accepted whose read-back differed is not confirmed, rather than unfinished.
    assert.deepEqual(rows, [
      ["Restore not confirmed", "Restore, Compare with snapshot"],
      ["Retire failed", "Restore, Compare with snapshot"],
      ["Retire didn't finish", "Restore, Compare with snapshot"],
      ["Restored", "Compare with snapshot"],
      ["Retired", "Restore, Compare with snapshot"],
    ]);
  } finally {
    server.close();
    await b?.close();
  }
});

test("with no pilot at all, the Allow buttons are off and say why", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: { pilot: null, policy: null, store, allows: [] }, [`/api/pilot/${T}/digest`]: digest });
  const ALLOW = `({ buttons: [...document.querySelectorAll("[data-allow]")].map((x) => ({ disabled: x.disabled, title: x.title })), hint: document.querySelector("[data-allow-off]")?.textContent.trim() ?? null })`;
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "[data-allow]");
    const why = "Allow is off: there's no pilot yet.";
    const off = { disabled: true, title: why };
    assert.deepEqual(await b.evaluate(ALLOW), { buttons: [off, off, off], hint: why });
  } finally {
    server.close();
    await b?.close();
  }
});

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

/** The Promote page's headline, main text, the read failure's detail, and its buttons. */
const PROMOTE = `(() => {
  const card = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Pilot policy");
  const detail = document.querySelector("[data-unread-detail]");
  const main = document.querySelector("#main").cloneNode(true);
  // Every Detail line, which is where a raw answer goes (a retire record's too, from v0.3.19).
  main.querySelectorAll("[data-unread-detail], [data-error-detail]").forEach((e) => e.remove());
  return {
    h1: document.querySelector("h1")?.textContent.trim() ?? null,
    tag: card?.querySelector(".card-head .tag")?.textContent ?? null,
    text: main.textContent.replace(/\\s+/g, " ").trim(),
    detail: detail?.textContent.trim() ?? null,
    retry: document.querySelectorAll("[data-retry]").length,
    errBanner: !!document.querySelector(".banner-err"),
    retired: !!document.querySelector(".retired-table"),
  };
})()`;

test("the Promote page says plainly when the pilot policy wasn't read, keeps Sophos's answer out of the main text, and Retry reads again", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const unread = "Sophos API error 403: Forbidden";
  let view = { pilot, policy: null, mode: "none", plan: null, waves: [], waveSize: 25, policyUnread: unread };
  let reads = 0;
  const { server, base } = await pageServer({ "/api/status": status, [`/api/promote/${T}`]: () => (reads++, view), [`/api/retire/${T}`]: { tags: [], records } });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, "[data-retry]");
    const p = await b.evaluate(PROMOTE);
    assert.equal(p.h1, "Couldn't read the pilot policy");
    assert.equal(p.tag, "Not read");
    assert.ok(p.text.includes("The tool couldn't read the pilot policy, so it can't plan waves. That doesn't mean it's gone. Retry, or check it in Sophos Fusion."), p.text);
    assert.ok(!p.text.includes(unread) && !/403|Forbidden/.test(p.text), `no raw detail in the main text: ${p.text}`);
    assert.ok(!/Not found|no longer in the tenant|Devices that stay on classic settings/.test(p.text), p.text);
    assert.equal(p.detail, `Detail: ${unread}.`);
    assert.deepEqual([p.retry, p.errBanner, p.retired], [1, false, true], "the rest of the page is still there");
    // Retry reads it again; read this time, the card shows the policy.
    view = promo;
    const before = reads;
    await b.evaluate(`document.querySelector("[data-retry]").click(); true`);
    for (let i = 0; i < 50 && (await b.evaluate(PROMOTE)).tag !== "Off"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(reads, before + 1);
    const read = await b.evaluate(PROMOTE);
    assert.deepEqual([read.tag, read.detail, read.retry], ["Off", null, 0]);
  } finally {
    server.close();
    await b?.close();
  }
});

test("when the Promote page can't be read at all, it says so plainly with a retry instead of the raw error", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const raw = "Sophos API error 403: Forbidden";
  let fail = true;
  let reads = 0;
  const { server, base } = await failingServer({
    "/api/status": () => [200, status],
    [`/api/readiness/${T}`]: () => [404, { error: "not_found" }],
    [`/api/promote/${T}`]: () => (reads++, fail ? [500, { error: "failed", message: raw }] : [200, promo]),
    [`/api/retire/${T}`]: () => [200, { tags: [], records }],
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, "[data-retry]");
    const p = await b.evaluate(PROMOTE);
    assert.equal(p.h1, "Couldn't read the tenant");
    assert.ok(p.text.includes("The tool couldn't read the pilot, the devices or Website Management from Sophos Fusion, so there's nothing to show yet. Retry, or check the tenant in Sophos Fusion."), p.text);
    assert.ok(!/403|Forbidden/.test(p.text), `no raw detail in the main text: ${p.text}`);
    assert.equal(p.detail, `Detail: ${raw}.`);
    assert.deepEqual([p.retry, p.errBanner], [1, false]);
    // Retry: still failing, it says so again; then it reads and draws the page.
    await b.evaluate(`document.querySelector("[data-retry]").click(); true`);
    for (let i = 0; i < 50 && reads < 2; i++) await new Promise((r) => setTimeout(r, 100));
    await b.waitFor("[data-retry]:not([disabled])");
    assert.equal((await b.evaluate(PROMOTE)).h1, "Couldn't read the tenant");
    fail = false;
    await b.evaluate(`document.querySelector("[data-retry]").click(); true`);
    await b.waitFor(".retired-table");
    const read = await b.evaluate(PROMOTE);
    assert.deepEqual([read.h1, read.tag, read.detail, read.retry], ["1 of 1 devices that can use profiles are on the pilot", "Off", null, 0]);
    assert.equal(reads, 3);
  } finally {
    server.close();
    await b?.close();
  }
});
