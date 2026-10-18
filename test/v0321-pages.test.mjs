// v0.3.21, as drawn in a headless Chrome or Edge (skipped without one): Undo
// again sends a delete Sophos refused again, with a note saying what the last
// undo left; an Allow whose profile couldn't be read back says the profile
// wasn't read; a delete Sophos didn't answer with a success isn't called
// accepted, on the Clean up and Build pages; and a retire that went on past a
// tag change it couldn't confirm says which policy may still name the tag.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { openBrowser, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.21", readOnly: false };
const now = new Date().toISOString();
const RAW = "Sophos API error 503: ServiceUnavailable - mock refuses this";
const NOT_READ = `not read: ${RAW}`;
const UNCLEAR = "Sophos API error 500: InternalServerError";

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

/** Each row of a card: its tag's class and text, its plain note, its Detail line, its sub-line and its buttons. */
const ROWS = (card, sel) => `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === ${JSON.stringify(card)});
  return [...c.querySelectorAll(${JSON.stringify(sel)})].map((r) => {
    const t = r.querySelector(".tag");
    return {
      tag: t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null,
      note: r.querySelector(".err-note, .o-note")?.textContent.trim() ?? null,
      detail: r.querySelector("[data-error-detail], [data-allow-detail]")?.textContent.trim() ?? null,
      sub: r.querySelector(".o-kind")?.textContent.trim() ?? null,
      text: r.textContent.replace(/\\s+/g, " ").trim(),
      buttons: [...r.querySelectorAll("button")].map((x) => x.textContent.trim()),
    };
  });
})()`;

// ---------- Clean up: items 2 and 5 ----------

const LIST = "Example cleaned Block";
const WARN = "Example cleaned Warn";
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
const undone = (lists) => ({ tenantId: T, scope: T, createdAt: now, lists });

