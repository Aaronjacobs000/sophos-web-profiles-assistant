// Guard, from v0.3.19, as drawn in a headless Chrome or Edge (skipped without
// one): category C, a toast, banner or row never claims more than what was
// confirmed. Every action that writes is answered three ways: confirmed (the
// read-back found what was sent), unconfirmed (Sophos accepted the write, or
// part of it, but the read-back failed, was partial or disagreed) and failed
// (nothing went through). Every row that reports a write's outcome is drawn
// in each state. The rules:
//   confirmed    green (toast-ok, banner-ok, tag-ok)
//   unconfirmed  amber (toast-warn, banner-warn, tag-warn), never the
//                confirmed wording, and the reason on a Detail line
//   failed       red (toast-err, banner-err, tag-bad), never the confirmed
//                wording, and the reason on a Detail line
// From v0.3.22 a write Sophos didn't answer with a success (a 5xx, or no
// answer), that nothing could be read back after, is answered too
// (unanswered): drawn as unconfirmed, and never saying Sophos accepted it.
// From v0.3.23 it never says the write didn't go through either, and it
// covers the pilot switch, a restore step, a rollback's Website Management
// change, an Allow's link, and a list or entry a create made that was found
// by name but not read back. From v0.3.24 it covers a create whose name
// lookup couldn't be read after a 5xx: a build step, an Allow's new list and
// a list from Create site lists.
// A new action or row that reports a write's outcome belongs in this table.

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
const RAW = "Sophos API error 503: ServiceUnavailable - mock refuses this";
const NOT_READ = `not read: ${RAW}`;
const UNCLEAR = "Sophos API error 500: InternalServerError - mock answers 500";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.19", readOnly: false };
const now = new Date().toISOString();
const id = (n) => `88888888-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const FAIL = { fail: 502 };

// ---------- what the pages read ----------

const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } };
const ev = (n, url) => ({ id: `e${n}`, type: "Event::Endpoint::WebControlViolation", name: `'${url}' blocked due to category 'Chat'`, created_at: now, endpoint_id: "w1", user_id: `u${n}` });
const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([ev(1, "https://chat.example.org/")]) };
const allow = (n, s, extra) => ({ id: id(n), at: now, host: `h${n}.example.com`, site: `h${n}.example.com`, buildId: "b1", profileId: "pr1", listId: "al1", listName: "Example allows", createdList: true, status: s, buildStatus: "built", ...extra });
const wave = (n, s, extra) => ({ id: id(n), at: now, buildId: "b1", policyId: "p1", devices: [{ id: `w${n}`, hostname: `EXAMPLE-PC-${String(n).padStart(2, "0")}` }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: [`w${n}`], endpointGroups: [] }, status: s, ...extra });
const promoOf = (waves) => ({
  pilot,
  policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 },
  mode: "devices",
  plan: { waves: [{ n: 1, devices: [{ id: "w9", hostname: "EXAMPLE-PC-09", group: "No group" }] }], inPilot: [{ id: "w1" }], notEligible: [] },
  waves,
  waveSize: 25,
});
const tagStep = (s, extra = {}) => ({ op: "policy-tags", policyId: "b", policyName: "Base Policy", before: [{ tag: "Example tag", action: "block" }], after: [], status: s, ...extra });
const delStep = (s, extra = {}) => ({ op: "delete-entry", id: "s1", url: "blocked.example.com", tags: ["Example tag"], status: s, ...extra });
const retireRec = (n, s, steps) => ({ id: `77777777-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, tenantId: T, at: now, tags: ["Example tag"], snapshotFile: "example-tenant_20261017-010000.json", status: s, steps, warnings: [] });
const step = (order, kind, extra = {}) => ({ order, kind, key: `${kind}-${order}`, name: `Example ${kind} ${order}`, method: "POST", path: "/web-filters/v1/site-lists", summary: "1 site, block", body: {}, status: "created", id: `${kind}-${order}`, readBack: "matches", ...extra });
const pilotOptions = { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: [] } };
const buildRec = (s, steps, extra = {}) => ({ id: "00000001-0000-4000-a000-000000000000", tenantId: T, createdAt: now, status: s, snapshotFile: "example-tenant_20261017-010000.json", pilot: pilotOptions, steps, checks: [{ ok: true, level: "ok", text: "Profiles: 0 in the account, 1 to add, limit 20." }], ...extra });
const built = buildRec("built", [step(1, "site-list"), step(2, "profile"), step(3, "policy")]);
const dryRec = buildRec("dry-run", built.steps.map((x) => ({ ...x, status: "planned", readBack: undefined, id: undefined })));
const design = { policies: [], profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [{ id: "p0", name: "Base Policy", type: "web-control" }], flags: [], diff: [], siteLists: [], categoryActions: {} }], siteLists: [], limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
const LISTS = ["Example cleaned Block", "Example cleaned Warn"];
const listRow = (i, extra) => ({ name: LISTS[i], action: i ? "warn" : "block", sites: 1, id: `l${i}`, status: "created", readBack: "matches", ...extra });
const cleanupView = (scope) => ({
  run: { scope, options: { dns: true, intelix: false }, intelixLookups: 0, running: false },
  results: [{ id: "r1", raw: "app.example.com", site: { value: "app.example.com" }, tags: ["Example tag"], override: null, action: "block", verdict: "exception", reason: "Kept until you decide.", needsDecision: false, lookup: null, dns: { status: "resolves" } }],
  summary: { total: 1, covered: 0, remove: 0, exception: 1, needsDecision: 0 },
  lists: LISTS.map((name, i) => ({ name, action: i ? "warn" : "block", sites: 1 })),
  leftOut: 0,
  lastLists: { tenantId: T, scope, createdAt: now, lists: [listRow(0), listRow(1)] },
  intelix: false,
});
const readiness = (extra = {}) => ({ tenant: { id: T, name: "Example Tenant", region: "us01" }, running: false, result: { readAt: now, durationMs: 4200, calls: 21, scorecard: buildScorecard(inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" } })), snapshot: { file: "example-tenant_20261017-010000.json", hash: "0".repeat(64), bytes: 1000 }, ...extra } });

const READS = {
  "GET /api/credentials": { mode: "tenant", tenant: { configured: true, clientId: "mock-client-id", clientSecretMasked: "••••cret", label: "Example Tenant" }, partner: { configured: false } },
  "GET /api/intelix": { configured: true, clientId: "mock-intelix-id", clientSecretMasked: "••••cret", region: "au" },
  [`GET /api/readiness/${T}`]: readiness(),
  [`GET /api/cleanup/${T}`]: cleanupView(T),
  "GET /api/cleaner": cleanupView("cleaner"),
  "GET /api/presets": { items: [{ name: "keep-it-clean", label: "Keep it clean" }] },
  [`GET /api/design/${T}`]: { design, genAi: {} },
  [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
  [`GET /api/build/${T}`]: { items: [built] },
  [`GET /api/pilot/${T}`]: { pilot, policy, store, allows: [allow(1, "added", { readBack: "site listed" })] },
  [`GET /api/pilot/${T}/digest`]: digest,
  [`GET /api/promote/${T}`]: promoOf([wave(1, "moved", { readBack: "assignment matches" })]),
  [`GET /api/retire/${T}`]: { tags: [{ tag: "Example tag", entries: 1, only: 1, policies: [] }], records: [retireRec(1, "partial", [tagStep("done", { readBack: "tags match" }), delStep("failed", { error: RAW })])] },
};

/** The frontend, with an API that answers reads from s.reads and writes from s.writes; { fail } from either is a failure with the raw answer. */
async function server() {
  const s = { status, reads: READS, writes: {} };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.all("/api/*", (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(s.status);
    const answer = req.method === "GET" ? s.reads[key] : s.writes[key];
    const out = typeof answer === "function" ? answer(req.body ?? {}) : answer;
    if (out === undefined) return res.status(404).json({ error: "not_found" });
    if (out?.fail) return res.status(out.fail).json({ error: "failed", message: RAW });
    res.json(out);
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend")));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}`, s };
}

const WATCH = `window.__uncaught = []; window.addEventListener("unhandledrejection", (e) => window.__uncaught.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__uncaught.push(String(e.message))); window.confirm = () => true;`;
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); e.click(); return true; })()`;
const change = (sel, value) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("change")); return true; })()`;
const tick = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.checked = !e.checked; e.dispatchEvent(new Event("change")); return true; })()`;
const until = (expr) => ({ until: expr });
const fileOn = (sel) => `(() => { const i = document.querySelector(${JSON.stringify(sel)}); const t = new DataTransfer(); t.items.add(new File([JSON.stringify({ items: [] })], "events.json", { type: "application/json" })); i.files = t.files; i.dispatchEvent(new Event("change")); return true; })()`;
const fillCredentials = `(() => { const f = document.querySelector("#f"); f.clientId.value = "mock-client-id"; f.clientSecret.value = "mock-client-secret"; const x = document.querySelector("#ix"); x.clientId.value = "mock-intelix-id"; x.clientSecret.value = "mock-intelix-secret"; return true; })()`;
const toReview = [click("#to-2"), `(() => { const f = document.querySelector("#cred-form"); f.clientId.value = "mock-client-id"; f.clientSecret.value = "mock-client-secret"; return true; })()`, click("#test"), until(`!document.querySelector("#to-3").disabled`), click("#to-3"), click("#save")];

/** The newest message an action left: a toast, or the banner it says, as kind (ok, warn, err), main text and Detail line. */
const OUTCOME = (banner) => `(() => {
  const e = ${banner ? `document.querySelector(${JSON.stringify(banner)})` : `[...document.querySelectorAll(".toast")].pop()`};
  if (!e) return null;
  const k = e.cloneNode(true);
  const d = k.querySelector("[data-toast-detail], [data-error-detail]");
  d?.remove();
  const cls = [...e.classList].find((c) => /^(toast|banner)-(ok|warn|err|info)$/.test(c)) ?? "";
  return { kind: cls.replace(/^(toast|banner)-/, ""), text: k.textContent.replace(/\\s+/g, " ").trim(), detail: d?.textContent ?? "" };
})()`;

/**
 * Each action that writes, by page: how to run it, the routes it calls, and
 * its answers in each state. A route's answer can be a function of the
 * request body (dry runs ask first). banner: where the action answers when
 * it isn't a toast.
 */
const listsWrite = (scope, rows) => ({ [`POST /api/${scope === "cleaner" ? "cleaner" : `cleanup/${T}`}/lists`]: (body) => (body.dryRun ? { lists: LISTS.map((name) => ({ name, action: "block", sites: ["app.example.com"] })), problems: [], leftOut: 0 } : { tenantId: T, scope, createdAt: now, lists: rows }) });
const createLists = (scope) => ({
  name: `${scope === "cleaner" ? "Site list cleaner" : "Clean up"}: Create site lists`,
  page: scope === "cleaner" ? "/site-list-cleaner.html" : `/cleanup.html?tenant=${T}`,
  ready: "#create-lists",
  steps: [click("#create-lists")],
  confirmed: listsWrite(scope, [listRow(0), listRow(1)]),
  unconfirmed: [listsWrite(scope, [listRow(0), listRow(1, { readBack: "read back 0 sites, not the 1 sent" })]), listsWrite(scope, [listRow(0, { readBack: NOT_READ }), listRow(1)]), listsWrite(scope, [listRow(0), { name: LISTS[1], action: "warn", sites: 1, status: "failed", error: RAW }])],
  unanswered: [listsWrite(scope, [{ name: LISTS[0], action: "block", sites: 1, status: "unconfirmed", answer: UNCLEAR, readBack: NOT_READ }]), listsWrite(scope, [listRow(0), { name: LISTS[1], action: "warn", sites: 1, status: "unconfirmed", answer: UNCLEAR, readBack: NOT_READ }])],
  failed: [listsWrite(scope, [{ name: LISTS[0], action: "block", sites: 1, status: "failed", error: RAW }, { name: LISTS[1], action: "warn", sites: 1, status: "planned" }]), { [`POST /api/${scope === "cleaner" ? "cleaner" : `cleanup/${T}`}/lists`]: FAIL }],
});
const undoWrite = (rows) => ({ [`POST /api/cleanup/${T}/lists`]: { tenantId: T, scope: T, createdAt: now, lists: rows } });
const gone = (i) => listRow(i, { status: "deleted", readBack: "404 on read-back" });
const moveWrite = (answer) => ({ [`POST /api/promote/${T}/wave`]: (b) => (b.dryRun ? { problems: [], policyName: pilot.policyName, before: { endpoints: ["w1"], endpointGroups: [] }, after: { endpoints: ["w1", "w9"], endpointGroups: [] }, devices: [{ id: "w9", hostname: "EXAMPLE-PC-09" }], enabled: false } : answer) });
const newWave = (s, extra) => wave(9, s, extra);
const undoWaveWrite = (answer) => ({ [`POST /api/promote/${T}/wave/${id(1)}/undo`]: answer });
const allowWrite = (entry) => ({ [`POST /api/pilot/${T}/allow`]: (b) => (b.dryRun ? { plan: { host: "chat.example.org", site: "chat.example.org", pilot, steps: [{ op: "add-site", listId: "al1", listName: "Example allows", site: "chat.example.org" }], problems: [], notes: [] } } : entry.fail ? entry : { plan: {}, entry }) });
const allowEntry = (extra) => allow(9, "added", { site: "chat.example.org", host: "chat.example.org", ...extra });
const undoAllowWrite = (answer) => ({ [`POST /api/pilot/${T}/allow/${id(1)}/undo`]: answer });
const retireWrite = (answer) => ({ [`POST /api/retire/${T}/plan`]: { tags: ["Example tag"], steps: [tagStep("planned")], problems: [], warnings: [] }, [`POST /api/retire/${T}/execute`]: answer });
const restoreWrite = (answer) => ({ [`POST /api/retire/${T}/${retireRec(1).id}/restore`]: answer });
const executeWrite = (answer) => ({ [`POST /api/build/${T}/dry-run`]: dryRec, [`POST /api/build/${T}/execute`]: answer });
const rollbackWrite = (answer) => ({ [`POST /api/build/${T}/${built.id}/rollback`]: (b) => (b.dryRun ? { ...built, restorePlan: [] } : answer) });
const rolled = (s, outs, steps = built.steps.map((x) => ({ ...x, status: "deleted" }))) => buildRec(s, steps, { rollback: { at: now, steps: outs } });
const out = (kind, s, extra) => ({ kind, name: `Example ${kind}`, id: `${kind}-1`, status: s, ...extra });

const ACTIONS = [
  {
    name: "Build: Create",
    page: `/build.html?tenant=${T}`,
    ready: "#dry",
    steps: [click("#dry"), until(`!document.querySelector("#go").disabled`), click("#go")],
    confirmed: executeWrite(built),
    unconfirmed: [
      executeWrite(buildRec("built", [step(1, "site-list", { readBack: "not-read", readBackNote: RAW }), step(2, "profile"), step(3, "policy")])),
      executeWrite(buildRec("built", [step(1, "site-list"), step(2, "profile", { readBack: "differs", readBackNote: "Read back 0 sites." }), step(3, "policy")])),
      executeWrite(buildRec("partial", [step(1, "site-list"), step(2, "profile", { status: "failed", error: RAW, readBack: undefined, id: undefined }), step(3, "policy", { status: "planned", readBack: undefined, id: undefined })])),
    ],
    unanswered: [
      executeWrite(buildRec("partial", [step(1, "site-list", { status: "unconfirmed", id: undefined, answer: UNCLEAR, readBack: "not-read", readBackNote: RAW }), step(2, "profile", { status: "planned", readBack: undefined, id: undefined }), step(3, "policy", { status: "planned", readBack: undefined, id: undefined })])),
      executeWrite(buildRec("partial", [step(1, "site-list"), step(2, "profile", { status: "unconfirmed", id: undefined, answer: UNCLEAR, readBack: "not-read", readBackNote: RAW }), step(3, "policy", { status: "planned", readBack: undefined, id: undefined })])),
    ],
    failed: [executeWrite(FAIL), executeWrite(buildRec("failed", built.steps.map((x) => ({ ...x, status: "planned", readBack: undefined, id: undefined })), { checks: [{ ok: false, level: "fail", text: "No rollback snapshot could be saved, so nothing was built.", detail: RAW }] }))],
  },
  {
    name: "Build: Roll back",
    page: `/build.html?tenant=${T}`,
    ready: "[data-rollback]",
    steps: [click("[data-rollback]")],
    confirmed: rollbackWrite(rolled("rolled-back", [out("policy", "deleted, 404 on read-back"), out("profile", "deleted, 404 on read-back")])),
    unconfirmed: [
      rollbackWrite(rolled("rollback-partial", [out("policy", "not confirmed", { error: `A read-back couldn't read it (${RAW}), so it may still be there.` }), out("profile", "deleted, 404 on read-back")])),
      rollbackWrite(rolled("rollback-partial", [out("policy", "deleted, 404 on read-back"), out("profile", "failed", { error: RAW })])),
      rollbackWrite(rolled("rollback-partial", [out("policy", "deleted, 404 on read-back"), { kind: "website-management", name: "Website Management read back", status: "not confirmed", error: "Website Management didn't read back as the snapshot has it." }])),
    ],
    unanswered: [rollbackWrite(rolled("rollback-partial", [out("policy", "deleted, 404 on read-back"), { kind: "website-management", name: "create blocked.example.com", status: "not confirmed", answer: UNCLEAR, error: `${UNCLEAR}. A read-back couldn't read Website Management (${RAW}), so the change isn't confirmed.` }]))],
    failed: [rollbackWrite(rolled("rollback-partial", [out("policy", "failed", { error: RAW }), out("profile", "failed", { error: RAW })], built.steps.map((x) => ({ ...x, status: "delete-failed" })))), rollbackWrite(FAIL)],
  },
  createLists(T),
  createLists("cleaner"),
  {
    name: "Clean up: Undo last lists",
    page: `/cleanup.html?tenant=${T}`,
    ready: "#undo-lists",
    steps: [click("#undo-lists")],
    confirmed: undoWrite([gone(0), gone(1)]),
    unconfirmed: [undoWrite([gone(0), listRow(1, { status: "not confirmed", readBack: NOT_READ })]), undoWrite([gone(0), listRow(1, { status: "still there after delete", readBack: "still there" })]), undoWrite([gone(0), listRow(1, { status: "delete failed", error: RAW })])],
    failed: [undoWrite([listRow(0, { status: "delete failed", error: RAW }), listRow(1, { status: "in use by a profile, left", error: RAW })]), undoWrite(FAIL)],
  },
  {
    name: "Clean up: a decision",
    page: `/cleanup.html?tenant=${T}`,
    ready: ".cu-decision",
    steps: [change(".cu-decision", "remove")],
    message: false, // A decision saved redraws the table; there's no message to check when it works.
    failed: [{ [`PUT /api/cleanup/${T}/decisions`]: FAIL }],
  },
  {
    name: "Design: Generative AI choice",
    page: `/design.html?tenant=${T}`,
    ready: "[data-genai]",
    steps: [change("[data-genai]", "block")],
    confirmed: { [`PUT /api/design/${T}`]: { design, genAi: { p0: "block" } } },
    failed: [{ [`PUT /api/design/${T}`]: FAIL }],
  },
  {
    name: "Pilot: Allow",
    page: `/pilot.html?tenant=${T}`,
    ready: "[data-allow]",
    steps: [click("[data-allow]"), until(`!!document.querySelector("#allow-go")`), click("#allow-go")],
    confirmed: allowWrite(allowEntry({ readBack: "site listed" })),
    unconfirmed: [allowWrite(allowEntry({ readBack: NOT_READ })), allowWrite(allowEntry({ readBack: "not found" })), allowWrite(allowEntry({ readBack: "list holds the site; profile read back without the link" })), allowWrite(allowEntry({ readBack: `${NOT_READ}; profile links it as allow` }))],
    unanswered: [
      allowWrite(allowEntry({ readBack: NOT_READ, answer: UNCLEAR })),
      allowWrite(allowEntry({ status: "partial", readBack: `list holds the site; profile not read: ${RAW}`, answer: UNCLEAR, error: RAW })),
      allowWrite(allowEntry({ readBack: `${NOT_READ}; profile links it as allow`, answer: UNCLEAR })),
      allowWrite(allowEntry({ status: "unconfirmed", listId: undefined, createdList: false, readBack: NOT_READ, answer: UNCLEAR })),
    ],
    failed: [allowWrite(FAIL)],
  },
  {
    name: "Pilot: Undo an Allow",
    page: `/pilot.html?tenant=${T}`,
    ready: "[data-undo]",
    steps: [click("[data-undo]")],
    confirmed: undoAllowWrite(allow(1, "undone", { undo: ["Site removed, confirmed on read-back."] })),
    unconfirmed: [undoAllowWrite(allow(1, "undo-failed", { undoReadBack: NOT_READ, error: "The list couldn't be read back, so the removal isn't confirmed.", undo: ["The list couldn't be read back, so the removal isn't confirmed."] })), undoAllowWrite(allow(1, "undone", { undo: ["The profile couldn't be read back, so the unlink isn't confirmed.", "List deleted, 404 on read-back."] }))],
    unanswered: [undoAllowWrite(allow(1, "undo-failed", { undoReadBack: NOT_READ, undoAnswer: UNCLEAR, error: "The list couldn't be read back, so the removal isn't confirmed.", undo: ["The list couldn't be read back, so the removal isn't confirmed."] })), undoAllowWrite(allow(1, "undone", { undoAnswer: UNCLEAR, undo: ["The profile couldn't be read back, so the unlink isn't confirmed.", "List deleted, 404 on read-back."] }))],
    failed: [undoAllowWrite(allow(1, "undo-failed", { error: RAW, undo: [] })), undoAllowWrite(FAIL)],
  },
  {
    name: "Pilot: Collect every few hours",
    page: `/pilot.html?tenant=${T}`,
    ready: "#schedule",
    steps: [tick("#schedule")],
    confirmed: { [`PUT /api/pilot/${T}/schedule`]: { tenantId: T, enabled: true, runs: [] } },
    unconfirmed: [{ [`PUT /api/pilot/${T}/schedule`]: { tenantId: T, enabled: false, runs: [] } }],
    failed: [{ [`PUT /api/pilot/${T}/schedule`]: FAIL }],
  },
  {
    name: "Pilot: Import events",
    page: `/pilot.html?tenant=${T}`,
    ready: "#import",
    steps: [fileOn("#import")],
    confirmed: { [`POST /api/pilot/${T}/import`]: { at: now, source: "import", ok: true, pages: 1, fetched: 0, web: 0, added: 0 } },
    failed: [{ [`POST /api/pilot/${T}/import`]: FAIL }],
  },
  {
    name: "Promote: Turn on",
    page: `/promote.html?tenant=${T}`,
    ready: "#toggle",
    steps: [click("#toggle")],
    confirmed: { [`POST /api/promote/${T}/enabled`]: { enabled: true, readBack: "matches" } },
    unconfirmed: [{ [`POST /api/promote/${T}/enabled`]: { enabled: true, readBack: "differs" } }, { [`POST /api/promote/${T}/enabled`]: { enabled: true, readBack: NOT_READ } }],
    unanswered: [{ [`POST /api/promote/${T}/enabled`]: { enabled: true, readBack: NOT_READ, answer: UNCLEAR } }],
    failed: [{ [`POST /api/promote/${T}/enabled`]: FAIL }],
  },
  {
    name: "Promote: Move wave",
    page: `/promote.html?tenant=${T}`,
    ready: "[data-wave]",
    steps: [click("[data-wave]")],
    confirmed: moveWrite(newWave("moved", { readBack: "assignment matches" })),
    unconfirmed: [moveWrite(newWave("moved", { readBack: NOT_READ })), moveWrite(newWave("failed", { readBack: NOT_READ, error: "The tool couldn't read the pilot policy back, so the move isn't confirmed." })), moveWrite(newWave("failed", { readBack: "assignment differs", error: "The policy read back without the new devices." }))],
    unanswered: [moveWrite(newWave("unconfirmed", { readBack: NOT_READ, answer: UNCLEAR, error: "The tool couldn't read the pilot policy back, so the move isn't confirmed." }))],
    failed: [moveWrite(newWave("failed", { error: RAW })), moveWrite(FAIL)],
  },
  {
    name: "Promote: Undo a wave",
    page: `/promote.html?tenant=${T}`,
    ready: "[data-undo-wave]",
    steps: [click("[data-undo-wave]")],
    confirmed: undoWaveWrite(wave(1, "undone", { readBack: "assignment back as before the wave" })),
    unconfirmed: [undoWaveWrite(wave(1, "undo-failed", { readBack: "assignment matches", undoReadBack: NOT_READ, error: "The tool couldn't read the pilot policy back, so the undo isn't confirmed." })), undoWaveWrite(wave(1, "undo-failed", { readBack: "assignment matches", undoReadBack: "assignment differs", error: "The policy didn't read back with the earlier assignment." }))],
    unanswered: [undoWaveWrite(wave(1, "undo-failed", { readBack: "assignment matches", undoReadBack: NOT_READ, undoAnswer: UNCLEAR, error: "The tool couldn't read the pilot policy back, so the undo isn't confirmed." }))],
    failed: [undoWaveWrite(wave(1, "undo-failed", { readBack: "assignment matches", error: RAW })), undoWaveWrite(FAIL)],
  },
  {
    name: "Promote: Retire",
    page: `/promote.html?tenant=${T}`,
    ready: 'input[name="tag"]',
    steps: [click('input[name="tag"]'), click("#plan-retire"), until(`!!document.querySelector("#go-retire")`), click("#go-retire")],
    confirmed: retireWrite(retireRec(9, "retired", [tagStep("done", { readBack: "tags match" }), delStep("done", { readBack: "404 on read-back" })])),
    unconfirmed: [
      retireWrite(retireRec(9, "failed", [tagStep("failed", { readBack: NOT_READ, error: "The tool couldn't read it back, so the change isn't confirmed." }), delStep("planned")])),
      retireWrite(retireRec(9, "partial", [tagStep("done", { readBack: "tags match" }), delStep("failed", { error: RAW })])),
      retireWrite(retireRec(9, "partial", [tagStep("done", { readBack: "tags match" }), delStep("failed", { readBack: "still there", error: "Read back: still there." })])),
    ],
    unanswered: [retireWrite(retireRec(9, "partial", [tagStep("unconfirmed", { readBack: NOT_READ, answer: UNCLEAR, error: "The tool couldn't read it back, so the change isn't confirmed." }), delStep("done", { readBack: "404 on read-back" })]))],
    failed: [retireWrite(retireRec(9, "failed", [tagStep("failed", { error: RAW }), delStep("planned")])), retireWrite(FAIL)],
  },
  {
    name: "Promote: Restore",
    page: `/promote.html?tenant=${T}`,
    ready: "[data-restore]",
    steps: [click("[data-restore]")],
    confirmed: restoreWrite(retireRec(1, "restored", [tagStep("restored", { readBack: "tags match" }), delStep("restored", { readBack: "re-created, matches" })])),
    unconfirmed: [restoreWrite(retireRec(1, "restore-partial", [tagStep("restore-failed", { readBack: NOT_READ, error: "The tool couldn't read it back, so the restore isn't confirmed." }), delStep("restored", { readBack: "re-created, matches" })])), restoreWrite(retireRec(1, "restore-partial", [tagStep("restored", { readBack: "tags match" }), delStep("restore-failed", { error: RAW })]))],
    unanswered: [restoreWrite(retireRec(1, "restore-partial", [tagStep("restore-failed", { readBack: NOT_READ, answer: UNCLEAR, error: "The tool couldn't read it back, so the restore isn't confirmed." }), delStep("restored", { readBack: "re-created, matches" })]))],
    failed: [restoreWrite(retireRec(1, "restore-partial", [tagStep("restore-failed", { error: RAW }), delStep("restore-failed", { error: RAW })])), restoreWrite(FAIL)],
  },
  {
    name: "Readiness: Check again (the snapshot)",
    page: `/readiness.html?tenant=${T}`,
    ready: "#rerun",
    steps: [click("#rerun")],
    confirmed: { [`POST /api/readiness/${T}/run`]: readiness() },
    failed: [{ [`POST /api/readiness/${T}/run`]: readiness({ snapshot: null, snapshotError: RAW }) }],
  },
  {
    name: "Credentials: Save",
    page: "/credentials.html",
    ready: "#save",
    steps: [fillCredentials, click("#save")],
    banner: "#out .banner",
    // Saved and connected goes to the next page; the message there is the one to check by hand.
    unconfirmed: [{ "PUT /api/credentials": { ok: true, status: { ...status, status: "configured-invalid", error: RAW } } }],
    failed: [{ "PUT /api/credentials": FAIL }],
  },
  {
    name: "Credentials: Save Intelix",
    page: "/credentials.html",
    ready: "#ix-save",
    steps: [fillCredentials, click("#ix-save")],
    confirmed: { "PUT /api/intelix": { configured: true, clientId: "mock-intelix-id", clientSecretMasked: "••••cret", region: "au" } },
    failed: [{ "PUT /api/intelix": FAIL }],
    failedBanner: "#ix-out .banner",
  },
  {
    name: "Setup: Save",
    page: "/welcome.html",
    ready: "#to-2",
    steps: toReview,
    banner: "#review .banner",
    unconfirmed: [{ "POST /api/credentials/test": { ok: true, idType: "tenant", tenant }, "PUT /api/credentials": { ok: true, status: { ...status, status: "configured-invalid", error: RAW } } }],
    failed: [{ "POST /api/credentials/test": { ok: true, idType: "tenant", tenant }, "PUT /api/credentials": FAIL }],
  },
];

