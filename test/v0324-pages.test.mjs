// v0.3.24, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant: a create Sophos
// answered with a 5xx, whose name lookup couldn't be read, is amber Not
// confirmed (a build step, an Allow, Create site lists) with what Sophos said
// and why nothing was read on its Detail line, and the next run says it uses
// what it found by name. On the Build page, a delete not confirmed says Roll
// back again only when a rollback has run for it; one an Allow undo left says
// to undo the Allow again.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, dryRun, execute, getBuild, rollback } from "../backend/dist/services/build-service.js";
import { activePilot, addAllow, planAllow, readPilotPolicy, undoAllow } from "../backend/dist/services/pilot-service.js";
import { createLists, planLists } from "../backend/dist/services/lists-service.js";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, classicTenant, ctxOf, dataDirFor, seedPilot } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.24", readOnly: false };
const now = new Date().toISOString();
/** What a page's Detail line says for a create Sophos answered 500 whose name lookup couldn't be read. */
const SAID = `Detail: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`;
const LISTS = /\/site-lists$/;

/** The frontend with an API whose routes answer as set: a body, or a function of the request body. */
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

/** Each row of a card: its tag's text and class, its plain note and its Detail line. */
const ROWS = (card, sel) => `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === ${JSON.stringify(card)});
  return [...c.querySelectorAll(${JSON.stringify(sel)})].map((r) => {
    const t = r.querySelector(".tag");
    return [t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null, r.querySelector(".err-note, .o-note")?.textContent.trim() ?? null, r.querySelector("[data-error-detail], [data-allow-detail]")?.textContent.trim() ?? null];
  });
})()`;

/** A create of a list Sophos makes, then answers 500, with the site lists not read after it. */
function unreadCreate(tenant) {
  let on = true;
  const w = afterWrite(tenant);
  tenant.unclear("POST", LISTS, () => on);
  tenant.refuse("GET", LISTS, 503, () => on && w());
  return () => (on = false);
}

const pilotTargets = { endpoints: [], endpointGroups: [], userGroups: [] };

// ---------- item 1: a build step ----------

