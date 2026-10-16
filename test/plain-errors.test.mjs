// Guard, from v0.3.17, as drawn in a headless Chrome or Edge (skipped without
// one): no raw answer reaches the main text of a page. Every page is opened
// with an API whose answers carry a marked raw answer from Sophos: first with
// every read failing, then with every record carrying it in each field that
// holds an error, then with every action failing. After each, the page's
// text, less its Detail lines (any element marked data-...-detail) and the
// Logs page's server log (raw on purpose), must not hold the raw answer, and
// nothing may be left uncaught. Where a page shows the answer, it's on a
// Detail line. From v0.3.18 the actions are also answered, with the raw
// answer in the answer's fields (a snapshot that couldn't be saved, a site
// list that failed, an Allow whose list couldn't be read back, the builds
// list unread after a build), and the customer report is read the same way.
// From v0.3.19 the answers include every write whose read-back couldn't read
// (a wave recorded as moved with a read-back that wasn't read, which v0.3.18
// drew as "Wave moved. Read back: ..." with the raw answer in it, the pilot
// switch, a wave undo, a rollback, the clean-up's lists, a retire and a
// restore), and the records carry the raw answer in every read-back field.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { buildScorecard } from "../backend/dist/domain/scorecard.js";
import { renderReport } from "../backend/dist/domain/report.js";
import { inventory } from "./fixtures.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const P = "66666666-6666-4666-8666-666666666666";
/** The mark: a raw answer as Sophos gives one, with a word the tool never writes itself. */
const MARK = "zq7xraw";
const RAW = `Sophos API error 503: ServiceUnavailable - ${MARK}`;
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.17", readOnly: false };
const partnerStatus = { ...status, mode: "partner", tenant: null, partner: { id: P, idType: "partner", label: "Example Partner", tenantCount: 1 } };
const now = new Date().toISOString();
const id = (n) => `88888888-0000-4000-8000-00000000000${n}`;

// ---------- records whose every error field carries the raw answer ----------