test("Clean up: Undo again sends the deletes Sophos refused again, and the note says what the last undo left", { skip: skipBrowser, timeout: 60_000 }, async () => {
  let view = cleanupView([row(LIST, { status: "in use by a profile, left", error: "Sophos API error 409: Conflict" })]);
  let sent = null;
  const { server: srv, base } = await server({
    [`GET /api/cleanup/${T}`]: () => view,
    [`POST /api/cleanup/${T}/lists`]: (body) => ((sent = body), undone([row(LIST, { status: "deleted", readBack: "404 on read-back" })])),
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/cleanup.html?tenant=${T}`, 1440, ".cu-list-actions");
    assert.deepEqual(await b.evaluate(ACTIONS), { buttons: ["Create site lists", "Undo again"], hint: `"${LIST}" is in use by a profile, so it was left: take it off the profile in Sophos Fusion first. Undo again to send that delete again, or check the site lists in Sophos Fusion.` });
    assert.deepEqual(await toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#undo-lists", [click("#undo-lists")]), { kind: "toast-ok", text: `Undone: "${LIST}" deleted and read back.`, detail: null });
    assert.deepEqual(sent, { undo: true });
    // Refused, and not confirmed, together.
    view = cleanupView([row(LIST, { status: "delete failed", error: "Sophos API error 403: Forbidden" }), row(WARN, { status: "not confirmed", readBack: NOT_READ })]);
    await b.open(`${base}/cleanup.html?tenant=${T}`, 1440, ".cu-list-actions");
    assert.deepEqual(await b.evaluate(ACTIONS), { buttons: ["Create site lists", "Undo again"], hint: `The last undo didn't confirm "${WARN}" deleted. It couldn't delete "${LIST}". Undo again to send those deletes again, or check the site lists in Sophos Fusion.` });
  } finally {
    srv.close();
    await b?.close();
  }
});

test("Clean up: a delete Sophos didn't answer with a success isn't called accepted; one it accepted still is", { skip: skipBrowser, timeout: 60_000 }, async () => {
  let answer = null;
  const { server: srv, base } = await server({
    [`GET /api/cleanup/${T}`]: cleanupView([row(LIST)]),
    [`POST /api/cleanup/${T}/lists`]: () => answer,
  });
  let b;
  try {
    b = await openBrowser();
    const undo = () => toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#undo-lists", [click("#undo-lists")]);
    answer = undone([row(LIST, { status: "not confirmed", readBack: NOT_READ, deleteAnswer: UNCLEAR })]);
    assert.deepEqual(await undo(), { kind: "toast-warn", text: `Sophos didn't say the delete of "${LIST}" went through, and the read-back didn't confirm it.`, detail: `Detail: "${LIST}": ${UNCLEAR}. Read back: ${RAW}.` });
    answer = undone([row(LIST, { status: "not confirmed", readBack: NOT_READ, deleteAnswer: UNCLEAR }), row(WARN, { status: "not confirmed", readBack: NOT_READ })]);
    assert.equal((await undo()).text, "The read-back didn't confirm 2 of the deletes, and Sophos didn't say 1 of those went through.");
    answer = undone([row(LIST, { status: "not confirmed", readBack: NOT_READ, deleteAnswer: UNCLEAR }), row(WARN, { status: "not confirmed", readBack: NOT_READ, deleteAnswer: "Sophos API error 404: NotFound" })]);
    assert.equal((await undo()).text, "Sophos didn't say 2 of the deletes went through, and the read-back didn't confirm them.");
    // Accepted (a 2xx), as before.
    answer = undone([row(LIST, { status: "not confirmed", readBack: NOT_READ }), row(WARN, { status: "deleted", readBack: "404 on read-back" })]);
    assert.deepEqual(await undo(), { kind: "toast-warn", text: `Sophos accepted the deletes, but the read-back didn't confirm "${LIST}".`, detail: `Detail: "${LIST}": ${RAW}.` });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- Build: item 5 ----------

const design = { policies: [], profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [], flags: [], diff: [], siteLists: [], categoryActions: {} }], siteLists: [], limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
const step = (order, kind, extra) => ({ order, kind, key: kind, name: `Example ${kind}`, method: "POST", path: "/web-filters/v1/site-lists", summary: "", body: {}, status: "created", id: `${kind}-${order}`, readBack: "matches", ...extra });
const build = (steps, rollback) => ({ id: "00000001-0000-4000-a000-000000000000", tenantId: T, tenantName: "Example Tenant", createdAt: now, status: "rollback-partial", snapshotFile: "example-tenant_20261018-010000.json", pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: [] } }, steps, checks: [], rollback: { at: now, steps: rollback } });
const out = (kind, order, status, extra) => ({ kind, name: `Example ${kind}`, id: `${kind}-${order}`, status, ...extra });

test("Build: a delete Sophos didn't answer with a success isn't called accepted, in its row or after the rollback", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const unanswered = build(
    [step(1, "site-list", { status: "deleted" }), step(2, "profile", { status: "delete-failed", deleteReadBack: NOT_READ }), step(3, "policy", { status: "delete-failed", deleteReadBack: NOT_READ, deleteAnswer: UNCLEAR })],
    [out("policy", 3, "not confirmed", { error: `${UNCLEAR}. A read-back couldn't read it (${RAW}), so it may still be there.` }), out("profile", 2, "not confirmed", { error: `A read-back couldn't read it (${RAW}), so it may still be there.` }), out("site-list", 1, "deleted, 404 on read-back")],
  );
  let answer = unanswered;
  const { server: srv, base } = await server({
    [`GET /api/design/${T}`]: { design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
    [`GET /api/build/${T}`]: () => ({ items: [answer] }),
    [`POST /api/build/${T}/${unanswered.id}/rollback`]: (body) => (body.dryRun ? { ...unanswered, restorePlan: [] } : answer),
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/build.html?tenant=${T}`, 1440, ".steps-list");
    const rows = await b.evaluate(ROWS("Plan", ".steps-list > li"));
    assert.deepEqual(rows.map((r) => [r.tag, r.note, r.detail]), [
      [["Rolled back", "tag-muted"], null, null],
      [["Delete not confirmed", "tag-warn"], "Sophos accepted the delete, but the read-back didn't confirm it's gone. Roll back again, or check it in Sophos Fusion.", `Detail: ${RAW}.`],
      [["Delete not confirmed", "tag-warn"], "Sophos didn't say the delete went through, and the read-back didn't confirm it's gone. Roll back again, or check it in Sophos Fusion.", `Detail: ${UNCLEAR}. Read back: ${RAW}.`],
    ]);
    assert.deepEqual(await toastAfter(b, `${base}/build.html?tenant=${T}`, "[data-rollback]", [click("[data-rollback]")]), {
      kind: "toast-warn",
      text: "The rollback isn't confirmed: Sophos didn't say a delete went through, and the read-back didn't confirm it.",
      detail: `Detail: Example policy: ${UNCLEAR}. A read-back couldn't read it (${RAW}), so it may still be there.`,
    });
    // Every delete the read-back didn't confirm accepted: as before.
    answer = build([step(1, "policy", { status: "delete-failed", deleteReadBack: NOT_READ })], [out("policy", 1, "not confirmed", { error: `A read-back couldn't read it (${RAW}), so it may still be there.` })]);
    assert.equal((await toastAfter(b, `${base}/build.html?tenant=${T}`, "[data-rollback]", [click("[data-rollback]")])).text, "Sophos accepted the rollback, but the read-back didn't confirm all of it.");
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- Pilot: item 4 ----------

const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } };
const events = [{ id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://chat.example.org/' blocked due to category 'Chat'", created_at: now, endpoint_id: "w1", user_id: "u1" }];
const allow = (n, s, extra) => ({ id: `99999999-0000-4000-8000-00000000000${n}`, at: now, host: "chat.example.org", site: "chat.example.org", buildId: "b1", profileId: "pr1", listId: "al1", listName: "Example pilot allows", createdList: true, status: s, buildStatus: "built", ...extra });

test("Pilot: an Allow whose profile couldn't be read back after the link says the profile wasn't read, never that it read back without the link", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const entry = allow(1, "added", { readBack: `list holds the site; profile not read: ${RAW}` });
  const { server: srv, base } = await server({
    [`GET /api/pilot/${T}`]: { pilot, policy, store, allows: [entry, allow(2, "added", { readBack: `not read: ${UNCLEAR}; profile not read: ${RAW}` })] },
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) },
    [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun ? { plan: { host: "chat.example.org", site: "chat.example.org", pilot, steps: [{ op: "create-list", name: "Example pilot allows", site: "chat.example.org" }, { op: "link-list", profileId: "pr1", profileName: "Example profile", priority: 2 }], problems: [], notes: [] } } : { plan: {}, entry }),
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    const rows = await b.evaluate(ROWS("Allow entries", ".order-list > li"));
    const note = "Sophos accepted the Allow, but the read-back didn't confirm it.";
    assert.deepEqual(rows.map((r) => [r.tag, r.note, r.detail, r.sub.split(" · ").pop()]), [
      [["Not confirmed", "tag-warn"], note, `Detail: ${RAW}.`, "list holds the site; profile not read"],
      [["Not confirmed", "tag-warn"], note, `Detail: ${UNCLEAR}. Profile: ${RAW}.`, "not read; profile not read"],
    ]);
    assert.ok(rows.every((r) => !/read back without the link/.test(r.text)), rows.map((r) => r.text).join(" | "));
    assert.deepEqual(await toastAfter(b, `${base}/pilot.html?tenant=${T}`, "[data-allow]", [click("[data-allow]"), { until: "!!document.querySelector('#allow-go')" }, click("#allow-go")]), {
      kind: "toast-warn",
      text: "Sophos accepted the Allow for chat.example.org, but the profile couldn't be read back, so it isn't confirmed.",
      detail: `Detail: ${RAW}.`,
    });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- Promote: item 8 ----------

const promo = { pilot, policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 }, mode: "devices", plan: { waves: [], inPilot: [{ id: "w1" }], notEligible: [] }, waves: [], waveSize: 25 };
const tagStep = (s, extra) => ({ op: "policy-tags", policyId: "44444444-4444-4444-8444-444444444444", policyName: "Base Policy", before: [{ tag: "Example tag", action: "block" }], after: [], status: s, ...extra });
const delStep = (s, extra) => ({ op: "delete-entry", id: "66666666-0000-4000-8000-000000000001", url: "blocked.example.com", tags: ["Example tag"], status: s, ...extra });
const retireRec = (n, s, steps, extra) => ({ id: `77777777-0000-4000-8000-00000000000${n}`, tenantId: T, at: `2026-10-1${n}T01:00:00.000Z`, tags: ["Example tag"], snapshotFile: "example-tenant_20261018-010000.json", status: s, steps, warnings: [], ...extra });
const LEFT = [{ policyId: "44444444-4444-4444-8444-444444444444", policyName: "Base Policy", tags: ["Example tag"] }];

test("Promote: a retire that went on past a tag change it couldn't confirm says the policy may still name the tag, and that Restore covers it", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const records = [
    retireRec(3, "partial", [tagStep("unconfirmed", { readBack: "tags differ", error: "Read back: tags differ." }), delStep("done", { readBack: "404 on read-back" })], { tagsMayRemain: LEFT }),
    retireRec(2, "partial", [tagStep("done", { readBack: "tags match" }), delStep("failed", { error: "Sophos API error 403: Forbidden" })]),
    retireRec(1, "restored", [tagStep("restored", { readBack: "tags match" }), delStep("restored", { readBack: "re-created, matches" })], { tagsMayRemain: LEFT }),
  ];
  const { server: srv, base } = await server({ [`GET /api/promote/${T}`]: promo, [`GET /api/retire/${T}`]: { tags: [], records } });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".retired-table");
    const notes = await b.evaluate(`[...document.querySelectorAll(".retired-table tbody tr")].map((tr) => tr.querySelector("[data-tags-remain]")?.textContent ?? null)`);
    assert.deepEqual(notes, [
      `"Base Policy" may still name Example tag, but the retire went on and deleted or untagged the entries with it. A policy that names a tag with no entries can't be saved. Restore puts the entries back before the tags.`,
      null,
      null,
    ]);
    const rows = await b.evaluate(ROWS("Retired", ".retired-table tbody tr"));
    assert.deepEqual(rows[0].tag, ["Retire not confirmed", "tag-warn"]);
    assert.equal(rows[0].detail, "Detail: Base Policy: Read back: tags differ.");
    assert.deepEqual(rows[0].buttons, ["Restore", "Compare with snapshot"]);
  } finally {
    srv.close();
    await b?.close();
  }
});