/** Splits text into its sentences. */
const sentences = (t) => t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

/** What's wrong with a message for its state, given the confirmed message of the same action. */
function judge(where, state, got, confirmedText) {
  const out = [];
  if (!got) return [`${where}: no message`];
  const want = { confirmed: "ok", unconfirmed: "warn", unanswered: "warn", failed: "err" }[state];
  if (got.kind !== want) out.push(`${where}: ${state} drawn as ${got.kind || "no color"}, not ${want}: "${got.text}"`);
  if (state === "unanswered" && /\baccepted\b/i.test(got.text)) out.push(`${where}: says Sophos accepted a write it didn't answer with a success: "${got.text}"`);
  if (state === "unanswered" && /didn't go through/i.test(got.text)) out.push(`${where}: says a write nothing could be read back for didn't go through: "${got.text}"`);
  if (state !== "confirmed") {
    if (!got.detail.replace(/^Detail:\s*/, "").trim()) out.push(`${where}: ${state} without a reason on the Detail line: "${got.text}"`);
    if (confirmedText) {
      const head = sentences(confirmedText)[0];
      if (sentences(got.text).includes(head)) out.push(`${where}: ${state} uses the confirmed wording "${head}": "${got.text}"`);
    }
  }
  return out;
}

test("no toast or banner after a write claims more than its read-back confirmed", { skip: skipBrowser, timeout: 600_000 }, async () => {
  const { server: srv, base, s } = await server();
  let b;
  try {
    b = await openBrowser();
    await b.call("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
    const wrong = [];
    for (const a of ACTIONS) {
      let confirmedText = "";
      const runs = [...(a.confirmed ? [["confirmed", a.confirmed]] : []), ...(a.unconfirmed ?? []).map((w) => ["unconfirmed", w]), ...(a.unanswered ?? []).map((w) => ["unanswered", w]), ...(a.failed ?? []).map((w) => ["failed", w])];
      for (const [i, [state, writes]] of runs.entries()) {
        const where = `${a.name} (${state} ${i})`;
        s.writes = writes;
        try {
          await b.open(`${base}${a.page}`, 1440, a.ready);
          await b.evaluate(`document.querySelectorAll(".toast").forEach((t) => t.remove()); true`);
          for (const st of a.steps) {
            if (typeof st === "string") await b.evaluate(st);
            else for (let k = 0; k < 100 && !(await b.evaluate(st.until)); k++) await new Promise((r) => setTimeout(r, 100));
            await new Promise((r) => setTimeout(r, 150));
          }
          if (a.message === false && state === "confirmed") continue;
          const banner = state === "failed" && a.failedBanner ? a.failedBanner : a.banner;
          let got = null;
          for (let k = 0; k < 100 && !got; k++) {
            got = await b.evaluate(OUTCOME(banner));
            if (!got) await new Promise((r) => setTimeout(r, 100));
          }
          if (state === "confirmed") confirmedText = got?.text ?? "";
          wrong.push(...judge(where, state, got, confirmedText));
          const uncaught = await b.evaluate("window.__uncaught ?? []");
          if (uncaught.length) wrong.push(`${where}: uncaught: ${uncaught.join("; ")}`);
        } catch (err) {
          wrong.push(`${where}: ${err.message}`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- rows ----------

/**
 * Each list of rows that reports a write's outcome, with records in every
 * state, and how to read each row's tag and Detail line. state: confirmed,
 * unconfirmed, unanswered (unconfirmed, with a note that never says Sophos
 * accepted it), failed, or done (an outcome with nothing to confirm now, such
 * as undone or rolled back, drawn muted).
 */
const ROWS = [
  {
    name: "Build: the plan's steps",
    page: `/build.html?tenant=${T}`,
    reads: { [`GET /api/build/${T}`]: { items: [buildRec("rollback-partial", [
      step(1, "site-list"),
      step(2, "site-list", { readBack: "differs", readBackNote: "Read back 0 sites named \"Example site-list 2\"." }),
      step(3, "site-list", { readBack: "not-read", readBackNote: RAW }),
      step(4, "site-list", { readBack: undefined }),
      step(5, "profile", { status: "failed", error: RAW, readBack: undefined, id: undefined }),
      step(6, "site-list", { status: "deleted" }),
      step(7, "profile", { status: "delete-failed", deleteReadBack: NOT_READ }),
      step(8, "policy", { status: "delete-failed" }),
      step(9, "policy", { status: "planned", readBack: undefined, id: undefined }),
      step(10, "site-list", { status: "delete-failed", deleteError: `${UNCLEAR}. A read-back still found the list, so it wasn't deleted.` }),
      step(11, "site-list", { status: "unconfirmed", id: undefined, answer: UNCLEAR, readBack: "not-read", readBackNote: RAW }),
    ], { rollback: { at: now, steps: [out("profile", "not confirmed", { id: "profile-7", error: `A read-back couldn't read it (${RAW}), so it may still be there.` }), out("policy", "failed", { id: "policy-8", error: RAW })] } })] } },
    rows: ".steps-list > li",
    states: ["confirmed", "unconfirmed", "unconfirmed", "unconfirmed", "failed", "done", "unconfirmed", "failed", "done", "failed", "unanswered"],
  },
  {
    name: "Promote: Waves moved",
    page: `/promote.html?tenant=${T}`,
    reads: { [`GET /api/promote/${T}`]: promoOf([
      wave(1, "moved", { readBack: "assignment matches" }),
      wave(2, "moved", { readBack: NOT_READ }),
      wave(3, "failed", { readBack: NOT_READ, error: "The tool couldn't read the pilot policy back, so the move isn't confirmed." }),
      wave(4, "failed", { readBack: "assignment differs", error: "The policy read back without the new devices." }),
      wave(5, "failed", { error: RAW }),
      wave(6, "undone", { readBack: "assignment back as before the wave" }),
      wave(7, "undo-failed", { readBack: "assignment matches", undoReadBack: NOT_READ, error: "The tool couldn't read the pilot policy back, so the undo isn't confirmed." }),
      wave(8, "undo-failed", { readBack: "assignment matches", error: RAW }),
      wave(9, "unconfirmed", { readBack: NOT_READ, answer: UNCLEAR, error: "The tool couldn't read the pilot policy back, so the move isn't confirmed." }),
      wave(10, "undo-failed", { readBack: "assignment matches", undoReadBack: NOT_READ, undoAnswer: UNCLEAR, error: "The tool couldn't read the pilot policy back, so the undo isn't confirmed." }),
    ]) },
    rows: ".wave-list > li",
    scope: "Waves moved",
    states: ["confirmed", "unconfirmed", "unconfirmed", "unconfirmed", "failed", "done", "unconfirmed", "failed", "unanswered", "unanswered"],
  },
  {
    name: "Pilot: Allow entries",
    page: `/pilot.html?tenant=${T}`,
    reads: { [`GET /api/pilot/${T}`]: { pilot, policy, store, allows: [
      allow(1, "added", { readBack: "site listed" }),
      allow(2, "added", { readBack: "list holds the site; profile links it as allow" }),
      allow(3, "added", { readBack: NOT_READ }),
      allow(4, "added", { readBack: "not found" }),
      allow(5, "added", { readBack: `${NOT_READ}; profile links it as allow` }),
      allow(6, "failed", { listName: "", error: RAW }),
      allow(7, "undone", { readBack: "site listed" }),
      allow(8, "undo-failed", { readBack: "site listed", undoReadBack: NOT_READ, error: "The list couldn't be read back, so the removal isn't confirmed." }),
      allow(9, "undo-failed", { readBack: "site listed", error: RAW }),
      allow(10, "added", { readBack: NOT_READ, buildStatus: "rolled-back" }),
      allow(11, "added", { readBack: NOT_READ, answer: UNCLEAR }),
      allow(12, "undo-failed", { readBack: "site listed", undoReadBack: NOT_READ, undoAnswer: UNCLEAR, error: "The list couldn't be read back, so the removal isn't confirmed." }),
      allow(13, "partial", { readBack: `list holds the site; profile not read: ${RAW}`, answer: UNCLEAR, error: RAW }),
      allow(14, "added", { readBack: `${NOT_READ}; profile links it as allow`, answer: UNCLEAR }),
      allow(15, "unconfirmed", { listId: undefined, createdList: false, readBack: NOT_READ, answer: UNCLEAR }),
    ] } },
    rows: ".order-list > li",
    scope: "Allow entries",
    states: ["confirmed", "confirmed", "unconfirmed", "unconfirmed", "unconfirmed", "failed", "done", "unconfirmed", "failed", "done", "unanswered", "unanswered", "unanswered", "unanswered", "unanswered"],
  },
  {
    name: "Promote: Retired",
    page: `/promote.html?tenant=${T}`,
    reads: { [`GET /api/retire/${T}`]: { tags: [], records: [
      retireRec(1, "retired", [tagStep("done", { readBack: "tags match" })]),
      retireRec(2, "failed", [tagStep("failed", { error: RAW }), delStep("planned")]),
      retireRec(3, "failed", [tagStep("failed", { readBack: NOT_READ, error: "The tool couldn't read it back, so the change isn't confirmed." }), delStep("planned")]),
      retireRec(4, "partial", [tagStep("done", { readBack: "tags match" }), delStep("failed", { error: RAW })]),
      retireRec(5, "restored", [tagStep("restored", { readBack: "tags match" })]),
      retireRec(6, "restore-partial", [tagStep("restore-failed", { readBack: "tags differ", error: "Read back: tags differ." }), delStep("restored", { readBack: "re-created, matches" })]),
      retireRec(7, "restore-partial", [tagStep("restore-failed", { error: RAW }), delStep("restore-failed", { error: RAW })]),
      retireRec(8, "partial", [tagStep("unconfirmed", { readBack: NOT_READ, answer: UNCLEAR, error: "The tool couldn't read it back, so the change isn't confirmed." }), delStep("done", { readBack: "404 on read-back" })]),
      retireRec(9, "restore-partial", [tagStep("restore-failed", { readBack: NOT_READ, answer: UNCLEAR, error: "The tool couldn't read it back, so the restore isn't confirmed." }), delStep("restored", { readBack: "re-created, matches" })]),
    ] } },
    rows: ".retired-table tbody tr",
    states: ["confirmed", "failed", "unconfirmed", "unconfirmed", "done", "unconfirmed", "failed", "unanswered", "unanswered"],
  },
];

