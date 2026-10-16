// v0.3.17, as drawn in a headless Chrome or Edge (skipped without one): no
// raw answer from Sophos or the tool in the main text of a row, note, banner
// or read-back line. Each says what happened in plain words, with the raw
// answer on its own Detail line: the Promote page's Waves moved rows, the
// Build page's step rows and checks, the banners on the Credentials, setup,
// Readiness, Build, Design, Clean up, Estate, Logs and Site list cleaner
// pages, the Pilot page's Allow entries, the Readiness page's unread
// sections, and the Clean up table's reasons. A Promote re-read that fails
// after a failed action says so instead of leaving an uncaught error, an
// Allow that failed before it had a list doesn't start its sub-line with a
// stray separator, and an Allow or a wave undone after an earlier undo
// failed shows no error.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { buildScorecard } from "../backend/dist/domain/scorecard.js";
import { inventory } from "./fixtures.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const P = "66666666-6666-4666-8666-666666666666";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.17", readOnly: false };
const partnerStatus = { status: "configured-ok", mode: "partner", error: null, tenant: null, partner: { id: P, idType: "partner", label: "Example Partner", tenantCount: 1 }, version: "0.3.17", readOnly: false };
const now = new Date().toISOString();
const RAW = `Sophos API error 403: Forbidden - mock refuses this`;
const UNREAD = "Sophos API error 503: ServiceUnavailable";
const DETAIL = (raw) => `Detail: ${raw}.`;
/** Words that only come from a raw answer, never from the tool's own plain text. */
const RAW_WORDS = /Sophos API error|Forbidden|ServiceUnavailable|mock refuses|EACCES|\{/;

const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const ev = (n, endpoint, url, action, why) => ({ id: `e${n}`, type: "Event::Endpoint::WebControlViolation", name: `'${url}' ${action} due to ${why}`, created_at: now, endpoint_id: endpoint, user_id: `u${n}` });
const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([ev(1, "w1", "https://app.example.com/login", "blocked", "category 'Social Networking'"), ev(2, "w2", "https://video.example.net/", "blocked", "category 'Video Hosting'")]) };
const allow = (id, site, s, extra = {}) => ({ id, at: now, host: site, site, buildId: "b1", profileId: "pr1", listName: "Example allows", createdList: true, status: s, ...extra });
const wave = (n, s, extra = {}) => ({ id: `88888888-0000-4000-8000-00000000000${n}`, at: now, buildId: "b1", policyId: "p1", devices: [{ id: `w${n}`, hostname: `EXAMPLE-PC-0${n}` }], status: s, ...extra });
const promo = {
  pilot,
  policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 },
  mode: "devices",
  plan: { waves: [{ n: 1, devices: [{ id: "w9", hostname: "EXAMPLE-PC-09", group: "No group" }] }], inPilot: [{ id: "w1" }], notEligible: [] },
  waves: [],
  waveSize: 25,
};
const step = (order, kind, name, extra = {}) => ({ order, kind, key: kind, name, method: "POST", path: "/web-filters/v1/site-lists", summary: "1 site, block", body: {}, status: "planned", ...extra });
const pilotOptions = { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: [] } };
const design = { policies: [], profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [], flags: [], diff: [], siteLists: [], categoryActions: {} }], siteLists: [], limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
const scorecard = (over) => buildScorecard(inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" }, ...over }));
const readiness = (result) => ({ tenant: { id: T, name: "Example Tenant", region: "us01" }, result, running: false });
const result = (sc, extra = {}) => ({ readAt: now, durationMs: 4200, calls: 21, scorecard: sc, snapshot: { file: "example-tenant_20261016-010000.json", hash: "0".repeat(64), bytes: 1000 }, ...extra });
const cleanupRun = { scope: T, options: { dns: true, intelix: true }, intelixLookups: 1, running: false };
const cleanupResult = (id, site, reason, extra = {}) => ({ id, raw: site, site: { value: site }, tags: ["Example tag"], override: null, action: "block", verdict: "exception", reason, needsDecision: true, lookup: null, dns: { status: "resolves" }, ...extra });

/**
 * The frontend with an API whose routes answer as set in s.routes: a body,
 * a function of the request body, or { status, body } for an error. Every
 * route the page needs and isn't set answers 404.
 */
async function server(routes = {}) {
  const s = { status, routes: { ...routes }, headers: {} };
  const app = express();
  app.use(express.json());
  app.all("/api/*", (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(s.status);
    const route = s.routes[key];
    if (route === undefined) return res.status(404).json({ error: "not_found" });
    const out = typeof route === "function" ? route(req.body ?? {}) : route;
    for (const [k, v] of Object.entries(s.headers[key] ?? {})) res.setHeader(k, v);
    if (out?.fail) return res.status(out.fail).json({ error: "failed", message: out.message ?? RAW });
    res.json(out);
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}`, s };
}

const fail = (code = 502, message = RAW) => ({ fail: code, message });
const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__unhandled.push(String(e.message))); window.confirm = () => true; true`;
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); e.click(); return true; })()`;
/** An element's own text, and its Detail lines' text apart. */
const SPLIT = (sel) => `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return null;
  const k = e.cloneNode(true);
  const details = [...k.querySelectorAll("[data-error-detail], [data-allow-detail], [data-unread-detail], [data-toast-detail]")].map((d) => (d.remove(), d.textContent.trim()));
  return { text: k.textContent.replace(/\\s+/g, " ").trim(), details };
})()`;
const PAGE_WIDTH = `({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth })`;

async function waitFor(b, expr, what) {
  for (let i = 0; i < 100; i++) {
    const v = await b.evaluate(expr);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

test("Waves moved rows say a failure plainly, with Sophos's answer and an unread read-back on the Detail line; a wave undone after a failed undo shows none", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const waves = [
    wave(1, "failed", { error: RAW, readBack: `not read: ${UNREAD}` }),
    wave(2, "undo-failed", { error: RAW, readBack: "assignment matches" }),
    wave(3, "undone", { error: RAW, readBack: "assignment back as before the wave" }),
    wave(4, "moved", { readBack: `not read: ${UNREAD}` }),
  ];
  const { server: srv, base } = await server({ [`GET /api/promote/${T}`]: { ...promo, waves }, [`GET /api/retire/${T}`]: { tags: [], records: [] } });
  const ROWS = `(() => {
    const c = [...document.querySelectorAll(".panel-card")].find((x) => x.querySelector("h2")?.textContent === "Waves moved");
    return [...c.querySelectorAll(".wave-list li")].map((li) => ({
      devs: li.querySelector(".w-devs").textContent,
      note: li.querySelector(".err-note")?.textContent ?? null,
      detail: li.querySelector("[data-error-detail]")?.textContent ?? null,
      inside: li.getBoundingClientRect().right <= c.getBoundingClientRect().right + 0.5,
    }));
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/promote.html?tenant=${T}`, width, ".wave-list li .w-devs");
      assert.deepEqual(
        await b.evaluate(ROWS),
        [
          { devs: "EXAMPLE-PC-01. Read back: not read", note: "The move didn't finish.", detail: `Detail: ${UNREAD}. ${RAW}.`, inside: true },
          { devs: "EXAMPLE-PC-02. Read back: assignment matches", note: "The undo didn't finish. Undo again, or check the pilot in Sophos Fusion.", detail: DETAIL(RAW), inside: true },
          { devs: "EXAMPLE-PC-03. Read back: assignment back as before the wave", note: null, detail: null, inside: true },
          { devs: "EXAMPLE-PC-04. Read back: not read", note: null, detail: DETAIL(UNREAD), inside: true },
        ],
        `${width} px`,
      );
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

test("Build step rows and checks say a failure plainly, with the raw answer on the Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const rec = {
    id: "00000001-0000-4000-a000-000000000000", tenantId: T, createdAt: now, status: "partial", snapshotFile: "example-tenant_20261016-010000.json", pilot: pilotOptions,
    steps: [step(1, "site-list", "Example Block", { status: "created", id: "l1", readBack: "matches" }), step(2, "profile", "Example profile", { status: "failed", error: RAW })],
    checks: [
      { ok: false, level: "fail", text: "Couldn't check the targets.", detail: RAW },
      // As a build saved before v0.3.17 kept it.
      { ok: false, level: "fail", text: "No rollback snapshot could be saved, so nothing was built. EACCES: permission denied, open 'data/snapshots/x.json'" },
      { ok: true, level: "ok", text: "Profiles: 0 in the account, 1 to add, limit 20." },
    ],
  };
  const { server: srv, base } = await server({ [`GET /api/design/${T}`]: { design, genAi: {} }, [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] }, [`GET /api/build/${T}`]: { items: [rec] } });
  const READ = `(() => ({
    steps: [...document.querySelectorAll(".steps-list li")].map((li) => ({ sum: li.querySelector(".s-sum").textContent.trim(), note: li.querySelector(".err-note")?.textContent ?? null, detail: li.querySelector("[data-error-detail]")?.textContent ?? null })),
    checks: [...document.querySelectorAll(".check-list li")].map((li) => { const k = li.cloneNode(true); const d = k.querySelector("[data-error-detail]"); d?.remove(); return { text: k.textContent.trim(), detail: d?.textContent ?? null }; }),
  }))()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/build.html?tenant=${T}`, width, ".steps-list li");
      assert.deepEqual(await b.evaluate(READ), {
        steps: [
          { sum: "1 site, block. Read back: matches", note: null, detail: null },
          { sum: "1 site, block", note: "This step failed, so the build stopped here.", detail: DETAIL(RAW) },
        ],
        checks: [
          { text: "Couldn't check the targets.", detail: DETAIL(RAW) },
          { text: "No rollback snapshot could be saved, so nothing was built.", detail: "Detail: EACCES: permission denied, open 'data/snapshots/x.json'." },
          { text: "Profiles: 0 in the account, 1 to add, limit 20.", detail: null },
        ],
      }, `${width} px`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

test("banners say what failed in plain words, with the raw answer on the banner's Detail line", { skip: skipBrowser, timeout: 240_000 }, async () => {
  const { server: srv, base, s } = await server();
  const intelixView = { configured: false, clientId: "", clientSecretMasked: "", region: "au" };
  const credentials = { mode: "tenant", tenant: { configured: true, clientId: "mock-client-id", clientSecretMasked: "••••cret", label: "Example Tenant" }, partner: { configured: false } };
  const fill = `(() => { const f = document.querySelector("#f"); f.clientId.value = "mock-client-id"; f.clientSecret.value = "mock-client-secret"; const x = document.querySelector("#ix"); x.clientId.value = "mock-intelix-id"; x.clientSecret.value = "mock-intelix-secret"; return true; })()`;
  const credsRoutes = { "GET /api/credentials": credentials, "GET /api/intelix": intelixView };
  // Each: the page, what it waits for, the API as the case sets it, any steps, then the banner and its plain words.
  const cases = [
    { name: "Credentials: Test", url: "/credentials.html", ready: "#test", routes: { ...credsRoutes, "POST /api/credentials/test": fail(400) }, steps: [fill, click("#test")], banner: "#out .banner", text: "The credential didn't connect." },
    { name: "Credentials: Save, refused", url: "/credentials.html", ready: "#save", routes: { ...credsRoutes, "PUT /api/credentials": { ok: true, status: { ...status, status: "configured-invalid", error: RAW } } }, steps: [fill, click("#save")], banner: "#out .banner", text: "Saved, but the credential didn't connect." },
    { name: "Credentials: Save, failed", url: "/credentials.html", ready: "#save", routes: { ...credsRoutes, "PUT /api/credentials": fail(500) }, steps: [fill, click("#save")], banner: "#out .banner", text: "Couldn't save the credential." },
    { name: "Credentials: Intelix Test", url: "/credentials.html", ready: "#ix-test", routes: { ...credsRoutes, "POST /api/intelix/test": fail(400) }, steps: [fill, click("#ix-test")], banner: "#ix-out .banner", text: "Intelix didn't issue a token." },
    { name: "Credentials: Intelix Save", url: "/credentials.html", ready: "#ix-save", routes: { ...credsRoutes, "PUT /api/intelix": fail(500) }, steps: [fill, click("#ix-save")], banner: "#ix-out .banner", text: "Couldn't save the Intelix credential." },
    { name: "Credentials: the saved credential doesn't connect", url: "/credentials.html", ready: "#main .banner-err", status: { ...status, status: "configured-invalid", error: RAW, tenant: null }, routes: credsRoutes, banner: "#main .banner-err", text: "The saved credential didn't connect." },
    { name: "Credentials: the page can't be read", url: "/credentials.html", ready: "#main .banner-err", routes: { "GET /api/credentials": fail(500), "GET /api/intelix": intelixView }, banner: "#main .banner-err", text: "Couldn't read the saved credentials." },
    { name: "Setup: Test", url: "/welcome.html", ready: "#to-2", routes: { "POST /api/credentials/test": fail(400) }, steps: [click("#to-2"), `(() => { const f = document.querySelector("#cred-form"); f.clientId.value = "mock-client-id"; f.clientSecret.value = "mock-client-secret"; return true; })()`, click("#test")], banner: "#test-result .banner", text: "The credential didn't connect." },
    { name: "Setup: Save, refused", url: "/welcome.html", ready: "#to-2", routes: { "POST /api/credentials/test": { ok: true, idType: "tenant", tenant }, "PUT /api/credentials": { ok: true, status: { ...status, status: "configured-invalid", error: RAW } } }, steps: [click("#to-2"), `(() => { const f = document.querySelector("#cred-form"); f.clientId.value = "mock-client-id"; f.clientSecret.value = "mock-client-secret"; return true; })()`, click("#test"), `(async () => { for (let i = 0; i < 50 && document.querySelector("#to-3").disabled; i++) await new Promise((r) => setTimeout(r, 100)); document.querySelector("#to-3").click(); return true; })()`, click("#save")], banner: "#review .banner-err", text: "Saved, but the credential didn't connect." },
    { name: "Readiness: Run", url: `/readiness.html?tenant=${T}`, ready: "#run", routes: { [`GET /api/readiness/${T}`]: readiness(null), [`POST /api/readiness/${T}/run`]: fail(502) }, steps: [click("#run")], banner: "#main .banner-err", text: "The check didn't finish." },
    { name: "Readiness: load", url: `/readiness.html?tenant=${T}`, ready: "#main .banner-err", routes: { [`GET /api/readiness/${T}`]: fail(404) }, banner: "#main .banner-err", text: "Couldn't read the readiness check for this tenant." },
    { name: "Build: load", url: `/build.html?tenant=${T}`, ready: "#main .banner-err", routes: { [`GET /api/design/${T}`]: fail(502), [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] }, [`GET /api/build/${T}`]: { items: [] } }, banner: "#main .banner-err", text: "Couldn't read the design and pilot targets." },
    { name: "Design: load", url: `/design.html?tenant=${T}`, ready: "#main .banner-err", routes: { [`GET /api/design/${T}`]: fail(502) }, banner: "#main .banner-err", text: "Couldn't read the classic policies." },
    { name: "Clean up: load", url: `/cleanup.html?tenant=${T}`, ready: "#main .banner-err", routes: { [`GET /api/cleanup/${T}`]: fail(500) }, banner: "#main .banner-err", text: "Couldn't read the clean-up." },
    { name: "Clean up: the run didn't finish", url: `/cleanup.html?tenant=${T}`, ready: "#main .banner-err", routes: { [`GET /api/cleanup/${T}`]: { run: { ...cleanupRun, error: RAW }, intelix: true } }, banner: "#main .banner-err", text: "The clean-up didn't finish." },
    { name: "Clean up: Intelix refused the lookups", url: `/cleanup.html?tenant=${T}`, ready: "#main .banner-warn", routes: { [`GET /api/cleanup/${T}`]: { run: { ...cleanupRun, intelixError: "Intelix refused the credential (401: invalid_client)." }, intelix: true } }, banner: "#main .banner-warn", text: "Intelix refused the lookups, so the remaining entries weren't looked up.", raw: "Intelix refused the credential (401: invalid_client)." },
    { name: "Estate: load", url: "/estate.html", ready: "#main .banner-err", status: partnerStatus, routes: { "GET /api/estate": fail(500) }, banner: "#main .banner-err", text: "Couldn't read the estate." },
    { name: "Logs: load", url: "/logs.html", ready: "#main .banner-err", routes: { "GET /api/logs": fail(500), "GET /api/audit": { items: [] } }, banner: "#main .banner-err", text: "Couldn't read the logs." },
    { name: "Site list cleaner: load", url: "/site-list-cleaner.html", ready: "#main .banner-err", routes: { "GET /api/presets": { items: [] }, "GET /api/cleaner": fail(500) }, banner: "#main .banner-err", text: "Couldn't open the site list cleaner." },
  ];
  let b;
  try {
    b = await openBrowser();
    // Every case runs, and each one that doesn't give its plain banner is listed.
    const wrong = [];
    for (const c of cases) {
      s.status = c.status ?? status;
      s.routes = c.routes;
      try {
        await b.open(`${base}${c.url}`, 1440, c.ready);
        await b.evaluate(WATCH);
        for (const st of c.steps ?? []) await b.evaluate(st);
        const got = await waitFor(b, SPLIT(c.banner), `the banner on ${c.name}`);
        const unhandled = await b.evaluate("window.__unhandled");
        const want = { text: c.text, details: [DETAIL(c.raw?.replace(/\.$/, "") ?? RAW)] };
        if (JSON.stringify(got) !== JSON.stringify(want) || RAW_WORDS.test(got.text) || unhandled.length) wrong.push({ case: c.name, got, unhandled });
      } catch (err) {
        wrong.push({ case: c.name, error: err.message });
      }
    }
    assert.deepEqual(wrong, []);
  } finally {
    srv.close();
    await b?.close();
  }
});

test("on Promote, a re-read that fails after a failed action says so plainly and leaves nothing uncaught", { skip: skipBrowser, timeout: 60_000 }, async () => {
  let reads = 0;
  const { server: srv, base, s } = await server({ [`GET /api/promote/${T}`]: () => (reads++, promo), [`GET /api/retire/${T}`]: { tags: [], records: [] }, [`POST /api/promote/${T}/enabled`]: fail(503, "Sophos refused the credential (401): Client ID is invalid.") });
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/promote.html?tenant=${T}`, width, "#toggle");
      await b.evaluate(WATCH);
      s.routes[`GET /api/promote/${T}`] = fail(503, "Sophos refused the credential (401): Client ID is invalid.");
      await b.evaluate(click("#toggle"));
      const note = await waitFor(b, SPLIT("[data-reread-failed]"), "the re-read note");
      assert.deepEqual(note, { text: "Couldn't read the tenant The tool couldn't read the pilot, the devices or Website Management, so the page still shows what it read before. Retry, or check the tenant in Sophos Fusion. Retry", details: ["Detail: Sophos refused the credential (401): Client ID is invalid."] }, `${width} px`);
      assert.deepEqual(await b.evaluate("window.__unhandled"), [], `${width} px: nothing uncaught`);
      assert.ok(await b.evaluate(`!!document.querySelector("#toggle")`), `${width} px: the page still shows what it read before`);
      // Retry reads it again, and once the read works the note goes.
      s.routes[`GET /api/promote/${T}`] = () => (reads++, promo);
      await b.evaluate(click("[data-reread]"));
      await waitFor(b, `!document.querySelector("[data-reread-failed]")`, "the note to go");
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

test("Allow entries: no stray separator before a failed Allow's date, an unread read-back says 'not read' with why on the Detail line, and an Allow undone after a failed undo shows no error", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const allows = [
    allow("a1", "chat.example.org", "failed", { listName: "", createdList: false, error: RAW }),
    allow("a2", "files.example.com", "added", { readBack: `not read: ${UNREAD}` }),
    allow("a3", "video.example.net", "undone", { readBack: "site listed", error: RAW }),
  ];
  const view = { pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: allows.map((a) => ({ ...a, buildStatus: "built" })) };
  const entry = allow("a4", "app.example.com", "added", { readBack: `not read: ${UNREAD}` });
  const plan = { pilot, host: "app.example.com", site: "app.example.com", steps: [{ op: "add-site", listId: "l1", listName: "Example allows", site: "app.example.com" }], problems: [], notes: [] };
  const { server: srv, base } = await server({ [`GET /api/pilot/${T}`]: view, [`GET /api/pilot/${T}/digest`]: digest, [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun === false ? { dryRun: false, plan, entry } : { dryRun: true, plan }) });
  const day = new Date(now).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const ROWS = `(() => {
    const c = [...document.querySelectorAll(".panel-card")].find((x) => x.querySelector("h2")?.textContent === "Allow entries");
    return [...c.querySelectorAll(".order-list li")].map((li) => ({ sub: li.querySelector(".o-kind").textContent, note: li.querySelector(".o-note")?.textContent ?? null, detail: li.querySelector("[data-allow-detail]")?.textContent ?? null, inside: li.getBoundingClientRect().right <= c.getBoundingClientRect().right + 0.5 }));
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-allow]");
      assert.deepEqual(
        await b.evaluate(ROWS),
        [
          { sub: day, note: "The Allow didn't finish.", detail: DETAIL(RAW), inside: true },
          { sub: `Example allows · ${day} · not read`, note: null, detail: DETAIL(UNREAD), inside: true },
          { sub: `Example allows · ${day} · site listed`, note: null, detail: null, inside: true },
        ],
        `${width} px`,
      );
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
    // The toast after an Allow whose read-back couldn't read the list.
    await b.evaluate(click('[data-allow="app.example.com"]'));
    await waitFor(b, `document.querySelector("#allow-go")`, "the dry run");
    await b.evaluate(click("#allow-go"));
    const toast = await waitFor(b, SPLIT(".toast"), "the toast");
    assert.deepEqual(toast, { text: "Allowed app.example.com: not read.", details: [DETAIL(UNREAD)] });
  } finally {
    srv.close();
    await b?.close();
  }
});

test("the Readiness page keeps Sophos's answer for an unread section, an unreadable tenant and a snapshot not saved on the Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const refused = { ok: false, status: 403, error: RAW };
  const some = scorecard({ localSites: refused, profiles: refused });
  const none = buildScorecard(Object.fromEntries(Object.entries(inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" } })).map(([k, v]) => [k, v && typeof v === "object" && "ok" in v ? refused : v])));
  const { server: srv, base, s } = await server({ [`GET /api/readiness/${T}`]: readiness(result(some, { snapshot: null, snapshotError: "EACCES: permission denied, open 'data/snapshots/x.json'" })) });
  const READ = `(() => {
    const strip = (e) => { const k = e.cloneNode(true); const d = [...k.querySelectorAll("[data-error-detail]")].map((x) => (x.remove(), x.textContent.trim())); return { text: k.textContent.replace(/\\s+/g, " ").trim(), details: d }; };
    return {
      lead: document.querySelector(".page-lead").textContent,
      unread: [...document.querySelectorAll('.score-item[data-id^="unread"]')].map(strip),
      snapshot: strip(document.querySelector(".snapshot-bar p")),
    };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      s.routes[`GET /api/readiness/${T}`] = readiness(result(some, { snapshot: null, snapshotError: "EACCES: permission denied, open 'data/snapshots/x.json'" }));
      await b.open(`${base}/readiness.html?tenant=${T}`, width, ".snapshot-bar");
      const got = await b.evaluate(READ);
      assert.deepEqual(got.unread.map((u) => u.details), [[DETAIL(RAW)], [DETAIL(RAW)]], `${width} px`);
      for (const u of got.unread) assert.ok(!RAW_WORDS.test(u.text) && /are skipped\./.test(u.text), `${width} px: ${u.text}`);
      assert.deepEqual(got.snapshot, { text: "No rollback snapshot. It couldn't be saved.", details: ["Detail: EACCES: permission denied, open 'data/snapshots/x.json'."] }, `${width} px`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
    // Every read refused: the summary says so plainly, and the one item has the answer on its Detail line.
    s.routes[`GET /api/readiness/${T}`] = readiness(result(none, { snapshot: null }));
    await b.open(`${base}/readiness.html?tenant=${T}`, 1440, ".snapshot-bar");
    assert.equal(await b.evaluate(`document.querySelector(".page-lead").textContent`), "Every read was refused (403).");
    assert.deepEqual(await b.evaluate(SPLIT('.score-item[data-id="unreadable"]')), { text: "The API credential can't read this tenant What to do: Check the credential's role and that the tenant's licenses include Sophos Endpoint. A partner credential needs access to the tenant. Requirements", details: [DETAIL(RAW)] });
  } finally {
    srv.close();
    await b?.close();
  }
});

test("the Clean up table says a failed lookup plainly in Why, with what Intelix answered on the Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const lookupError = "Intelix answered 500: InternalServerError.";
  const results = [
    cleanupResult("r1", "app.example.com", `No SophosLabs category (${lookupError}); kept until you decide.`, { lookupError }),
    cleanupResult("r2", "files.example.com", "No SophosLabs category looked up; kept until you decide."),
  ];
  const view = { run: cleanupRun, results, summary: { total: 2, covered: 0, remove: 0, exception: 2, needsDecision: 2 }, lists: [], leftOut: 0, lastLists: null, intelix: true };
  const { server: srv, base } = await server({ [`GET /api/cleanup/${T}`]: view });
  const WHY = `[...document.querySelectorAll(".cu-table tbody tr")].map((tr) => { const k = tr.querySelector(".cu-why").cloneNode(true); const d = k.querySelector("[data-error-detail]"); d?.remove(); return { why: k.textContent.trim(), detail: d?.textContent ?? null }; })`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/cleanup.html?tenant=${T}`, width, ".cu-table tbody tr");
      assert.deepEqual(await b.evaluate(WHY), [
        { why: "No SophosLabs category (the lookup failed); kept until you decide.", detail: `Detail: ${lookupError}` },
        { why: "No SophosLabs category looked up; kept until you decide.", detail: null },
      ], `${width} px`);
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

test("a warning that an audit entry couldn't be written keeps its error codes on the toast's detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server: srv, base, s } = await server({ [`GET /api/promote/${T}`]: promo, [`GET /api/retire/${T}`]: { tags: [], records: [] }, [`POST /api/promote/${T}/enabled`]: { enabled: true, readBack: "matches" } });
  s.headers[`POST /api/promote/${T}/enabled`] = { "X-Audit-Warning": "The audit entry for this change couldn't be written to data/audit.log, usually because OneDrive or antivirus held the file. The change itself is unaffected; the Logs page has the entry.", "X-Audit-Warning-Detail": "EBUSY" };
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, "#toggle");
    await b.evaluate(WATCH);
    await b.evaluate(click("#toggle"));
    await waitFor(b, `document.querySelectorAll(".toast").length >= 2`, "two toasts");
    const toasts = await b.evaluate(`[...document.querySelectorAll(".toast")].map((e) => { const k = e.cloneNode(true); const d = k.querySelector("[data-toast-detail]"); d?.remove(); return { text: k.textContent.trim(), detail: d?.textContent ?? null }; })`);
    assert.deepEqual(toasts.find((t) => /audit entry/.test(t.text)), { text: "The audit entry for this change couldn't be written to data/audit.log, usually because OneDrive or antivirus held the file. The change itself is unaffected; the Logs page has the entry.", detail: "Detail: EBUSY." });
  } finally {
    srv.close();
    await b?.close();
  }
});