const unfinished = { at: now, reason: RAW, left: [{ kind: "policy", name: "WF pilot: Example profile" }] };
const pilot = { buildId: "b1", buildStatus: "rollback-partial", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] }, rollbackUnfinished: unfinished };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const ev = (n, url) => ({ id: `e${n}`, type: "Event::Endpoint::WebControlViolation", name: `'${url}' blocked due to category 'Chat'`, created_at: now, endpoint_id: "w1", user_id: `u${n}` });
const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([ev(1, "https://app.example.com/"), ev(2, "https://chat.example.org/")]) };
const allow = (n, s, extra) => ({ id: id(n), at: now, host: `h${n}.example.com`, site: `h${n}.example.com`, buildId: "b1", profileId: "pr1", listName: "Example allows", createdList: true, status: s, buildStatus: "built", ...extra });
const store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: true, runs: [{ at: now, source: "api", ok: false, pages: 0, fetched: 0, web: 0, added: 0, error: RAW }] } };
const pilotView = { pilot, policy, store, allows: [allow(1, "failed", { listName: "", error: RAW }), allow(2, "undo-failed", { error: RAW }), allow(3, "undone", { error: RAW }), allow(4, "added", { readBack: `not read: ${RAW}` }), allow(5, "undo-failed", { readBack: "site listed", undoReadBack: `not read: ${RAW}`, error: "The list couldn't be read back, so the removal isn't confirmed." }), allow(6, "added", { readBack: `not read: ${RAW}; profile links it as allow` })] };
const wave = (n, s, extra) => ({ id: id(n), at: now, buildId: "b1", policyId: "p1", devices: [{ id: `w${n}`, hostname: `EXAMPLE-PC-0${n}` }], status: s, ...extra });
const promo = {
  pilot,
  policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 },
  mode: "devices",
  plan: { waves: [{ n: 1, devices: [{ id: "w9", hostname: "EXAMPLE-PC-09", group: "No group" }] }], inPilot: [{ id: "w1" }], notEligible: [] },
  waves: [wave(1, "failed", { error: RAW, readBack: `not read: ${RAW}` }), wave(2, "undo-failed", { error: RAW }), wave(3, "undone", { error: RAW }), wave(4, "moved", { readBack: `not read: ${RAW}` }), wave(5, "undo-failed", { readBack: "assignment matches", undoReadBack: `not read: ${RAW}`, error: "The tool couldn't read the pilot policy back, so the undo isn't confirmed." })],
  waveSize: 25,
};
const retireStep = (extra) => ({ op: "delete-entry", url: "blocked.example.com", tags: ["Example tag"], ...extra });
const retire = { tags: [{ tag: "Example tag", entries: 1, only: 1, policies: [] }], records: [{ id: id(5), tenantId: T, at: now, tags: ["Example tag"], snapshotFile: "example-tenant_20261016-010000.json", status: "partial", steps: [retireStep({ status: "failed", error: RAW })], warnings: [] }, { id: id(6), tenantId: T, at: now, tags: ["Example tag"], snapshotFile: "example-tenant_20261016-010000.json", status: "restore-partial", steps: [retireStep({ status: "restore-failed", readBack: `not read: ${RAW}`, error: "The tool couldn't read it back, so the restore isn't confirmed." })], warnings: [] }] };
const step = (order, kind, extra) => ({ order, kind, key: kind, name: `Example ${kind}`, method: "POST", path: "/web-filters/v1/site-lists", summary: "1 site, block", body: {}, status: "planned", ...extra });
const build = {
  id: "00000001-0000-4000-a000-000000000000", tenantId: T, createdAt: now, status: "partial", snapshotFile: "example-tenant_20261016-010000.json",
  pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: [] } },
  steps: [step(1, "site-list", { status: "created", id: "l1", readBack: "matches" }), step(2, "profile", { status: "failed", error: RAW }), step(3, "site-list", { status: "created", id: "l3", readBack: "not-read", readBackNote: RAW }), step(4, "policy", { status: "delete-failed", id: "p4", deleteReadBack: `not read: ${RAW}` })],
  checks: [{ ok: false, level: "fail", text: "Couldn't check the targets.", detail: RAW }, { ok: false, level: "fail", text: `Couldn't check the targets: ${RAW}` }, { ok: false, level: "fail", text: `No rollback snapshot could be saved, so nothing was built. ${RAW}` }],
};
const design = { policies: [], profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [{ id: "p0", name: "Base Policy", type: "web-control" }], flags: [], diff: [], siteLists: [], categoryActions: {} }], siteLists: [], limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
const refused = { ok: false, status: 503, error: RAW };
const readiness = (over, extra = {}) => ({ tenant: { id: T, name: "Example Tenant", region: "us01" }, running: false, result: { readAt: now, durationMs: 4200, calls: 21, scorecard: buildScorecard(inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" }, ...over })), snapshot: null, snapshotError: RAW, ...extra } });
const everySectionRefused = Object.fromEntries(Object.entries(inventory()).filter(([, v]) => v && typeof v === "object" && "ok" in v).map(([k]) => [k, refused]));
const lookupError = `Intelix answered 503: ${MARK}.`;
const cleanupView = (scope) => ({
  run: { scope, options: { dns: true, intelix: true }, intelixLookups: 1, running: false, error: RAW, intelixError: RAW },
  results: [{ id: "r1", raw: "app.example.com", site: { value: "app.example.com" }, tags: ["Example tag"], override: null, action: "block", verdict: "exception", reason: `No SophosLabs category (${lookupError}); kept until you decide.`, lookupError, needsDecision: true, lookup: null, dns: { status: "resolves" } }],
  summary: { total: 1, covered: 0, remove: 0, exception: 1, needsDecision: 1 },
  lists: [{ name: "Example cleaned block", action: "block", sites: 1 }],
  leftOut: 0,
  lastLists: { lists: [{ name: "Example cleaned block", status: "created" }] },
  intelix: true,
});
const estate = { partnerId: P, startedAt: now, finishedAt: now, durationMs: 1000, concurrency: 2, running: false, total: 1, done: 1, calls: 3, rows: [{ tenantId: T, name: "Example Tenant", region: "us01", status: "error", error: RAW }] };
const credentials = { mode: "tenant", tenant: { configured: true, clientId: "mock-client-id", clientSecretMasked: "••••cret", label: "Example Tenant" }, partner: { configured: false } };
const intelixView = { configured: true, clientId: "mock-intelix-id", clientSecretMasked: "••••cret", region: "au" };

/** Every read the pages make, answered with the records above. */
const READS = {
  "GET /api/credentials": credentials,
  "GET /api/intelix": intelixView,
  [`GET /api/readiness/${T}`]: readiness({ localSites: refused, profiles: refused }),
  [`GET /api/cleanup/${T}`]: cleanupView(T),
  "GET /api/cleaner": cleanupView("cleaner"),
  "GET /api/presets": { items: [{ name: "keep-it-clean", label: "Keep it clean" }] },
  [`GET /api/design/${T}`]: { design, genAi: {} },
  [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
  [`GET /api/build/${T}`]: { items: [build] },
  [`GET /api/pilot/${T}`]: pilotView,
  [`GET /api/pilot/${T}/digest`]: digest,
  [`GET /api/promote/${T}`]: promo,
  [`GET /api/retire/${T}`]: retire,
  "GET /api/estate": estate,
  "GET /api/logs": { items: [{ ts: now, level: "warn", section: "pilot", message: `SIEM collection failed: ${RAW}` }] },
  "GET /api/audit": { items: [{ ts: now, tenantId: T, action: "update", resourceId: "p1", ok: false, error: RAW }] },
};

// ---------- the pages and what's done on them ----------

const TENANT_PAGES = ["readiness", "cleanup", "design", "build", "pilot", "promote"].map((p) => `/${p}.html?tenant=${T}`);
const PAGES = [...TENANT_PAGES, "/site-list-cleaner.html", "/credentials.html", "/logs.html", "/help.html", "/estate.html"];
/** What each page shows once it has drawn the records. */
const DRAWN = {
  [`/readiness.html?tenant=${T}`]: ".snapshot-bar",
  [`/cleanup.html?tenant=${T}`]: ".cu-table",
  [`/design.html?tenant=${T}`]: ".profile-card",
  [`/build.html?tenant=${T}`]: ".steps-list",
  [`/pilot.html?tenant=${T}`]: ".order-list",
  [`/promote.html?tenant=${T}`]: ".wave-list",
  "/site-list-cleaner.html": ".cu-table",
  "/credentials.html": "#f",
  "/logs.html": ".logs-table",
  "/help.html": "#main h1",
  "/estate.html": ".estate-table",
};
/** Where a page puts what an action answered: a toast, or a banner. */
const ANSWERED = ".toast, #out .banner, #ix-out .banner, #test-result .banner, #main > .banner-err";

const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); e.click(); return true; })()`;
const change = (sel, value) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("change")); return true; })()`;
const fillCredentials = `(() => { const f = document.querySelector("#f"); f.clientId.value = "mock-client-id"; f.clientSecret.value = "mock-client-secret"; const x = document.querySelector("#ix"); x.clientId.value = "mock-intelix-id"; x.clientSecret.value = "mock-intelix-secret"; return true; })()`;
/** Each action that writes, by page, as steps in the page. Every write answers with the raw answer. */
const ACTIONS = {
  [`/readiness.html?tenant=${T}`]: [[click("#rerun")], [click("#pdf")]],
  [`/cleanup.html?tenant=${T}`]: [[click("#run")], [change(".cu-decision", "remove")], [click("#create-lists")], [click("#undo-lists")]],
  [`/design.html?tenant=${T}`]: [[change("[data-genai]", "block")]],
  [`/build.html?tenant=${T}`]: [[click("#dry")], [click("[data-rollback]")], [click("[data-diff]")]],
  [`/pilot.html?tenant=${T}`]: [[click("#collect")], [click("#schedule")], [click("[data-allow]")], [click("[data-undo]")]],
  [`/promote.html?tenant=${T}`]: [[click("#toggle")], [click("[data-wave]")], [click("[data-undo-wave]")], [click('input[name="tag"]'), click("#plan-retire")], [click("[data-restore]")], [click("[data-diff]")]],
  "/site-list-cleaner.html": [[`(() => { document.querySelector("#text").value = "app.example.com"; return true; })()`, click("#go")]],
  "/credentials.html": [[fillCredentials, click("#test")], [fillCredentials, click("#save")], [fillCredentials, click("#ix-test")], [fillCredentials, click("#ix-save")]],
  "/estate.html": [[click("#scan")]],
  "/welcome.html": [[click("#to-2"), `(() => { const f = document.querySelector("#cred-form"); f.clientId.value = "mock-client-id"; f.clientSecret.value = "mock-client-secret"; return true; })()`, click("#test")]],
};

/**
 * Each action that writes and is answered, with the raw answer in a field of
 * its answer: by page, the steps, and the answers the writes (and any read
 * after them) get.
 */
const dryRec = { ...build, status: "dry-run", steps: build.steps.map((st) => ({ ...st, status: "planned", error: undefined, readBack: undefined })), checks: [{ ok: true, level: "ok", text: "Profiles: 0 in the account, 1 to add, limit 20." }] };
const builtRec = { ...build, status: "built", steps: build.steps.map((st) => ({ ...st, status: "created", error: undefined, readBack: "matches" })), checks: dryRec.checks };
const ANSWERS = [
  { page: `/readiness.html?tenant=${T}`, steps: [click("#rerun")], writes: { [`POST /api/readiness/${T}/run`]: { tenant: readiness({}).tenant, result: readiness({}).result } } },
  {
    page: `/build.html?tenant=${T}`,
    steps: [click("#dry"), click("#go")],
    answers: () => {
      let built = false;
      return {
        reads: { [`GET /api/build/${T}`]: () => (built ? { fail: true } : { items: [build] }) },
        writes: { [`POST /api/build/${T}/dry-run`]: dryRec, [`POST /api/build/${T}/execute`]: () => ((built = true), builtRec) },
      };
    },
  },
  {
    page: `/cleanup.html?tenant=${T}`,
    steps: [click("#create-lists")],
    writes: { [`POST /api/cleanup/${T}/lists`]: (body) => (body.dryRun ? { lists: [{ name: "Example cleaned block", action: "block", sites: ["app.example.com"] }], problems: [], leftOut: 0 } : { tenantId: T, scope: T, createdAt: now, lists: [{ name: "Example cleaned block", action: "block", sites: 1, status: "failed", error: RAW }] }) },
  },
  {
    page: `/pilot.html?tenant=${T}`,
    steps: [click("[data-allow]"), click("#allow-go")],
    writes: { [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun ? { plan: { host: "app.example.com", site: "app.example.com", pilot, steps: [{ op: "add-site", listId: "l1", listName: "Example allows", site: "app.example.com" }], problems: [], notes: [] } } : { plan: {}, entry: allow(9, "added", { readBack: `not read: ${RAW}` }) }) },
  },
  { page: `/pilot.html?tenant=${T}`, steps: [click('[data-undo="' + id(4) + '"]')], writes: { [`POST /api/pilot/${T}/allow/${id(4)}/undo`]: allow(4, "undo-failed", { undoReadBack: `not read: ${RAW}`, error: "The list couldn't be read back, so the removal isn't confirmed." }) } },
  // The shape v0.3.18 drew as "Wave moved. Read back: not read: ..." with the raw answer in the message.
  { page: `/promote.html?tenant=${T}`, steps: [click("[data-wave]")], writes: { [`POST /api/promote/${T}/wave`]: (body) => (body.dryRun ? { problems: [], policyName: pilot.policyName, before: { endpoints: ["w1"], endpointGroups: [] }, after: { endpoints: ["w1", "w9"], endpointGroups: [] }, devices: [{ id: "w9", hostname: "EXAMPLE-PC-09" }], enabled: false } : wave(9, "moved", { readBack: `not read: ${RAW}` })) } },
  { page: `/promote.html?tenant=${T}`, steps: [click("#toggle")], writes: { [`POST /api/promote/${T}/enabled`]: { enabled: true, readBack: `not read: ${RAW}` } } },
  { page: `/promote.html?tenant=${T}`, steps: [click(`[data-undo-wave="${id(4)}"]`)], writes: { [`POST /api/promote/${T}/wave/${id(4)}/undo`]: wave(4, "undo-failed", { undoReadBack: `not read: ${RAW}`, error: "The tool couldn't read the pilot policy back, so the undo isn't confirmed." }) } },
  { page: `/promote.html?tenant=${T}`, steps: [click('input[name="tag"]'), click("#plan-retire"), click("#go-retire")], writes: { [`POST /api/retire/${T}/plan`]: { tags: ["Example tag"], steps: [{ op: "delete-entry", url: "blocked.example.com", tags: ["Example tag"] }], problems: [], warnings: [] }, [`POST /api/retire/${T}/execute`]: { ...retire.records[0], status: "failed", steps: [retireStep({ status: "failed", readBack: `not read: ${RAW}`, error: "The tool couldn't read it back, so the change isn't confirmed." })] } } },
  { page: `/promote.html?tenant=${T}`, steps: [click("[data-restore]")], writes: { [`POST /api/retire/${T}/${id(5)}/restore`]: retire.records[1] } },
  { page: `/build.html?tenant=${T}`, steps: [click("[data-rollback]")], writes: { [`POST /api/build/${T}/${build.id}/rollback`]: (body) => (body.dryRun ? { ...build, restorePlan: [] } : { ...build, status: "rollback-partial", rollback: { at: now, steps: [{ kind: "policy", name: "WF pilot: Example profile", status: "not confirmed", error: `A read-back couldn't read it (${RAW}), so it may still be there.` }] } }) } },
  { page: `/cleanup.html?tenant=${T}`, steps: [click("#create-lists")], writes: { [`POST /api/cleanup/${T}/lists`]: (body) => (body.dryRun ? { lists: [{ name: "Example cleaned block", action: "block", sites: ["app.example.com"] }], problems: [], leftOut: 0 } : { tenantId: T, scope: T, createdAt: now, lists: [{ name: "Example cleaned block", action: "block", sites: 1, id: "l1", status: "created", readBack: `not read: ${RAW}` }] }) } },
  { page: `/cleanup.html?tenant=${T}`, steps: [click("#undo-lists")], writes: { [`POST /api/cleanup/${T}/lists`]: { tenantId: T, scope: T, createdAt: now, lists: [{ name: "Example cleaned block", action: "block", sites: 1, id: "l1", status: "not confirmed", readBack: `not read: ${RAW}` }] } } },
];

/** The frontend, with an API that answers reads from s.reads (or fails them all) and fails every write with the raw answer. */
async function server() {
  const s = { status, readsFail: false, reads: READS, writes: {} };
  const app = express();
  app.use(express.json());
  app.all("/api/*", (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(s.status);
    // An answer can be a function of the request body; { fail: true } from one is a failure with the raw answer.
    const answer = req.method === "GET" ? (!s.readsFail ? s.reads[key] : undefined) : s.writes[key];
    const out = typeof answer === "function" ? answer(req.body ?? {}) : answer;
    if (out !== undefined && !out?.fail) return res.json(out);
    res.status(502).json({ error: "failed", message: RAW });
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}`, s };
}

/** Caught from the first script on: anything uncaught on the page. */
const WATCH = `window.__uncaught = []; window.addEventListener("unhandledrejection", (e) => window.__uncaught.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__uncaught.push(String(e.message))); window.confirm = () => true;`;

/** The page's text less its Detail lines and the Logs page's server log, and the text of its Detail lines. */
const LOOK = `(() => {
  const isDetail = (e) => [...e.attributes].some((a) => /^data-[\\w-]*detail$/.test(a.name));
  const k = document.body.cloneNode(true);
  for (const e of [...k.querySelectorAll("*")]) if (isDetail(e) || e.matches(".logs-table")) e.remove();
  return {
    main: k.textContent.replace(/\\s+/g, " "),
    details: [...document.querySelectorAll("*")].filter(isDetail).map((e) => e.textContent).join(" "),
    uncaught: window.__uncaught ?? [],
    busy: !!document.querySelector("#main .spinner"),
  };
})()`;

/** Waits until the page has settled (no spinner in the main area), then looks. */
async function settle(b) {
  let look;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    look = await b.evaluate(LOOK);
    if (!look.busy) break;
  }
  await new Promise((r) => setTimeout(r, 150));
  return b.evaluate(LOOK);
}

/** What's wrong with what the page shows: the raw answer in its main text, or something uncaught. */
function problems(look, where) {
  const out = [];
  const at = look.main.indexOf(MARK);
  if (at >= 0) out.push(`${where}: the raw answer is in the main text: "...${look.main.slice(Math.max(0, at - 120), at + 20)}..."`);
  if (/Sophos API error/.test(look.main)) out.push(`${where}: "Sophos API error" is in the main text`);
  if (look.uncaught.length) out.push(`${where}: uncaught: ${look.uncaught.join("; ")}`);
  return out;
}

/** Text doesn't change with the width, so the pages are read at one; the v0.3.17 page tests check phone width. */
async function open(b, url, drawn = "body") {
  await b.open(url, 1440, drawn);
  return settle(b);
}

test("no page puts a raw answer in its main text, whether the reads fail, the records carry one, or the actions fail", { skip: skipBrowser, timeout: 300_000 }, async () => {
  const { server: srv, base, s } = await server();
  let b;
  try {
    b = await openBrowser();
    await b.call("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
    const wrong = [];
    const statusFor = (page) => (page === "/estate.html" ? partnerStatus : status);

    // Every read fails: each page says so plainly, with the answer on a Detail line.
    s.readsFail = true;
    for (const page of PAGES) {
      s.status = statusFor(page);
      const look = await open(b, `${base}${page}`);
      wrong.push(...problems(look, `reads fail, ${page}`));
      if (page !== "/help.html" && !look.details.includes(MARK)) wrong.push(`reads fail, ${page}: the answer isn't on a Detail line`);
    }

    // Every record carries the answer in its error fields.
    s.readsFail = false;
    const variants = [
      // Design, Help and the saved credential have no error field; the estate keeps a tenant's error in its tag's tooltip, and the Logs page in its server log.
      ...PAGES.map((page) => ({ page, shows: ![`/design.html?tenant=${T}`, "/help.html", "/credentials.html", "/estate.html", "/logs.html"].includes(page) })),
      // The pilot policy wasn't read, and Pilot devices only couldn't be read.
      { page: `/pilot.html?tenant=${T}`, reads: { [`GET /api/pilot/${T}`]: { ...pilotView, policy: null, policyUnread: RAW }, [`GET /api/pilot/${T}/digest`]: { ...digest, pilotUnread: RAW } } },
      { page: `/promote.html?tenant=${T}`, reads: { [`GET /api/promote/${T}`]: { ...promo, policy: null, plan: null, policyUnread: RAW } } },
      // Nothing in the tenant could be read.
      { page: `/readiness.html?tenant=${T}`, reads: { [`GET /api/readiness/${T}`]: readiness(everySectionRefused) } },
      // The saved credential doesn't connect.
      { page: "/credentials.html", status: { ...status, status: "configured-invalid", error: RAW, tenant: null } },
    ];
    for (const v of variants) {
      s.status = v.status ?? statusFor(v.page);
      s.reads = { ...READS, ...(v.reads ?? {}) };
      const where = `records, ${v.page}${v.reads || v.status ? " (variant)" : ""}`;
      try {
        const look = await open(b, `${base}${v.page}`, DRAWN[v.page]);
        wrong.push(...problems(look, where));
        if (v.shows !== false && !look.details.includes(MARK)) wrong.push(`${where}: the answer isn't on a Detail line`);
      } catch (err) {
        wrong.push(`${where}: ${err.message}`);
      }
    }
    s.reads = READS;

    // Every action fails.
    for (const [page, actions] of Object.entries(ACTIONS)) {
      s.status = statusFor(page);
      for (const steps of actions) {
        await open(b, `${base}${page}`);
        for (const st of steps) {
          await b.evaluate(st);
          await new Promise((r) => setTimeout(r, 200));
        }
        try {
          await b.waitFor(ANSWERED);
        } catch {
          wrong.push(`action fails, ${page}: no toast or banner after ${steps[steps.length - 1].slice(0, 90)}`);
        }
        const look = await settle(b);
        const where = `action fails, ${page}, ${steps[steps.length - 1].slice(0, 90)}`;
        wrong.push(...problems(look, where));
        if (!look.details.includes(MARK)) wrong.push(`${where}: the answer isn't on a Detail line`);
      }
    }

    // Every action answered, with the raw answer in a field of its answer.
    for (const a of ANSWERS) {
      const { reads = {}, writes = a.writes } = a.answers?.() ?? {};
      s.status = statusFor(a.page);
      s.reads = { ...READS, ...reads };
      s.writes = writes;
      const where = `action answered, ${a.page}, ${a.steps[a.steps.length - 1].slice(0, 90)}`;
      await open(b, `${base}${a.page}`);
      for (const st of a.steps) {
        await b.evaluate(st);
        await new Promise((r) => setTimeout(r, 300));
      }
      try {
        await b.waitFor(".toast");
      } catch {
        wrong.push(`${where}: no toast`);
      }
      const look = await settle(b);
      wrong.push(...problems(look, where));
      // The toast itself says what happened, with the answer on its own Detail line.
      const toastDetail = await b.evaluate(`[...document.querySelectorAll(".toast")].pop()?.querySelector("[data-toast-detail]")?.textContent ?? ""`);
      if (!toastDetail.includes(MARK)) wrong.push(`${where}: the toast doesn't carry the answer on its Detail line`);
    }
    s.reads = READS;
    s.writes = {};
    assert.deepEqual(wrong, []);
  } finally {
    srv.close();
    await b?.close();
  }
});

test("the customer report puts no raw answer in its main text, whether some sections or every one couldn't be read", () => {
  for (const [what, over] of [["some sections unread", { localSites: refused, profiles: refused }], ["nothing read", everySectionRefused]]) {
    const r = readiness(over).result;
    const html = renderReport({ ...r, tenant: readiness(over).tenant }, { generatedAt: now, toolVersion: "0.3.18" });
    const body = html.slice(html.indexOf("<body>"));
    const detail = /<p class="detail" data-error-detail>[\s\S]*?<\/p>/g;
    const main = body.replace(detail, "");
    assert.ok(!main.includes(MARK) && !/Sophos API error/.test(main), `${what}: the raw answer is in the report's main text`);
    assert.ok((body.match(detail) ?? []).some((d) => d.includes(MARK)), `${what}: the answer is on a Detail line`);
  }
});
