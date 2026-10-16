// v0.3.19, as drawn in a headless Chrome or Edge (skipped without one): each
// toast says what was confirmed and no more. Promote says a wave moved only
// when the read-back found it, keeps the read-back out of the message, and
// says when Sophos accepted a change the read-back didn't confirm; a build
// rollback that worked says so when only the list of builds after it
// couldn't be read; Undo last lists says which delete failed and why; Create
// site lists says when a list didn't read back as sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { openBrowser, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.19", readOnly: false };
const now = new Date().toISOString();
const RAW = "Sophos API error 503: ServiceUnavailable - mock refuses this";
const DETAIL = `Detail: ${RAW}.`;

/** The frontend with an API whose routes answer as set: a body, a function of the request body, or { fail } for an error with the raw answer. */
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

// ---------- item 1: Promote ----------

const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const wave = { id: "88888888-0000-4000-8000-000000000001", at: now, buildId: "b1", policyId: "p1", devices: [{ id: "w1", hostname: "EXAMPLE-PC-01" }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: ["w1"], endpointGroups: [] }, status: "moved", readBack: "assignment matches" };
const promo = {
  pilot,
  policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 },
  mode: "devices",
  plan: { waves: [{ n: 1, devices: [{ id: "w2", hostname: "EXAMPLE-PC-02", group: "No group" }] }], inPilot: [{ id: "w1" }], notEligible: [] },
  waves: [wave],
  waveSize: 25,
};
const dryWave = { problems: [], policyName: pilot.policyName, before: { endpoints: ["w1"], endpointGroups: [] }, after: { endpoints: ["w1", "w2"], endpointGroups: [] }, devices: [{ id: "w2", hostname: "EXAMPLE-PC-02" }], enabled: false };

