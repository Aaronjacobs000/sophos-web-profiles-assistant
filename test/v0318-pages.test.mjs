// v0.3.18, as drawn in a headless Chrome or Edge (skipped without one): each
// toast says what actually happened. Readiness says when the snapshot
// couldn't be saved, or wasn't taken; Build says the build worked when only
// the list read after it failed; Create site lists says which list failed and
// why; an Allow whose read-back didn't confirm it isn't a green success. And
// the Clean up table keeps its site column wide enough to read at 390 px.

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
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.18", readOnly: false };
const now = new Date().toISOString();
const RAW = "Sophos API error 503: ServiceUnavailable - mock refuses this";
const DETAIL = `Detail: ${RAW}.`;

/**
 * The frontend with an API whose routes answer as set: a body, a function of
 * the request body, or { fail } for an error with the raw answer. Every route
 * not set answers 404.
 */
async function server(routes) {
  const app = express();
  app.use(express.json());
  app.all("/api/*", (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(status);
    const route = routes[key];
    if (route === undefined) return res.status(404).json({ error: "not_found" });
    const out = typeof route === "function" ? route(req.body ?? {}) : route;
    if (out?.fail) return res.status(out.fail).json({ error: "failed", message: RAW });
    res.json(out);
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}` };
}

const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__unhandled.push(String(e.message))); window.confirm = () => true; true`;
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); e.click(); return true; })()`;
/** The newest toast: its kind, its main text and its Detail line apart. */
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

/** Opens a page, runs the steps, and gives back the toast they end with. */
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

// ---------- item 3: Readiness ----------

const result = (extra) => ({ tenant: { id: T, name: "Example Tenant", region: "us01" }, readAt: now, durationMs: 4200, calls: 21, scorecard: buildScorecard(inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" } })), snapshot: null, ...extra });

test("Readiness says what happened to the snapshot: saved, couldn't be saved (why on the Detail line), or not taken because nothing could be read", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const answers = {
    saved: result({ snapshot: { file: "example-tenant_20261017-010000.json", hash: "0".repeat(64), bytes: 1000 } }),
    unsaved: result({ snapshotError: RAW }),
    unreadable: { ...result({}), scorecard: { ...result({}).scorecard, verdict: "unreadable" } },
  };
  let answer = "saved";
  const { server: srv, base } = await server({
    [`GET /api/readiness/${T}`]: { tenant: { id: T, name: "Example Tenant", region: "us01" }, result: null, running: false },
    [`POST /api/readiness/${T}/run`]: () => ({ tenant: { id: T, name: "Example Tenant", region: "us01" }, result: answers[answer] }),
  });
  let b;
  try {
    b = await openBrowser();
    const run = async (which) => {
      answer = which;
      return toastAfter(b, `${base}/readiness.html?tenant=${T}`, "#run", [click("#run")]);
    };
    assert.deepEqual(await run("saved"), { kind: "toast-ok", text: "Check finished. Snapshot saved.", detail: null });
    assert.deepEqual(await run("unsaved"), { kind: "toast-warn", text: "Check finished, but the rollback snapshot couldn't be saved.", detail: DETAIL });
    assert.deepEqual(await run("unreadable"), { kind: "toast-warn", text: "Check finished, but the tenant couldn't be read, so no snapshot was saved.", detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 4: Build ----------

const pilotOptions = { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: [] } };
const design = { policies: [], profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [], flags: [], diff: [], siteLists: [], categoryActions: {} }], siteLists: [], limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
const step = (order, kind, name, extra = {}) => ({ order, kind, key: kind, name, method: "POST", path: kind === "policy" ? "/endpoint/v1/policies" : "/web-filters/v1/profiles", summary: "", body: {}, status: "planned", ...extra });
const buildRecord = (s, extra = {}) => ({ id: "00000001-0000-4000-a000-000000000000", tenantId: T, createdAt: now, status: s, pilot: pilotOptions, steps: [step(1, "profile", "Example profile", extra.steps), step(2, "policy", "WF pilot: Example profile", extra.steps)], checks: [{ ok: true, level: "ok", text: "Profiles: 0 in the account, 1 to add, limit 20." }] });

test("Build says the build worked when only the read of the builds list after it failed, with why on the Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const set = { execute: "ok", list: "ok" };
  let reads = 0;
  const { server: srv, base } = await server({
    [`GET /api/design/${T}`]: { design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
    // The page reads the list once as it opens; the read after the build is the one that can fail.
    [`GET /api/build/${T}`]: () => (++reads > 1 && set.list === "fail" ? { fail: 500 } : { items: reads > 1 ? [buildRecord("built", { steps: { status: "created", readBack: "matches" } })] : [] }),
    [`POST /api/build/${T}/dry-run`]: buildRecord("dry-run"),
    [`POST /api/build/${T}/execute`]: () => (set.execute === "fail" ? { fail: 502 } : buildRecord("built", { steps: { status: "created", readBack: "matches" } })),
  });
  let b;
  try {
    b = await openBrowser();
    const build = async (execute, list) => {
      Object.assign(set, { execute, list });
      reads = 0;
      return toastAfter(b, `${base}/build.html?tenant=${T}`, "#dry", [click("#dry"), { until: `!document.querySelector("#go").disabled` }, click("#go")]);
    };
    assert.deepEqual(await build("ok", "fail"), { kind: "toast-warn", text: "Built and read back. The list of builds couldn't be read again, so it doesn't show this build yet.", detail: DETAIL });
    assert.equal(await b.evaluate(`document.querySelector("h1").textContent`), "Built 2 objects", "the page shows what the build did");
    assert.deepEqual(await build("ok", "ok"), { kind: "toast-ok", text: "Built and read back.", detail: null });
    assert.deepEqual(await build("fail", "ok"), { kind: "toast-warn", text: "Couldn't build the pilot.", detail: DETAIL });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- items 5 and 7: Clean up ----------

const LISTS = ["Example cleaned allow", "Example cleaned block", "Example cleaned warn"];
const cleanupResult = (n, site) => ({ id: `r${n}`, raw: site, site: { value: site }, tags: ["Example tag"], override: null, action: "block", verdict: "exception", reason: "No SophosLabs category looked up; kept until you decide.", needsDecision: true, lookup: null, dns: { status: "resolves" } });
const SITES = ["app.example.com", "files.example.net", "downloads.eu-west.storage-example.cloudapp.example.net"];
const cleanupView = (scope) => ({
  run: { scope, options: { dns: true, intelix: false }, intelixLookups: 0, running: false },
  results: SITES.map((s, i) => cleanupResult(i + 1, s)),
  summary: { total: 3, covered: 0, remove: 0, exception: 3, needsDecision: 3 },
  lists: LISTS.map((name) => ({ name, action: "block", sites: 1 })),
  leftOut: 0,
  intelix: false,
});

test("Create site lists says which list failed and that the rest weren't sent, with what Sophos answered on the Detail line", { skip: skipBrowser, timeout: 60_000 }, async () => {
  let made = 0;
  const { server: srv, base } = await server({
    [`GET /api/cleanup/${T}`]: cleanupView(T),
    [`POST /api/cleanup/${T}/lists`]: (body) =>
      body.dryRun
        ? { lists: LISTS.map((name) => ({ name, action: "block", sites: ["app.example.com"] })), problems: [], leftOut: 0 }
        : { tenantId: T, scope: T, createdAt: now, lists: [...LISTS.slice(0, made).map((name, i) => ({ name, action: "block", sites: 1, id: `l${i}`, status: "created", readBack: "matches" })), ...(made < LISTS.length ? [{ name: LISTS[made], action: "block", sites: 1, status: "failed", error: RAW }] : [])] },
  });
  let b;
  try {
    b = await openBrowser();
    const create = async (n) => {
      made = n;
      return toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#create-lists", [click("#create-lists")]);
    };
    assert.deepEqual(await create(0), { kind: "toast-warn", text: `No site lists created. Creating "${LISTS[0]}" failed, so the 2 lists after it weren't sent.`, detail: DETAIL });
    assert.deepEqual(await create(1), { kind: "toast-warn", text: `1 of 3 site lists created and read back. Creating "${LISTS[1]}" failed, so the list after it wasn't sent.`, detail: DETAIL });
    assert.deepEqual(await create(2), { kind: "toast-warn", text: `2 of 3 site lists created and read back. Creating "${LISTS[2]}" failed.`, detail: DETAIL });
    assert.deepEqual(await create(3), { kind: "toast-ok", text: "3 site lists created and read back.", detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});

