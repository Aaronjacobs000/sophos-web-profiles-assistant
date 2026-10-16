// v0.3.16, as drawn in a headless Chrome or Edge (skipped without one): the
// Pilot page's Collection card and Allow entries rows say plainly when
// something failed, with the raw answer on a separate Detail line; a failed
// action on the Promote, Build, Clean up, Site list cleaner, Estate, Design
// and Readiness pages says so in plain words in its toast, with the raw answer
// on the toast's detail line; and toasts hide the page behind them.

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
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.16", readOnly: false };
const partnerStatus = { status: "configured-ok", mode: "partner", error: null, tenant: null, partner: { id: P, idType: "partner", label: "Example Partner", tenantCount: 1 }, version: "0.3.16", readOnly: false };
const now = new Date().toISOString();
const RAW = `Sophos API error 403: {"error":"Forbidden","message":"mock refuses this write"}`;
const UNREAD = "Sophos API error 403: Forbidden";
const DETAIL = (raw) => `Detail: ${raw}.`;
/** Words that only come from a raw answer, never from the tool's own plain text. */
const RAW_WORDS = /\b(401|403|500|503)\b|Sophos API error|Forbidden|mock refuses|\{/;

// The Pilot page.
const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const ev = (n, endpoint, url, action, why) => ({ id: `e${n}`, type: "Event::Endpoint::WebControlViolation", name: `'${url}' ${action} due to ${why}`, created_at: now, endpoint_id: endpoint, user_id: `u${n}` });
const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([ev(1, "w1", "https://app.example.com/login", "blocked", "category 'Social Networking'"), ev(3, "w2", "https://chat.example.org/", "blocked", "category 'Chat'")]) };
const allow = (id, site, s, extra = {}) => ({ id, at: now, host: site, site, buildId: "b1", profileId: "pr1", listName: "Example pilot allows", createdList: true, status: s, ...extra });
const allows = [
  allow("a1", "chat.example.org", "failed", { error: RAW }),
  allow("a2", "app.example.com", "undo-failed", { readBack: "site listed", error: "Sophos API error 500: InternalServerError" }),
  allow("a3", "video.example.net", "undone", { readBack: "site listed", error: UNREAD }),
  allow("a4", "files.example.com", "added", { readBack: "site listed" }),
];

// The Promote page.
const promo = {
  pilot,
  policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 },
  mode: "devices",
  plan: { waves: [{ n: 1, devices: [{ id: "w2", hostname: "EXAMPLE-PC-02", group: "No group" }] }], inPilot: [{ id: "w1" }], notEligible: [] },
  waves: [{ id: "88888888-0000-4000-8000-000000000001", at: now, buildId: "b1", policyId: "p1", devices: [{ id: "w1", hostname: "EXAMPLE-PC-01" }], status: "moved", readBack: "assignment matches" }],
  waveSize: 25,
};
const retireRecord = { id: "77777777-0000-4000-8000-000000000001", tenantId: T, at: now, tags: ["Example tag"], snapshotFile: "example-tenant_20261016-010000.json", status: "retired", steps: [], warnings: [] };
const retire = { tags: [{ tag: "Example tag", entries: 1, only: 1, policies: [] }], records: [retireRecord] };

// The Build page.
const step = (order, kind, name) => ({ order, kind, key: kind, name, method: "POST", path: "/web-filters/v1/site-lists", summary: "", body: {}, status: "planned" });
const pilotOptions = { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: [] } };
const dryRunRec = { id: "00000002-0000-4000-a000-000000000000", tenantId: T, createdAt: now, status: "dry-run", pilot: pilotOptions, steps: [step(1, "site-list", "Example Block")], checks: [{ ok: true, level: "ok", text: "Profiles: 0 in the account, 1 to add, limit 20." }] };
const builtRec = { ...dryRunRec, id: "00000001-0000-4000-a000-000000000000", createdAt: "2026-10-15T01:00:00.000Z", status: "built", snapshotFile: "example-tenant_20261015-010000.json", steps: [{ ...step(1, "site-list", "Example Block"), status: "created", id: "l1" }] };