test("Promote: a wave, the pilot switch and a wave undo are green only when read back, with the read-back never in the message", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const s = { move: null, enabled: null, undo: null };
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: promo,
    [`GET /api/retire/${T}`]: { tags: [], records: [] },
    [`POST /api/promote/${T}/wave`]: (body) => (body.dryRun ? dryWave : s.move),
    [`POST /api/promote/${T}/enabled`]: () => s.enabled,
    [`POST /api/promote/${T}/wave/${wave.id}/undo`]: () => s.undo,
  });
  let b;
  try {
    b = await openBrowser();
    const url = `${base}/promote.html?tenant=${T}`;
    const move = async (answer) => ((s.move = answer), toastAfter(b, url, "[data-wave]", [click("[data-wave]")]));
    // The new wave as the server records it, before its read-back.
    const { readBack: _, ...moved } = { ...wave, devices: [{ id: "w2", hostname: "EXAMPLE-PC-02" }] };
    assert.deepEqual(await move({ ...moved, status: "moved", readBack: "assignment matches" }), { kind: "toast-ok", text: "Wave 1 moved and read back.", detail: null });
    // The shape v0.3.18 drew as "Wave moved. Read back: not read: ..." in green.
    assert.deepEqual(await move({ ...moved, status: "moved", readBack: `not read: ${RAW}` }), { kind: "toast-warn", text: "Sophos accepted wave 1, but the read-back didn't confirm the move.", detail: DETAIL });
    assert.deepEqual(await move({ ...moved, status: "failed", readBack: `not read: ${RAW}`, error: "The tool couldn't read the pilot policy back, so the move isn't confirmed." }), { kind: "toast-warn", text: "Sophos accepted wave 1, but the read-back didn't confirm the move.", detail: DETAIL });
    assert.deepEqual(await move({ ...moved, status: "failed", readBack: "assignment differs", error: "The policy read back without the new devices." }), { kind: "toast-warn", text: "Sophos accepted wave 1, but the read-back didn't confirm the move.", detail: "Detail: The policy read back without the new devices." });
    assert.deepEqual(await move({ ...moved, status: "failed", error: RAW }), { kind: "toast-err", text: "Couldn't move wave 1.", detail: DETAIL });
    assert.deepEqual(await move({ fail: 502 }), { kind: "toast-err", text: "Couldn't move wave 1.", detail: DETAIL });

    const toggle = async (answer) => ((s.enabled = answer), toastAfter(b, url, "#toggle", [click("#toggle")]));
    assert.deepEqual(await toggle({ enabled: true, readBack: "matches" }), { kind: "toast-ok", text: "Pilot turned on and read back.", detail: null });
    assert.deepEqual(await toggle({ enabled: true, readBack: "differs" }), { kind: "toast-warn", text: "Sophos accepted turning the pilot on, but the read-back didn't confirm it.", detail: "Detail: The pilot policy read back still off." });
    assert.deepEqual(await toggle({ enabled: true, readBack: `not read: ${RAW}` }), { kind: "toast-warn", text: "Sophos accepted turning the pilot on, but the read-back didn't confirm it.", detail: DETAIL });
    assert.deepEqual(await toggle({ fail: 502 }), { kind: "toast-err", text: "Couldn't turn the pilot on.", detail: DETAIL });

    const undo = async (answer) => ((s.undo = answer), toastAfter(b, url, "[data-undo-wave]", [click("[data-undo-wave]")]));
    assert.deepEqual(await undo({ ...wave, status: "undone", readBack: "assignment back as before the wave" }), { kind: "toast-ok", text: "Wave undone and read back.", detail: null });
    // Undone, as an earlier version answered with the move's read-back, isn't a confirmed undo.
    assert.equal((await undo({ ...wave, status: "undone", readBack: `not read: ${RAW}` })).kind, "toast-warn");
    assert.deepEqual(await undo({ ...wave, status: "undo-failed", undoReadBack: `not read: ${RAW}`, error: "The tool couldn't read the pilot policy back, so the undo isn't confirmed." }), { kind: "toast-warn", text: "Sophos accepted the undo, but the read-back didn't confirm it.", detail: DETAIL });
    assert.deepEqual(await undo({ ...wave, status: "undo-failed", error: RAW }), { kind: "toast-err", text: "Couldn't undo the wave.", detail: DETAIL });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2: Build rollback ----------

const step = (order, kind, name, extra = {}) => ({ order, kind, key: kind, name, method: "POST", path: kind === "policy" ? "/endpoint/v1/policies" : "/web-filters/v1/profiles", summary: "", body: {}, status: "created", id: `${kind}-1`, readBack: "matches", ...extra });
const pilotOptions = { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: [] } };
const built = { id: "00000001-0000-4000-a000-000000000000", tenantId: T, createdAt: now, status: "built", snapshotFile: "example-tenant_20261017-010000.json", pilot: pilotOptions, steps: [step(1, "profile", "Example profile"), step(2, "policy", "WF pilot: Example profile")], checks: [{ ok: true, level: "ok", text: "Profiles: 0 in the account, 1 to add, limit 20." }] };
const design = { policies: [], profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [], flags: [], diff: [], siteLists: [], categoryActions: {} }], siteLists: [], limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
const deleted = (s) => ({ ...s, status: "deleted" });

