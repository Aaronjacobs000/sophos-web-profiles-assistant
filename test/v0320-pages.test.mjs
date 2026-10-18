// v0.3.20, as drawn in a headless Chrome or Edge (skipped without one): a
// write Sophos accepted that the read-back didn't confirm can be undone or
// tried again from the page (category D). A wave not confirmed has Undo;
// Undo last lists turns into Undo again for deletes it couldn't confirm; an
// Allow whose list was made but not linked is amber, with Undo; a retire
// record says which step wasn't confirmed and that the rest went through;
// and a restore record saved before v0.3.19 whose restore write failed is
// red. The section headers in components.css are covered in v0320-fixes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { listRecords } from "../backend/dist/services/retire-service.js";
import { dataDirFor } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.20", readOnly: false };
const now = new Date().toISOString();
const RAW = "Sophos API error 503: ServiceUnavailable - mock refuses this";
const NOT_READ = `not read: ${RAW}`;

/** The frontend with an API whose routes answer as set: a body, or a function of the request body. */
async function server(routes) {
  const app = express();
  app.use(express.json());
  app.all("/api/*", (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(status);
    const route = routes[key];
    if (route === undefined) return res.status(404).json({ error: "not_found" });
    res.json(typeof route === "function" ? route(req.body ?? {}) : route);
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}` };
}

const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__unhandled.push(String(e.message))); window.confirm = () => true; true`;
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

/** Each row of a card: its tag's class and text, its plain note, its Detail line, and its buttons. */
const ROWS = (card, sel) => `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === ${JSON.stringify(card)});
  return [...c.querySelectorAll(${JSON.stringify(sel)})].map((r) => {
    const t = r.querySelector(".tag");
    return {
      tag: t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null,
      note: r.querySelector(".err-note, .o-note")?.textContent.trim() ?? null,
      detail: r.querySelector("[data-error-detail], [data-allow-detail]")?.textContent.trim() ?? null,
      steps: r.querySelector(".r-steps")?.firstChild?.textContent.trim() ?? null,
      buttons: [...r.querySelectorAll("button")].map((x) => x.textContent.trim()),
    };
  });
})()`;

const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const wave = (n, s, extra) => ({ id: `88888888-0000-4000-8000-00000000000${n}`, at: now, buildId: "b1", policyId: "p1", devices: [{ id: `w${n}`, hostname: `EXAMPLE-PC-0${n}` }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: [`w${n}`], endpointGroups: [] }, status: s, ...extra });
const promoOf = (waves) => ({ pilot, policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 }, mode: "devices", plan: { waves: [], inPilot: [{ id: "w1" }], notEligible: [] }, waves, waveSize: 25 });

// ---------- item 1 ----------

test("Promote: a wave Sophos accepted that the read-back didn't confirm is amber with Undo, and an undo with nothing to put back is green", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const w1 = wave(1, "unconfirmed", { readBack: NOT_READ, error: "The tool couldn't read the pilot policy back, so the move isn't confirmed." });
  let undoAnswer = null;
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: promoOf([w1, wave(2, "failed", { readBack: "assignment differs", error: "The policy read back without the new devices." }), wave(3, "failed", { error: RAW })]),
    [`GET /api/retire/${T}`]: { tags: [], records: [] },
    [`POST /api/promote/${T}/wave/${w1.id}/undo`]: () => undoAnswer,
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".wave-list");
    const rows = await b.evaluate(ROWS("Waves moved", ".wave-list > li"));
    const note = "Sophos accepted the move, but the read-back didn't confirm it. Check the pilot in Sophos Fusion.";
    assert.deepEqual(rows.map((r) => [r.tag, r.note, r.buttons]), [
      [["Not confirmed", "tag-warn"], note, ["Undo"]],
      // Saved as failed, with a read-back, before v0.3.20.
      [["Not confirmed", "tag-warn"], note, ["Undo"]],
      [["Failed", "tag-bad"], "The move didn't finish.", []],
    ]);
    undoAnswer = { ...w1, status: "undone", readBack: "assignment already as before the wave" };
    assert.deepEqual(await toastAfter(b, `${base}/promote.html?tenant=${T}`, "[data-undo-wave]", [click("[data-undo-wave]")]), { kind: "toast-ok", text: "Nothing to undo: the pilot read back with its assignment as it was before this wave.", detail: null });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2 ----------

const LIST = "Example cleaned Block";
const cleanupView = (lists) => ({
  run: { scope: T, options: { dns: true, intelix: false }, intelixLookups: 0, running: false },
  results: [{ id: "r1", raw: "app.example.com", site: { value: "app.example.com" }, tags: ["Example tag"], override: null, action: "block", verdict: "exception", reason: "Kept until you decide.", needsDecision: false, lookup: null, dns: { status: "resolves" } }],
  summary: { total: 1, covered: 0, remove: 0, exception: 1, needsDecision: 0 },
  lists: [{ name: LIST, action: "block", sites: 1 }],
  leftOut: 0,
  lastLists: { tenantId: T, scope: T, createdAt: now, lists },
  intelix: false,
});
const row = (name, extra) => ({ name, action: "block", sites: 1, id: name, status: "created", readBack: "matches", ...extra });
const ACTIONS = `(() => { const a = document.querySelector(".cu-list-actions"); return { buttons: [...a.querySelectorAll("button")].map((b) => b.textContent.trim()), hint: document.querySelector("[data-undo-open]")?.textContent.trim() ?? null }; })()`;

test("Clean up: deletes the last undo couldn't confirm can be sent again with Undo again, which says what it did", { skip: skipBrowser, timeout: 60_000 }, async () => {
  let view = cleanupView([row(LIST, { status: "not confirmed", readBack: NOT_READ }), row("Example cleaned Warn", { status: "deleted", readBack: "404 on read-back" })]);
  let sent = null;
  const { server: srv, base } = await server({
    [`GET /api/cleanup/${T}`]: () => view,
    [`POST /api/cleanup/${T}/lists`]: (body) => ((sent = body), { tenantId: T, scope: T, createdAt: now, lists: [row(LIST, { status: "deleted", readBack: "404 on read-back" }), row("Example cleaned Warn", { status: "deleted", readBack: "404 on read-back" })] }),
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/cleanup.html?tenant=${T}`, 1440, ".cu-list-actions");
    assert.deepEqual(await b.evaluate(ACTIONS), { buttons: ["Create site lists", "Undo again"], hint: `The last undo didn't confirm "${LIST}" deleted. Undo again to send that delete again, or check the site lists in Sophos Fusion.` });
    assert.deepEqual(await toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#undo-lists", [click("#undo-lists")]), { kind: "toast-ok", text: "Undone: 2 site lists deleted and read back.", detail: null });
    assert.deepEqual(sent, { undo: true });
    assert.deepEqual(await b.evaluate(ACTIONS), { buttons: ["Create site lists"], hint: null }, "nothing left to undo");
    // Two left, one still there after its delete.
    view = cleanupView([row(LIST, { status: "still there after delete", readBack: "still there" }), row("Example cleaned Warn", { status: "not confirmed", readBack: NOT_READ })]);
    await b.open(`${base}/cleanup.html?tenant=${T}`, 1440, ".cu-list-actions");
    assert.equal((await b.evaluate(ACTIONS)).hint, "The last undo didn't confirm 2 site lists deleted. Undo again to send those deletes again, or check the site lists in Sophos Fusion.");
    // From v0.3.21 deletes Sophos refused are sent again too, as a rollback sends them again (covered in v0321-pages).
    view = cleanupView([row(LIST, { status: "delete failed", error: RAW }), row("Example cleaned Warn", { status: "in use by a profile, left", error: RAW })]);
    await b.open(`${base}/cleanup.html?tenant=${T}`, 1440, ".cu-list-actions");
    assert.deepEqual((await b.evaluate(ACTIONS)).buttons, ["Create site lists", "Undo again"]);
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 3 ----------

const store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } };
const events = [{ id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://chat.example.org/' blocked due to category 'Chat'", created_at: now, endpoint_id: "w1", user_id: "u1" }];
const allow = (n, s, extra) => ({ id: `99999999-0000-4000-8000-00000000000${n}`, at: now, host: "chat.example.org", site: "chat.example.org", buildId: "b1", profileId: "pr1", listId: "al1", listName: "Example pilot allows", createdList: true, status: s, buildStatus: "built", ...extra });
const PARTIAL = "Sophos made the list, but its link to the profile didn't go through, so the Allow may not be in effect. Undo removes the list.";

test("Pilot: an Allow whose list Sophos made but whose link didn't go through is amber with Undo, and says so when it's made", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const partial = allow(1, "partial", { readBack: "list holds the site", error: "Sophos API error 403: Forbidden" });
  const { server: srv, base } = await server({
    [`GET /api/pilot/${T}`]: { pilot, policy, store, allows: [partial, allow(2, "partial", { readBack: "list holds the site", error: "x", buildStatus: "rolled-back" })] },
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) },
    [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun ? { plan: { host: "chat.example.org", site: "chat.example.org", pilot, steps: [{ op: "create-list", name: "Example pilot allows", site: "chat.example.org" }, { op: "link-list", profileId: "pr1", profileName: "Example profile", priority: 2 }], problems: [], notes: [] } } : { plan: {}, entry: partial }),
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    const rows = await b.evaluate(ROWS("Allow entries", ".order-list > li"));
    assert.deepEqual(rows.map((r) => [r.tag, r.note, r.detail, r.buttons]), [
      [["Not finished", "tag-warn"], PARTIAL, "Detail: Sophos API error 403: Forbidden.", ["Undo"]],
      [["Removed with the build", "tag-muted"], null, null, []],
    ]);
    assert.deepEqual(await toastAfter(b, `${base}/pilot.html?tenant=${T}`, "[data-allow]", [click("[data-allow]"), { until: "!!document.querySelector('#allow-go')" }, click("#allow-go")]), {
      kind: "toast-warn",
      text: "Sophos made the list for chat.example.org, but its link to the profile didn't go through. Undo it from Allow entries.",
      detail: "Detail: Sophos API error 403: Forbidden.",
    });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- items 4 and 5 ----------

const tagStep = (s, extra) => ({ op: "policy-tags", policyId: "44444444-4444-4444-8444-444444444444", policyName: "Base Policy", before: [{ tag: "Example tag", action: "block" }], after: [], status: s, ...extra });
const delStep = (s, extra) => ({ op: "delete-entry", id: "66666666-0000-4000-8000-000000000001", url: "blocked.example.com", tags: ["Example tag"], status: s, ...extra });
const retireRec = (n, s, steps, extra) => ({ id: `77777777-0000-4000-8000-00000000000${n}`, tenantId: T, at: `2026-10-1${n}T01:00:00.000Z`, tags: ["Example tag"], snapshotFile: "example-tenant_20261017-010000.json", status: s, steps, warnings: [], ...extra });

test("Promote: a retire that went on past a step it couldn't confirm says which, and a restore saved before v0.3.19 whose write failed is red", { skip: skipBrowser, timeout: 60_000 }, async () => {
  // The records as the server reads them, from files saved the way each version saved them.
  const dataDir = await dataDirFor("pages-retire");
  const dir = path.join(dataDir, "retire", T);
  mkdirSync(dir, { recursive: true });
  const went = retireRec(3, "partial", [tagStep("unconfirmed", { readBack: "tags differ", error: "Read back: tags differ." }), delStep("done", { readBack: "404 on read-back" })]);
  const legacy = retireRec(2, "restore-partial", [tagStep("restore-failed", { readBack: "tags match", error: "Sophos API error 403: Forbidden" }), delStep("restore-failed", { readBack: "404 on read-back", error: "Sophos API error 403: Forbidden" })], { restoredAt: now });
  for (const r of [went, legacy]) writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r));
  const records = await listRecords(dataDir, T);
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: promoOf([]),
    [`GET /api/retire/${T}`]: { tags: [{ tag: "Example tag", entries: 1, only: 1, policies: [] }], records },
    [`POST /api/retire/${T}/plan`]: { tags: ["Example tag"], steps: [tagStep("planned")], problems: [], warnings: [] },
    [`POST /api/retire/${T}/execute`]: went,
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".retired-table");
    const rows = await b.evaluate(ROWS("Retired", ".retired-table tbody tr"));
    assert.deepEqual(rows.map((r) => [r.tag, r.steps, r.detail, r.buttons]), [
      [["Retire not confirmed", "tag-warn"], "Base Policy: not confirmed (tags differ); blocked.example.com: done (404 on read-back)", "Detail: Base Policy: Read back: tags differ.", ["Restore", "Compare with snapshot"]],
      [["Restore didn't finish", "tag-bad"], "Base Policy: restore failed; blocked.example.com: restore failed", "Detail: Base Policy: Sophos API error 403: Forbidden.", ["Restore", "Compare with snapshot"]],
    ]);
    assert.deepEqual(await toastAfter(b, `${base}/promote.html?tenant=${T}`, 'input[name="tag"]', [click('input[name="tag"]'), click("#plan-retire"), { until: "!!document.querySelector('#go-retire')" }, click("#go-retire")]), {
      kind: "toast-warn",
      text: "Sophos accepted the retire, but the read-back didn't confirm all of it.",
      detail: "Detail: Base Policy: Read back: tags differ.",
    });
  } finally {
    srv.close();
    await b?.close();
  }
});