// The Clean up page and the site list cleaner.
const result = { id: "r1", raw: "blocked.example.com", site: { value: "blocked.example.com" }, tags: ["Example tag"], override: null, action: "block", verdict: "exception", reason: "The profile allows this category.", needsDecision: false, lookup: null, dns: { status: "resolves" } };
const cleanupView = (scope) => ({
  run: { scope, options: { dns: true, intelix: false }, intelixLookups: 0, running: false },
  results: [result],
  summary: { total: 1, covered: 0, remove: 0, exception: 1, needsDecision: 0 },
  lists: [{ name: "Example cleaned block", action: "block", sites: 1 }],
  leftOut: 0,
  lastLists: { lists: [{ name: "Example cleaned block", status: "created" }] },
  intelix: false,
});

// The Design page.
const design = {
  policies: [{ policyId: "p0", policyName: "Base Policy", skipped: null }],
  profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [{ id: "p0", name: "Base Policy", type: "web-control" }], flags: [], diff: [], siteLists: [], categoryActions: {} }],
  siteLists: [],
  limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } },
  cleanedUp: false,
  warnings: [],
};

/**
 * The frontend with an API whose actions answer as set: each route answers
 * its body, or, while its key is in s.fail, a 502 with Sophos's raw answer.
 */
async function server() {
  const s = { mode: "tenant", fail: new Set(), store: null, allows, waveResult: null, undoResult: null };
  const routes = {
    "GET /api/status": () => (s.mode === "partner" ? partnerStatus : status),
    [`GET /api/readiness/${T}`]: () => ({ tenant: { id: T, name: "Example Tenant", region: "us01" }, result: { readAt: now, durationMs: 4200, calls: 21, scorecard: buildScorecard(inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" } })), snapshot: { file: "example-tenant_20261016-010000.json", hash: "0".repeat(64), bytes: 1000 } }, running: false }),
    [`GET /api/report/${T}.pdf`]: () => ({}),
    [`GET /api/pilot/${T}`]: () => ({ pilot, policy, store: s.store ?? { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: s.allows.map((a) => ({ ...a, buildStatus: "built" })) }),
    [`GET /api/pilot/${T}/digest`]: () => digest,
    [`PUT /api/pilot/${T}/schedule`]: (b) => ({ tenantId: T, enabled: b.enabled === true, runs: [] }),
    [`GET /api/promote/${T}`]: () => promo,
    [`GET /api/retire/${T}`]: () => retire,
    [`POST /api/promote/${T}/enabled`]: (b) => ({ enabled: b.enabled, readBack: "matches" }),
    [`POST /api/promote/${T}/wave`]: (b) => (b.dryRun === false ? s.waveResult ?? { status: "moved", readBack: "assignment matches" } : { problems: [], policyName: pilot.policyName, before: { endpoints: ["w1"] }, after: { endpoints: ["w1", "w2"] }, devices: [{ id: "w2", hostname: "EXAMPLE-PC-02" }], enabled: false }),
    [`POST /api/promote/${T}/wave/${promo.waves[0].id}/undo`]: () => s.undoResult ?? { status: "undone", readBack: "assignment matches" },
    [`POST /api/retire/${T}/plan`]: () => ({ tags: ["Example tag"], steps: [], problems: [], warnings: [] }),
    [`POST /api/retire/${T}/execute`]: () => ({ ...retireRecord }),
    [`POST /api/retire/${T}/${retireRecord.id}/restore`]: () => ({ ...retireRecord, status: "restored" }),
    [`POST /api/diff/${T}`]: () => ({ matches: true, sections: [] }),
    [`GET /api/design/${T}`]: () => ({ design, genAi: {} }),
    [`PUT /api/design/${T}`]: (b) => ({ design, genAi: b.genAi }),
    [`GET /api/pilot-targets/${T}`]: () => ({ endpoints: [], endpointGroups: [], userGroups: [] }),
    [`GET /api/build/${T}`]: () => ({ items: [dryRunRec, builtRec] }),
    [`POST /api/build/${T}/dry-run`]: () => dryRunRec,
    [`POST /api/build/${T}/execute`]: () => ({ ...builtRec, status: "built" }),
    [`POST /api/build/${T}/${builtRec.id}/rollback`]: () => ({ ...builtRec, status: "rolled-back", restorePlan: [] }),
    [`GET /api/cleanup/${T}`]: () => cleanupView(T),
    [`PUT /api/cleanup/${T}/decisions`]: () => cleanupView(T),
    [`POST /api/cleanup/${T}/run`]: () => ({ running: true, total: 1 }),
    [`POST /api/cleanup/${T}/lists`]: () => ({ lists: [{ name: "Example cleaned block", action: "block", sites: ["blocked.example.com"] }], problems: [] }),
    "GET /api/cleaner": () => cleanupView("cleaner"),
    "GET /api/presets": () => ({ items: [{ name: "keep-it-clean", label: "Keep it clean" }] }),
    "POST /api/cleaner/classify": () => cleanupView("cleaner"),
    "GET /api/estate": () => ({ partnerId: P, startedAt: null, finishedAt: null, durationMs: null, concurrency: 0, running: false, total: 1, done: 0, calls: 0, rows: [{ tenantId: T, name: "Example Tenant", region: "us01", status: "queued" }] }),
    "POST /api/estate/scan": () => ({}),
  };
  const app = express();
  app.use(express.json());
  app.all("/api/*", (req, res) => {
    const key = `${req.method} ${req.path}`;
    const route = routes[key];
    if (!route) return res.status(404).json({ error: "not_found" });
    if (s.fail.has(key)) return res.status(502).json({ error: "failed", message: RAW });
    res.json(route(req.body ?? {}));
  });
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
const PAGE_WIDTH = `({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth })`;
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); e.click(); return true; })()`;

/** Waits until a toast shows, for up to 10 s, and returns the toasts. */
async function toasts(b) {
  for (let i = 0; i < 100; i++) {
    const t = await b.evaluate(TOASTS);
    if (t.length) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("No toast showed.");
}

test("the Collection card says a failed collection plainly, with the raw answer on a separate Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server: srv, base, s } = await server();
  s.store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [{ at: now, source: "api", ok: false, pages: 0, fetched: 0, web: 0, added: 0, error: UNREAD }] } };
  const CARD = `(() => {
    const c = [...document.querySelectorAll(".panel-card")].find((x) => x.querySelector("h2")?.textContent === "Collection");
    const k = c.cloneNode(true);
    const d = k.querySelector("[data-collect-detail]");
    d?.remove();
    const line = [...k.querySelectorAll("p.hint")].find((p) => p.textContent.startsWith("Last collection")).textContent.replace(/\\s+/g, " ").trim();
    return { line, detail: d?.textContent.trim() ?? null };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "#schedule");
      const card = await b.evaluate(CARD);
      assert.deepEqual(card, { line: "Last collection: just now, failed. For a schedule without the tool open, run npm run collect daily.", detail: DETAIL(UNREAD) }, `${width} px`);
      assert.ok(!RAW_WORDS.test(card.line), `${width} px: no raw answer in the plain line`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
    // A collection that worked has no Detail line.
    s.store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [{ at: now, source: "api", ok: true, pages: 1, fetched: 5, web: 3, added: 2 }] } };
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "#schedule");
    assert.deepEqual(await b.evaluate(CARD), { line: "Last collection: just now, 2 new of 3 web events. For a schedule without the tool open, run npm run collect daily.", detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});

test("Allow entries rows say a failure plainly, with the raw answer on a separate Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server: srv, base } = await server();
  const ROWS = `(() => {
    const c = [...document.querySelectorAll(".panel-card")].find((x) => x.querySelector("h2")?.textContent === "Allow entries");
    return [...c.querySelectorAll(".order-list li")].map((li) => ({
      site: li.querySelector(".o-name").firstChild.textContent,
      kind: li.querySelector(".o-kind").textContent,
      note: li.querySelector(".o-note")?.textContent ?? null,
      detail: li.querySelector("[data-allow-detail]")?.textContent ?? null,
      inside: li.getBoundingClientRect().right <= c.getBoundingClientRect().right + 0.5,
    }));
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [1440, 390]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "[data-undo]");
      const rows = await b.evaluate(ROWS);
      assert.deepEqual(
        rows.map(({ site, note, detail, inside }) => ({ site, note, detail, inside })),
        [
          { site: "chat.example.org", note: "The Allow didn't finish.", detail: DETAIL(RAW), inside: true },
          { site: "app.example.com", note: "The undo didn't finish. Undo again, or check the list in Sophos Fusion.", detail: DETAIL("Sophos API error 500: InternalServerError"), inside: true },
          { site: "video.example.net", note: "An earlier undo didn't finish.", detail: DETAIL(UNREAD), inside: true },
          { site: "files.example.com", note: null, detail: null, inside: true },
        ],
        `${width} px`,
      );
      for (const r of rows) assert.ok(!RAW_WORDS.test(r.kind) && !RAW_WORDS.test(r.note ?? ""), `${width} px, ${r.site}: no raw answer in the row's own text`);
      const page = await b.evaluate(PAGE_WIDTH);
      assert.equal(page.scrollWidth, page.width, `${width} px: no sideways scroll`);
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

test("a failed action on the other pages says so in plain words in its toast, with the raw answer on the detail line", { skip: skipBrowser, timeout: 180_000 }, async () => {
  const { server: srv, base, s } = await server();
  const promote = `${base}/promote.html?tenant=${T}`;
  const build = `${base}/build.html?tenant=${T}`;
  // Each: the page and what it waits for, what fails, any step before the action, the action, and the toast it should give.
  const cases = [
    { name: "Promote: turn the pilot on", url: promote, ready: "#toggle", fail: `POST /api/promote/${T}/enabled`, act: click("#toggle"), text: "Couldn't turn the pilot on." },
    { name: "Promote: move a wave, refused", url: promote, ready: "[data-wave]", fail: `POST /api/promote/${T}/wave`, act: click("[data-wave]"), text: "Couldn't move wave 1." },
    { name: "Promote: move a wave, failed", url: promote, ready: "[data-wave]", set: { waveResult: { status: "failed", error: RAW } }, act: click("[data-wave]"), text: "Couldn't move wave 1." },
    { name: "Promote: undo a wave, refused", url: promote, ready: "[data-undo-wave]", fail: `POST /api/promote/${T}/wave/${promo.waves[0].id}/undo`, act: click("[data-undo-wave]"), text: "Couldn't undo the wave." },
    { name: "Promote: undo a wave, failed", url: promote, ready: "[data-undo-wave]", set: { undoResult: { status: "undo-failed", error: RAW } }, act: click("[data-undo-wave]"), text: "Couldn't undo the wave." },
    { name: "Promote: retire dry run", url: promote, ready: "#plan-retire", fail: `POST /api/retire/${T}/plan`, before: `document.querySelector('input[name="tag"]').click(); true`, act: click("#plan-retire"), text: "Couldn't run the dry run." },
    { name: "Promote: retire", url: promote, ready: "#plan-retire", fail: `POST /api/retire/${T}/execute`, before: `(async () => { document.querySelector('input[name="tag"]').click(); document.querySelector("#plan-retire").click(); for (let i = 0; i < 50 && !document.querySelector("#go-retire"); i++) await new Promise((r) => setTimeout(r, 100)); return true; })()`, act: click("#go-retire"), text: "Couldn't retire the tags." },
    { name: "Promote: restore", url: promote, ready: "[data-restore]", fail: `POST /api/retire/${T}/${retireRecord.id}/restore`, act: click("[data-restore]"), text: "Couldn't restore the tags." },
    { name: "Promote: compare with snapshot", url: promote, ready: "[data-diff]", fail: `POST /api/diff/${T}`, act: click("[data-diff]"), text: "Couldn't compare with the snapshot." },
    { name: "Build: dry run", url: build, ready: "#dry", fail: `POST /api/build/${T}/dry-run`, act: click("#dry"), text: "Couldn't run the dry run." },
    { name: "Build: build", url: build, ready: "#go:not([disabled])", fail: `POST /api/build/${T}/execute`, act: click("#go"), text: "Couldn't build the pilot." },
    { name: "Build: roll back", url: build, ready: "[data-rollback]", fail: `POST /api/build/${T}/${builtRec.id}/rollback`, act: click("[data-rollback]"), text: "Couldn't roll back the build." },
    { name: "Build: compare with snapshot", url: build, ready: "[data-diff]", fail: `POST /api/diff/${T}`, act: click("[data-diff]"), text: "Couldn't compare with the snapshot." },
    { name: "Clean up: run", url: `${base}/cleanup.html?tenant=${T}`, ready: "#run", fail: `POST /api/cleanup/${T}/run`, act: click("#run"), text: "Couldn't start the clean-up." },
    { name: "Clean up: decide", url: `${base}/cleanup.html?tenant=${T}`, ready: ".cu-decision", fail: `PUT /api/cleanup/${T}/decisions`, act: `(() => { const s = document.querySelector(".cu-decision"); s.value = "remove"; s.dispatchEvent(new Event("change")); return true; })()`, text: "Couldn't save the decision." },
    { name: "Clean up: create site lists", url: `${base}/cleanup.html?tenant=${T}`, ready: "#create-lists", fail: `POST /api/cleanup/${T}/lists`, act: click("#create-lists"), text: "Couldn't create the site lists." },
    { name: "Clean up: undo site lists", url: `${base}/cleanup.html?tenant=${T}`, ready: "#undo-lists", fail: `POST /api/cleanup/${T}/lists`, act: click("#undo-lists"), text: "Couldn't undo the site lists." },
    { name: "Site list cleaner: classify", url: `${base}/site-list-cleaner.html`, ready: "#go", fail: "POST /api/cleaner/classify", act: `(() => { document.querySelector("#text").value = "blocked.example.com"; document.querySelector("#go").click(); return true; })()`, text: "Couldn't classify the sites." },
    { name: "Estate: scan", mode: "partner", url: `${base}/estate.html`, ready: "#scan", fail: "POST /api/estate/scan", act: click("#scan"), text: "Couldn't start the scan." },
    { name: "Design: Generative AI choice", url: `${base}/design.html?tenant=${T}`, ready: "[data-genai]", fail: `PUT /api/design/${T}`, act: `(() => { const s = document.querySelector("[data-genai]"); s.value = "block"; s.dispatchEvent(new Event("change")); return true; })()`, text: "Couldn't save the Generative AI choice." },
    { name: "Readiness: PDF", url: `${base}/readiness.html?tenant=${T}`, ready: "#pdf", fail: `GET /api/report/${T}.pdf`, act: click("#pdf"), text: "Couldn't make the PDF." },
  ];
  let b;
  try {
    b = await openBrowser();
    // Every case runs, and each one that doesn't give its plain toast is listed.
    const wrong = [];
    for (const c of cases) {
      Object.assign(s, { mode: c.mode ?? "tenant", fail: new Set(), waveResult: null, undoResult: null }, c.set ?? {});
      await b.open(c.url, 1440, c.ready);
      await b.evaluate(WATCH);
      if (c.before) await b.evaluate(c.before);
      if (c.fail) s.fail.add(c.fail);
      await b.evaluate(c.act);
      const [t] = await toasts(b);
      const unhandled = await b.evaluate(`window.__unhandled`);
      if (t.text !== c.text || t.detail !== DETAIL(RAW) || RAW_WORDS.test(t.text) || unhandled.length) wrong.push({ case: c.name, toast: t, unhandled });
    }
    assert.deepEqual(wrong, []);
  } finally {
    srv.close();
    await b?.close();
  }
});

test("toasts are fully opaque, so nothing on the page shows through, whatever color scheme the browser prefers", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server: srv, base } = await server();
  // The toast's background and opacity, and every ancestor's opacity, once it has settled.
  const LOOK = `(async () => {
    await new Promise((r) => setTimeout(r, 600));
    const t = document.querySelector(".toast");
    const cs = getComputedStyle(t);
    const alpha = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); const p = m[1].split(/[ ,\\/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
    const ancestors = []; for (let e = t; e; e = e.parentElement) ancestors.push(Number(getComputedStyle(e).opacity));
    return { background: alpha(cs.backgroundColor), opacity: Math.min(...ancestors) };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const scheme of ["dark", "light"]) {
      for (const width of [1440, 390]) {
        await b.open(`${base}/pilot.html?tenant=${T}`, width, "#schedule");
        await b.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] });
        await b.evaluate(click("#schedule"));
        await toasts(b);
        assert.deepEqual(await b.evaluate(LOOK), { background: 1, opacity: 1 }, `${scheme}, ${width} px`);
      }
    }
  } finally {
    srv.close();
    await b?.close();
  }
});