/** Each row of a list: its tag's color and text, and its Detail line. */
const ROWS_LOOK = (sel, scope) => `(() => {
  const root = ${scope ? `[...document.querySelectorAll(".panel-card")].find((c) => c.querySelector("h2")?.textContent === ${JSON.stringify(scope)}) ?? document` : "document"};
  return [...root.querySelectorAll(${JSON.stringify(sel)})].map((r) => {
    const t = r.querySelector(".tag");
    const d = r.querySelector("[data-error-detail], [data-allow-detail]");
    const k = r.cloneNode(true);
    k.querySelectorAll("[data-error-detail], [data-allow-detail]").forEach((x) => x.remove());
    return { cls: [...(t?.classList ?? [])].find((c) => /^tag-(ok|warn|bad|muted)$/.test(c)) ?? "", tag: t?.textContent.trim() ?? "", detail: d?.textContent.replace(/^Detail:\\s*/, "").trim() ?? "", text: k.textContent };
  });
})()`;

test("no row that reports a write's outcome claims more than its read-back confirmed", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const { server: srv, base, s } = await server();
  let b;
  try {
    b = await openBrowser();
    const wrong = [];
    for (const list of ROWS) {
      s.reads = { ...READS, ...list.reads };
      await b.open(`${base}${list.page}`, 1440, list.rows);
      const rows = await b.evaluate(ROWS_LOOK(list.rows, list.scope));
      if (rows.length !== list.states.length) wrong.push(`${list.name}: ${rows.length} rows drawn, ${list.states.length} expected`);
      const confirmedTags = new Set(rows.filter((_, i) => list.states[i] === "confirmed").map((r) => r.tag));
      rows.forEach((r, i) => {
        const state = list.states[i];
        const where = `${list.name}, row ${i + 1} (${state})`;
        const want = { confirmed: "tag-ok", unconfirmed: "tag-warn", unanswered: "tag-warn", failed: "tag-bad", done: "tag-muted" }[state];
        if (r.cls !== want) wrong.push(`${where}: tag "${r.tag}" is ${r.cls || "no color"}, not ${want}`);
        if (state === "unanswered" && /\baccepted\b/i.test(r.text)) wrong.push(`${where}: says Sophos accepted a write it didn't answer with a success`);
        if (state === "unanswered" && /didn't go through/i.test(r.text)) wrong.push(`${where}: says a write nothing could be read back for didn't go through`);
        if (state === "unconfirmed" || state === "unanswered" || state === "failed") {
          if (confirmedTags.has(r.tag)) wrong.push(`${where}: uses the confirmed label "${r.tag}"`);
          if (!r.detail) wrong.push(`${where}: no reason on the Detail line`);
        }
      });
    }
    s.reads = READS;
    assert.deepEqual(wrong, []);
  } finally {
    srv.close();
    await b?.close();
  }
});

test("Compare with snapshot is green only when every section was compared and matched", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server: srv, base, s } = await server();
  const section = (name, extra = {}) => ({ section: name, matched: 1, changed: [], missing: [], extra: [], ...extra });
  const diff = (extra) => ({ snapshotFile: "example-tenant_20261017-010000.json", readAt: now, intact: true, matches: true, identical: true, othersCount: 0, unread: [], sections: [section("webControlPolicies")], ...extra });
  let b;
  try {
    b = await openBrowser();
    const tagFor = async (answer) => {
      s.writes = { [`POST /api/diff/${T}`]: answer };
      await b.open(`${base}/build.html?tenant=${T}`, 1440, "[data-diff]");
      await b.evaluate(click("[data-diff]"));
      await b.waitFor(".panel-card h2 + .spacer, .card-head .tag");
      for (let k = 0; k < 50 && !(await b.evaluate(`[...document.querySelectorAll("h2")].some((h) => h.textContent.startsWith("Tenant compared with"))`)); k++) await new Promise((r) => setTimeout(r, 100));
      return b.evaluate(`(() => { const c = [...document.querySelectorAll(".panel-card")].find((x) => x.querySelector("h2")?.textContent.startsWith("Tenant compared with")); const t = c.querySelector(".card-head .tag"); return { cls: [...t.classList].find((x) => x.startsWith("tag-")), tag: t.textContent.trim(), unread: c.querySelector("[data-diff-unread]")?.textContent.trim() ?? null }; })()`);
    };
    assert.deepEqual(await tagFor(diff()), { cls: "tag-ok", tag: "Identical to the snapshot", unread: null });
    assert.deepEqual(await tagFor(diff({ identical: false })), { cls: "tag-ok", tag: "Matches for everything this tool touched", unread: null });
    assert.deepEqual(await tagFor(diff({ unread: ["websiteManagement", "siteLists"] })), { cls: "tag-warn", tag: "Not confirmed: 2 sections not read", unread: "Not compared, because the snapshot or the tenant now couldn't be read there: Website Management, site lists." });
    assert.deepEqual(await tagFor(diff({ matches: false, identical: false, unread: ["siteLists"], sections: [section("webControlPolicies", { changed: [{ id: "p", name: "Base Policy", fields: ["enabled"] }] })] })), { cls: "tag-bad", tag: "Differs", unread: "Not compared, because the snapshot or the tenant now couldn't be read there: site lists." });
  } finally {
    srv.close();
    await b?.close();
  }
});

test("the rollback snapshot bar and the unfinished rollback note claim only what was read", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const { server: srv, base, s } = await server();
  const refused = { ok: false, status: 503, error: RAW };
  let b;
  try {
    b = await openBrowser();
    // Web Control policies and site lists couldn't be read: the snapshot holds neither, and the bar doesn't count them.
    s.reads = { ...READS, [`GET /api/readiness/${T}`]: { ...readiness(), result: { ...readiness().result, scorecard: buildScorecard(inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" }, webControlPolicies: refused, siteLists: refused })) } } };
    await b.open(`${base}/readiness.html?tenant=${T}`, 1440, ".snapshot-bar");
    const bar = await b.evaluate(`document.querySelector(".snapshot-bar p").textContent.replace(/\\s+/g, " ").trim()`);
    assert.ok(!/Web Control polic/.test(bar.split("It doesn't hold")[0]), bar);
    assert.ok(!/site list/.test(bar.split("It doesn't hold")[0].replace("every profile", "")), bar);
    assert.match(bar, /It doesn't hold what couldn't be read: Web Control policies, site lists\./);
    // An unfinished rollback whose delete wasn't confirmed: the objects may still be there, not are.
    s.reads = { ...READS, [`GET /api/promote/${T}`]: { ...promoOf([]), pilot: { ...pilot, rollbackUnfinished: { at: now, reason: `A read-back couldn't read it (${RAW}), so it may still be there.`, left: [{ kind: "policy", name: pilot.policyName }] } } } };
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".banner-warn");
    const note = await b.evaluate(`(() => { const e = document.querySelector(".banner-warn").cloneNode(true); e.querySelector("[data-error-detail]")?.remove(); return e.textContent.replace(/\\s+/g, " ").trim(); })()`);
    assert.ok(!/Still in the tenant/.test(note), note);
    assert.match(note, /^The rollback didn't finish\. These may still be in the tenant: the policy "WF pilot: Example profile"\./);
  } finally {
    srv.close();
    await b?.close();
  }
});