test("Build: a step Sophos answered 500, whose name lookup couldn't be read, is amber Not confirmed, and the next dry run says it uses what it found", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0324-pages-build");
  const tenant = classicTenant();
  const ctx = ctxOf(tenant);
  const { design } = await designFor(dataDir, ctx);
  const pilot = { profileKey: design.profiles.find((p) => p.siteLists.length).key, enabled: false, targets: { endpoints: ["w1"] } };
  const passing = await dryRun(dataDir, ctx, pilot);
  const off = unreadCreate(tenant);
  const built = await execute(dataDir, ctx, pilot, TOOL);
  off();
  const next = await dryRun(dataDir, ctx, pilot);
  let items = [];
  let plan = passing;
  const { server: srv, base } = await server({
    [`GET /api/design/${T}`]: { design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: pilotTargets,
    [`GET /api/build/${T}`]: () => ({ items }),
    [`POST /api/build/${T}/dry-run`]: () => plan,
    [`POST /api/build/${T}/execute`]: () => ((items = [built]), built),
  });
  let b;
  try {
    b = await openBrowser();
    const toast = await toastAfter(b, `${base}/build.html?tenant=${T}`, "#dry", [click("#dry"), { until: `!document.querySelector("#go").disabled` }, click("#go")]);
    const name = built.steps[0].name;
    assert.deepEqual(toast, { kind: "toast-warn", text: `Build didn't finish. Sophos didn't say the site list "${name}" was made, and the read-back didn't confirm it.`, detail: SAID });
    await b.open(`${base}/build.html?tenant=${T}`, 1440, ".steps-list");
    assert.deepEqual((await b.evaluate(ROWS("Plan", ".steps-list > li")))[0], [["Not confirmed", "tag-warn"], "Sophos didn't say it was made, and the read-back didn't confirm it. The next build looks for it by name first and uses it if it's there.", SAID]);
    // The next dry run: the step says it's used, and a check says why.
    plan = next;
    await b.evaluate(click("#dry"));
    await waitFor(b, `[...document.querySelectorAll(".check-list li")].some((l) => /An earlier build asked for it/.test(l.textContent))`, "the dry run");
    const check = await b.evaluate(`(() => { const l = [...document.querySelectorAll(".check-list li")].find((x) => /An earlier build asked for it/.test(x.textContent)); return [l.className, l.textContent.trim()]; })()`);
    assert.deepEqual(check, ["warn", `The site list "${name}" is in the tenant. An earlier build asked for it and Sophos didn't confirm it was made, so this build uses it rather than making another.`]);
    assert.match(await b.evaluate(`document.querySelector(".steps-list .s-sum").textContent`), /Found by name: an earlier build asked for it and Sophos didn't confirm it, so it's used, not made again\.$/);
    assert.equal(await b.evaluate(`document.querySelector("#go").disabled`), false, "the build can go ahead");
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 1: an Allow's new list ----------

test("Pilot: an Allow whose new list Sophos answered 500, with the site lists not read after, is amber Not confirmed, and Allow it again says it uses the list it finds", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0324-pages-allow");
  const tenant = new Tenant();
  seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const off = unreadCreate(tenant);
  const first = (await addAllow(dataDir, ctx, "chat.example.org")).entry;
  off();
  const pilot = await activePilot(dataDir, T);
  const { policy } = await readPilotPolicy(ctx, pilot);
  const rerun = await planAllow(dataDir, ctx, "chat.example.org");
  const second = (await addAllow(dataDir, ctx, "chat.example.org")).entry;
  let entry = first;
  let plan = { host: "chat.example.org", site: "chat.example.org", pilot, steps: [{ op: "create-list", name: "Example pilot allows", site: "chat.example.org" }], problems: [], notes: [] };
  const events = [{ id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://chat.example.org/' blocked due to category 'Chat'", created_at: now, endpoint_id: "w1", user_id: "u1" }];
  const { server: srv, base } = await server({
    [`GET /api/pilot/${T}`]: () => ({ pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [{ ...entry, buildStatus: "built" }] }),
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) },
    [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun ? { dryRun: true, plan } : { dryRun: false, plan, entry }),
  });
  let b;
  try {
    b = await openBrowser();
    const allow = () => toastAfter(b, `${base}/pilot.html?tenant=${T}`, '[data-allow="chat.example.org"]', [click('[data-allow="chat.example.org"]'), { until: "!!document.querySelector('#allow-go')" }, click("#allow-go")]);
    assert.deepEqual(await allow(), { kind: "toast-warn", text: "Sophos didn't say the Allow for chat.example.org went through, and the read-back didn't confirm it.", detail: SAID });
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    assert.deepEqual(await b.evaluate(ROWS("Allow entries", ".order-list > li")), [[["Not confirmed", "tag-warn"], "Sophos didn't say the Allow went through, and the read-back didn't confirm it. Allow it again: the tool looks for the list by name first.", SAID]]);
    assert.equal(await b.evaluate(`!!document.querySelector("[data-undo]")`), false, "no id, so no Undo");
    // Allow it again: the dry run says it uses the list it found, and the toast says so.
    plan = rerun;
    entry = second;
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, '[data-allow="chat.example.org"]');
    await b.evaluate(click('[data-allow="chat.example.org"]'));
    await waitFor(b, "!!document.querySelector('#allow-go')", "the dry run");
    const modal = await b.evaluate(`document.querySelector("#results-modal .modal-body").innerText`);
    assert.match(modal, /Use the site list "Example pilot allows" the Allow for chat\.example\.org asked for, found by name, rather than make another\./);
    assert.match(modal, /The site list "Example pilot allows" from the Allow for chat\.example\.org is in the tenant\. Sophos didn't confirm it was made, so this Allow uses it rather than making another\./);
    assert.deepEqual(await allow(), { kind: "toast-ok", text: 'Allowed chat.example.org: list holds the site; profile links it as allow. The site list "Example pilot allows" was found by name and used, not made again.', detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 1: Create site lists ----------

const result = (n, site, action = "block") => ({ id: `r${n}`, raw: site, site: parseSite(site), action, tags: ["Example tag"], source: "website-management", verdict: "exception", reason: "", needsDecision: false });
const RESULTS = [result(1, "app.example.com")];

test("Clean up: a list Sophos answered 500, with the site lists not read after, is amber, and the next create says it uses the list it finds", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0324-pages-lists");
  const tenant = new Tenant();
  const first = await (async () => {
    const off = unreadCreate(tenant);
    const rec = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
    off();
    return rec;
  })();
  const rerun = await planLists(tenant, T, RESULTS, "Example cleaned", { dataDir, scope: T });
  const second = await createLists(dataDir, tenant, T, T, RESULTS, "Example cleaned");
  let plan = { lists: [{ name: "Example cleaned Block", action: "block", sites: ["app.example.com"] }], problems: [], leftOut: 0, reuse: [], notes: [] };
  let made = first;
  const view = { run: { scope: T, options: { dns: false, intelix: false }, intelixLookups: 0, running: false }, results: RESULTS.map((r) => ({ ...r, dns: null, lookup: null })), summary: { total: 1, covered: 0, remove: 0, exception: 1, needsDecision: 0 }, lists: [{ name: "Example cleaned Block", action: "block", sites: 1 }], leftOut: 0, lastLists: null, intelix: false };
  const { server: srv, base } = await server({
    [`GET /api/readiness/${T}`]: { tenant: { id: T, name: "Example Tenant", region: "us01" }, running: false, result: null },
    [`GET /api/cleanup/${T}`]: view,
    [`POST /api/cleanup/${T}/lists`]: (body) => (body.dryRun ? plan : made),
  });
  let b;
  try {
    b = await openBrowser();
    const create = () => toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#create-lists", [click("#create-lists")]);
    assert.deepEqual(await create(), { kind: "toast-warn", text: `Sophos didn't say creating "Example cleaned Block" went through, and the read-back didn't confirm it.`, detail: `Detail: "Example cleaned Block": ${UNCLEAR}. Read back: ${UNAVAILABLE}.` });
    plan = rerun;
    made = second;
    assert.deepEqual(await create(), { kind: "toast-ok", text: '1 site list created and read back. "Example cleaned Block" was found by name and used, not made again.', detail: null });
    const [asked] = await b.evaluate("window.__confirms");
    assert.match(asked, /\n\n"Example cleaned Block" is in the tenant\. The last create asked for it and Sophos didn't confirm it was made, so this one uses it rather than making another\.$/);
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2: Roll back again only after a rollback ----------

test("Build: a delete not confirmed says Roll back again only when a rollback has run for it, and to undo the Allow again when an Allow undo left it", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const records = {};
  for (const [name, how] of Object.entries({ unanswered: "unclear", accepted: "accepted" })) {
    const dataDir = await dataDirFor(`v0324-pages-undo-${name}`);
    const tenant = new Tenant();
    const { build, policyId } = seedPilot(tenant, dataDir);
    const ctx = ctxOf(tenant);
    const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
    const LIST = new RegExp(`/site-lists/${entry.listId}$`);
    const POLICY = new RegExp(`/policies/${policyId}$`);
    // The Allow undo's list delete: made, then not confirmed (nothing read back after).
    if (how === "unclear") tenant.unclear("DELETE", LIST);
    tenant.refuse("GET", LIST, 503, afterWrite(tenant));
    await undoAllow(dataDir, ctx, entry.id);
    tenant.rules.length = 0;
    records[`${name} undo`] = await getBuild(dataDir, T, build.id);
    // Then a rollback whose policy delete isn't confirmed either: that step says Roll back again.
    if (how === "unclear") tenant.unclear("DELETE", POLICY);
    tenant.refuse("GET", POLICY, 503, afterWrite(tenant));
    tenant.refuse("DELETE", /\/(profiles|site-lists)\//, 409);
    records[`${name} rollback`] = await rollback(dataDir, ctx, build.id, { dryRun: false });
    tenant.rules.length = 0;
  }
  let shown;
  const design = { policies: [], profiles: [], siteLists: [], limits: { profiles: { planned: 0, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
  const { server: srv, base } = await server({ [`GET /api/design/${T}`]: { design, genAi: {} }, [`GET /api/pilot-targets/${T}`]: pilotTargets, [`GET /api/build/${T}`]: () => ({ items: [shown] }) });
  let b;
  try {
    b = await openBrowser();
    const rows = async (rec) => {
      shown = rec;
      await b.open(`${base}/build.html?tenant=${T}`, 1440, ".steps-list");
      return b.evaluate(ROWS("Plan", ".steps-list > li"));
    };
    const UNDO_AGAIN = "Undo the Allow again on the Pilot page, or check it in Sophos Fusion.";
    const ROLL_AGAIN = "Roll back again, or check it in Sophos Fusion.";
    const SAID_DELETE = `Sophos didn't say the delete went through, and the read-back didn't confirm it's gone.`;
    const ACCEPTED_DELETE = `Sophos accepted the delete, but the read-back didn't confirm it's gone.`;
    // No rollback has run: the Allow undo's list says to undo the Allow again.
    assert.deepEqual((await rows(records["unanswered undo"])).pop(), [["Delete not confirmed", "tag-warn"], `${SAID_DELETE} ${UNDO_AGAIN}`, SAID]);
    assert.deepEqual((await rows(records["accepted undo"])).pop(), [["Delete not confirmed", "tag-warn"], `${ACCEPTED_DELETE} ${UNDO_AGAIN}`, `Detail: ${UNAVAILABLE}.`]);
    // After a rollback: its own policy delete says to roll back again.
    const unanswered = await rows(records["unanswered rollback"]);
    assert.deepEqual(unanswered.find((r) => r[1]?.startsWith(SAID_DELETE) && r[1].endsWith(ROLL_AGAIN)), [["Delete not confirmed", "tag-warn"], `${SAID_DELETE} ${ROLL_AGAIN}`, SAID]);
    const accepted = await rows(records["accepted rollback"]);
    assert.deepEqual(accepted.find((r) => r[1]?.startsWith(ACCEPTED_DELETE) && r[1].endsWith(ROLL_AGAIN)), [["Delete not confirmed", "tag-warn"], `${ACCEPTED_DELETE} ${ROLL_AGAIN}`, `Detail: ${UNAVAILABLE}.`]);
  } finally {
    srv.close();
    await b?.close();
  }
});