test("the Clean up table keeps its site column wide enough to read, at 390 px and on the desktop, on both pages that show it", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server: srv, base } = await server({
    [`GET /api/cleanup/${T}`]: cleanupView(T),
    "GET /api/cleaner": cleanupView("cleaner"),
    "GET /api/presets": { items: [{ name: "keep-it-clean", label: "Keep it clean" }] },
  });
  const CELLS = `[...document.querySelectorAll(".cu-table tbody tr")].map((tr) => {
    const td = tr.querySelector("td.cu-site");
    const name = td.querySelector("b");
    const lines = Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight));
    return { site: name.textContent, width: Math.round(td.getBoundingClientRect().width), lines };
  })`;
  let b;
  try {
    b = await openBrowser();
    for (const url of [`/cleanup.html?tenant=${T}`, "/site-list-cleaner.html"]) {
      for (const width of [390, 1440]) {
        await b.open(`${base}${url}`, width, ".cu-table tbody tr");
        const cells = await b.evaluate(CELLS);
        for (const c of cells) assert.ok(c.width >= 160, `${url} at ${width} px: ${c.site} has ${c.width} px`);
        assert.deepEqual(cells.slice(0, 2).map((c) => c.lines), [1, 1], `${url} at ${width} px: a short host name sits on one line`);
        assert.ok(cells[2].lines <= 4, `${url} at ${width} px: a long host name wraps in a few lines, not ${cells[2].lines}`);
        const page = await b.evaluate(`({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth })`);
        assert.equal(page.scrollWidth, page.width, `${url} at ${width} px: the page doesn't scroll sideways`);
      }
    }
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 6: Pilot ----------

const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const ev = (n, url) => ({ id: `e${n}`, type: "Event::Endpoint::WebControlViolation", name: `'${url}' blocked due to category 'Chat'`, created_at: now, endpoint_id: "w1", user_id: `u${n}` });
const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([ev(1, "https://chat.example.org/")]) };
const pilotView = { pilot, policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] }, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [] };
const plan = { host: "chat.example.org", site: "chat.example.org", pilot, steps: [{ op: "add-site", listId: "l1", listName: "Example allows", site: "chat.example.org" }], problems: [], notes: [] };