test("Build: a rollback that worked says so when only the read of the builds list after it failed, and an unconfirmed rollback isn't a failure", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const s = { rollback: null, list: "ok" };
  let reads = 0;
  const { server: srv, base } = await server({
    [`GET /api/design/${T}`]: { design, genAi: {} },
    [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
    // The page reads the list once as it opens; the read after the rollback is the one that can fail.
    [`GET /api/build/${T}`]: () => (++reads > 1 && s.list === "fail" ? { fail: 500 } : { items: [built] }),
    [`POST /api/build/${T}/${built.id}/rollback`]: (body) => (body.dryRun ? { ...built, restorePlan: [] } : s.rollback),
  });
  let b;
  try {
    b = await openBrowser();
    const roll = async (answer, list = "ok") => {
      Object.assign(s, { rollback: answer, list });
      reads = 0;
      return toastAfter(b, `${base}/build.html?tenant=${T}`, "[data-rollback]", [click("[data-rollback]")]);
    };
    const rolledBack = { ...built, status: "rolled-back", steps: built.steps.map(deleted), rollback: { at: now, steps: [{ kind: "policy", name: "WF pilot: Example profile", status: "deleted, 404 on read-back" }, { kind: "profile", name: "Example profile", status: "deleted, 404 on read-back" }] } };
    assert.deepEqual(await roll(rolledBack, "fail"), { kind: "toast-warn", text: "Rolled back. The list of builds couldn't be read again, so it doesn't show the rollback yet.", detail: DETAIL });
    assert.equal(await b.evaluate(`[...document.querySelectorAll(".steps-list .tag")].map((t) => t.textContent).join(", ")`), "Rolled back, Rolled back", "the page shows what the rollback did");
    assert.deepEqual(await roll(rolledBack), { kind: "toast-ok", text: "Rolled back.", detail: null });
    const unconfirmed = { ...built, status: "rollback-partial", steps: [{ ...built.steps[0], status: "deleted" }, { ...built.steps[1], status: "delete-failed", deleteReadBack: `not read: ${RAW}` }], rollback: { at: now, steps: [{ kind: "policy", name: "WF pilot: Example profile", status: "not confirmed", error: `A read-back couldn't read it (${RAW}), so it may still be there.` }, { kind: "profile", name: "Example profile", status: "deleted, 404 on read-back" }] } };
    assert.deepEqual(await roll(unconfirmed), { kind: "toast-warn", text: "Sophos accepted the rollback, but the read-back didn't confirm all of it.", detail: `Detail: WF pilot: Example profile: A read-back couldn't read it (${RAW}), so it may still be there.` });
    const refused = { ...built, status: "rollback-partial", steps: built.steps.map((x) => ({ ...x, status: "delete-failed" })), rollback: { at: now, steps: [{ kind: "policy", name: "WF pilot: Example profile", status: "failed", error: RAW }, { kind: "profile", name: "Example profile", status: "failed", error: RAW }] } };
    assert.deepEqual(await roll(refused), { kind: "toast-err", text: "Rollback didn't finish.", detail: `Detail: WF pilot: Example profile: ${RAW}.` });
    assert.deepEqual(await roll({ fail: 502 }), { kind: "toast-err", text: "Couldn't roll back the build.", detail: DETAIL });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- items 3 and 4: the clean-up's site lists ----------

const LISTS = ["Example cleaned Block", "Example cleaned Warn"];
const cleanupView = {
  run: { scope: T, options: { dns: true, intelix: false }, intelixLookups: 0, running: false },
  results: [
    { id: "r1", raw: "app.example.com", site: { value: "app.example.com" }, tags: ["Example tag"], override: null, action: "block", verdict: "exception", reason: "Kept until you decide.", needsDecision: false, lookup: null, dns: { status: "resolves" } },
    { id: "r2", raw: "chat.example.org", site: { value: "chat.example.org" }, tags: ["Example tag"], override: null, action: "warn", verdict: "exception", reason: "Kept until you decide.", needsDecision: false, lookup: null, dns: { status: "resolves" } },
  ],
  summary: { total: 2, covered: 0, remove: 0, exception: 2, needsDecision: 0 },
  lists: [{ name: LISTS[0], action: "block", sites: 1 }, { name: LISTS[1], action: "warn", sites: 1 }],
  leftOut: 0,
  intelix: false,
};
const row = (i, extra) => ({ name: LISTS[i], action: i ? "warn" : "block", sites: 1, id: `l${i}`, status: "created", readBack: "matches", ...extra });

test("Create site lists is green only when every list read back with the sites sent, and says which one didn't", { skip: skipBrowser, timeout: 60_000 }, async () => {
  let answer;
  const { server: srv, base } = await server({
    [`GET /api/cleanup/${T}`]: cleanupView,
    [`POST /api/cleanup/${T}/lists`]: (body) => (body.dryRun ? { lists: LISTS.map((name) => ({ name, action: "block", sites: ["app.example.com"] })), problems: [], leftOut: 0 } : { tenantId: T, scope: T, createdAt: now, lists: answer }),
  });
  let b;
  try {
    b = await openBrowser();
    const create = async (lists) => ((answer = lists), toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#create-lists", [click("#create-lists")]));
    assert.deepEqual(await create([row(0), row(1)]), { kind: "toast-ok", text: "2 site lists created and read back.", detail: null });
    assert.deepEqual(await create([row(0), row(1, { readBack: "read back 0 sites, not the 1 sent" })]), { kind: "toast-warn", text: `2 site lists created, but the read-back didn't confirm "${LISTS[1]}".`, detail: `Detail: "${LISTS[1]}": read back 0 sites, not the 1 sent.` });
    assert.deepEqual(await create([row(0, { readBack: `not read: ${RAW}` }), row(1, { readBack: "read back with other sites than were sent" })]), { kind: "toast-warn", text: "2 site lists created, but the read-back didn't confirm 2 of them.", detail: `Detail: "${LISTS[0]}": ${RAW}. "${LISTS[1]}": read back with other sites than were sent.` });
    assert.deepEqual(await create([row(0, { readBack: "read back 0 sites, not the 1 sent" }), { name: LISTS[1], action: "warn", sites: 1, status: "failed", error: RAW }]), { kind: "toast-warn", text: `1 of 2 site lists created, not confirmed on read-back. Creating "${LISTS[1]}" failed.`, detail: `Detail: ${RAW}. "${LISTS[0]}": read back 0 sites, not the 1 sent.` });
    assert.deepEqual(await create([{ name: LISTS[0], action: "block", sites: 1, status: "failed", error: RAW }, { name: LISTS[1], action: "warn", sites: 1, status: "planned" }]), { kind: "toast-err", text: `No site lists created. Creating "${LISTS[0]}" failed, so the list after it wasn't sent.`, detail: DETAIL });
  } finally {
    srv.close();
    await b?.close();
  }
});

test("Undo last lists is green only when every list read back gone, and says which delete failed or isn't confirmed, and why", { skip: skipBrowser, timeout: 60_000 }, async () => {
  let answer;
  const { server: srv, base } = await server({
    [`GET /api/cleanup/${T}`]: { ...cleanupView, lastLists: { tenantId: T, scope: T, createdAt: now, lists: [row(0), row(1)] } },
    [`POST /api/cleanup/${T}/lists`]: () => ({ tenantId: T, scope: T, createdAt: now, lists: answer }),
  });
  let b;
  try {
    b = await openBrowser();
    const undo = async (lists) => ((answer = lists), toastAfter(b, `${base}/cleanup.html?tenant=${T}`, "#undo-lists", [click("#undo-lists")]));
    const gone = (i) => row(i, { status: "deleted", readBack: "404 on read-back" });
    assert.deepEqual(await undo([gone(0), gone(1)]), { kind: "toast-ok", text: "Undone: 2 site lists deleted and read back.", detail: null });
    assert.deepEqual(await undo([gone(0), row(1, { status: "delete failed", error: "Sophos API error 403: Forbidden" })]), { kind: "toast-warn", text: `Couldn't delete "${LISTS[1]}". 1 site list deleted and read back.`, detail: `Detail: "${LISTS[1]}": Sophos API error 403: Forbidden.` });
    assert.deepEqual(await undo([row(0, { status: "in use by a profile, left", error: "Sophos API error 409: Conflict" }), row(1, { status: "delete failed", error: RAW })]), { kind: "toast-err", text: "Couldn't delete 2 of the site lists.", detail: `Detail: "${LISTS[0]}" is in use by a profile, so it was left. Sophos API error 409: Conflict. "${LISTS[1]}": ${RAW}.` });
    assert.deepEqual(await undo([gone(0), row(1, { status: "not confirmed", readBack: `not read: ${RAW}` })]), { kind: "toast-warn", text: `Sophos accepted the deletes, but the read-back didn't confirm "${LISTS[1]}".`, detail: `Detail: "${LISTS[1]}": ${RAW}.` });
    assert.deepEqual(await undo([gone(0), row(1, { status: "still there after delete", readBack: "still there" })]), { kind: "toast-warn", text: `Sophos accepted the deletes, but the read-back didn't confirm "${LISTS[1]}".`, detail: `Detail: "${LISTS[1]}" was still there after the delete.` });
  } finally {
    srv.close();
    await b?.close();
  }
});