test("an Allow the read-back didn't confirm isn't a green success: it says so, with why on the Detail line when the list couldn't be read", { skip: skipBrowser, timeout: 90_000 }, async () => {
  let readBack = "";
  const { server: srv, base } = await server({
    [`GET /api/pilot/${T}`]: pilotView,
    [`GET /api/pilot/${T}/digest`]: digest,
    [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun ? { plan } : { plan, entry: { id: "a1", at: now, host: plan.host, site: plan.site, buildId: "b1", profileId: "pr1", listName: "Example allows", createdList: false, status: "added", readBack } }),
  });
  let b;
  try {
    b = await openBrowser();
    const allow = async (rb) => {
      readBack = rb;
      return toastAfter(b, `${base}/pilot.html?tenant=${T}`, "[data-allow]", [click("[data-allow]"), { until: `!!document.querySelector("#allow-go")` }, click("#allow-go")]);
    };
    const UNCONFIRMED = "Sophos accepted the Allow for chat.example.org, but";
    assert.deepEqual(await allow(`not read: ${RAW}`), { kind: "toast-warn", text: `${UNCONFIRMED} the list couldn't be read back, so it isn't confirmed.`, detail: DETAIL });
    assert.deepEqual(await allow("not found"), { kind: "toast-warn", text: `${UNCONFIRMED} the read-back didn't confirm it: not found.`, detail: null });
    assert.deepEqual(await allow("list holds the site; profile read back without the link"), { kind: "toast-warn", text: `${UNCONFIRMED} the read-back didn't confirm it: list holds the site; profile read back without the link.`, detail: null });
    assert.deepEqual(await allow("site listed"), { kind: "toast-ok", text: "Allowed chat.example.org: site listed.", detail: null });
    assert.deepEqual(await allow("list holds the site; profile links it as allow"), { kind: "toast-ok", text: "Allowed chat.example.org: list holds the site; profile links it as allow.", detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});
