// v0.3.23, as drawn in a headless Chrome or Edge (skipped without one), from
// records the services make against an in-memory tenant: after a 5xx, the
// pilot switch's toast says what the read-back found (green, red with why, or
// amber with what Sophos said); a restore, or a rollback's Website Management
// change, that nothing could be read back for isn't called accepted; an Allow
// whose link to the profile couldn't be read back isn't said to have failed,
// and one whose new list was found by name but not read back isn't called
// accepted; and an Allow undo's list delete that a read-back still found is
// red on the Build page with why on its Detail line.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import { summarize } from "../backend/dist/domain/digest.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { getBuild, rollback, saveRecord } from "../backend/dist/services/build-service.js";
import { activePilot, addAllow, loadPilotRecord, readPilotPolicy, undoAllow } from "../backend/dist/services/pilot-service.js";
import { promotionView, setPilotEnabled } from "../backend/dist/services/promote-service.js";
import { restoreRetire, retire } from "../backend/dist/services/retire-service.js";
import { runReadiness } from "../backend/dist/services/readiness.js";
import { T, TOOL, UNAVAILABLE, UNCLEAR, Tenant, afterWrite, ctxOf, dataDirFor, retireTenant, seedPilot } from "./memory-tenant.mjs";
import { openBrowser, skipBrowser } from "./browser.mjs";

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.23", readOnly: false };
const now = new Date().toISOString();
/** What a page's Detail line says for a write Sophos answered 500 that no read-back could read after. */
const SAID = `Detail: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`;

/** The frontend with an API whose routes answer as set: a body, a function of the request body, or { status, body }. */
async function server(routes) {
  const app = express();
  app.use(express.json());
  app.all("/api/*", async (req, res) => {
    const key = `${req.method} ${req.path}`;
    if (key === "GET /api/status") return res.json(status);
    const route = routes[key];
    if (route === undefined) return res.status(404).json({ error: "not_found" });
    const out = typeof route === "function" ? await route(req.body ?? {}) : route;
    if (out?.status && out.body) return res.status(out.status).json(out.body);
    res.json(out);
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

/** Each row of a card: its tag's text and class, its plain note and its Detail line. */
const ROWS = (card, sel) => `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === ${JSON.stringify(card)});
  return [...c.querySelectorAll(${JSON.stringify(sel)})].map((r) => {
    const t = r.querySelector(".tag");
    return [t ? [t.textContent.trim(), [...t.classList].find((x) => /^tag-(ok|warn|bad|muted)$/.test(x))] : null, r.querySelector(".err-note, .o-note")?.textContent.trim() ?? null, r.querySelector("[data-error-detail], [data-allow-detail]")?.textContent.trim() ?? null];
  });
})()`;

const design = { policies: [], profiles: [{ key: "profile", name: "Example profile", mode: "preset", preset: "keep-it-clean", sourcePolicies: [], flags: [], diff: [], siteLists: [], categoryActions: {} }], siteLists: [], limits: { profiles: { planned: 1, existing: 0, limit: 20 }, siteLists: { planned: 0, existing: 0, limit: 20 } }, cleanedUp: false, warnings: [] };
const buildReads = (items) => ({ [`GET /api/design/${T}`]: { design, genAi: {} }, [`GET /api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] }, [`GET /api/build/${T}`]: () => ({ items: items() }) });

// ---------- item 1: the pilot switch ----------

test("Promote: the pilot switch Sophos answered 500 says what the read-back found, and never that Sophos accepted it", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0323-pages-switch");
  const tenant = new Tenant();
  const { policyId } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const POLICY = new RegExp(`/policies/${policyId}$`);
  const view = await promotionView(dataDir, ctx, null);
  const answers = {};
  tenant.unclear("PATCH", POLICY);
  answers.made = await setPilotEnabled(dataDir, ctx, true);
  tenant.rules.length = 0;
  tenant.policies.get(policyId).enabled = false;
  tenant.unclear("PATCH", POLICY);
  tenant.refuse("GET", POLICY, 503, afterWrite(tenant));
  answers.unread = await setPilotEnabled(dataDir, ctx, true);
  tenant.rules.length = 0;
  tenant.policies.get(policyId).enabled = false;
  tenant.ignore("PATCH", POLICY);
  tenant.unclear("PATCH", POLICY);
  answers.unmade = { status: 400, body: { error: "failed", message: await setPilotEnabled(dataDir, ctx, true).then(() => "", (err) => err.message) } };
  tenant.rules.length = 0;
  let answer;
  const { server: srv, base } = await server({ [`GET /api/promote/${T}`]: view, [`GET /api/retire/${T}`]: { tags: [], records: [] }, [`POST /api/promote/${T}/enabled`]: () => answer });
  let b;
  try {
    b = await openBrowser();
    const toggle = async (which) => {
      answer = answers[which];
      return toastAfter(b, `${base}/promote.html?tenant=${T}`, "#toggle", [click("#toggle")]);
    };
    assert.deepEqual(await toggle("made"), { kind: "toast-ok", text: "Pilot turned on and read back.", detail: null });
    assert.deepEqual(await toggle("unread"), { kind: "toast-warn", text: "Sophos didn't say turning the pilot on went through, and the read-back didn't confirm it.", detail: SAID });
    assert.deepEqual(await toggle("unmade"), { kind: "toast-err", text: "Couldn't turn the pilot on.", detail: `Detail: ${UNCLEAR}. A read-back found the pilot still off, so it wasn't turned on.` });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- items 2 and 4: a restore ----------

test("Promote: a restore Sophos answered 500 says what each read-back found, and never calls one it couldn't read accepted", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const records = {};
  for (const [name, rules] of Object.entries({
    // The tags and the untagged entry put back, with every read by id failing after: neither is known.
    unread: (t) => {
      t.unclear("PATCH", /./);
      t.refuse("GET", /\/(local-sites|policies)\/[^/]+$/, 503, afterWrite(t, t.writes + 1));
    },
    // The deleted entry re-created, found by its URL, then not read back.
    recreated: (t) => {
      t.unclear("POST", /\/local-sites$/);
      t.refuse("GET", /\/local-sites\/[^/]+$/, 503, afterWrite(t));
    },
    // The tags not put back, and read back so.
    unchanged: (t) => {
      t.ignore("PATCH", /\/policies\//);
      t.unclear("PATCH", /\/policies\//);
    },
  })) {
    const dataDir = await dataDirFor(`v0323-pages-restore-${name}`);
    const { tenant } = await retireTenant(dataDir);
    const rec = await retire(dataDir, ctxOf(tenant), ["old"], true, TOOL);
    rules(tenant);
    records[name] = await restoreRetire(dataDir, ctxOf(tenant), rec.id);
  }
  // The Retired card shows the record the last restore left; Restore sends it again.
  let shown;
  const { server: srv, base } = await server({
    [`GET /api/promote/${T}`]: { pilot: null, policy: null, mode: "none", plan: null, waves: [], waveSize: 25 },
    [`GET /api/retire/${T}`]: () => ({ tags: [], records: [shown] }),
    ...Object.fromEntries(Object.values(records).map((r) => [`POST /api/retire/${T}/${r.id}/restore`, r])),
  });
  let b;
  try {
    b = await openBrowser();
    const look = async (r) => {
      shown = r;
      await b.open(`${base}/promote.html?tenant=${T}`, 1440, ".retired-table");
      const [row] = await b.evaluate(ROWS("Retired", ".retired-table tbody tr"));
      const steps = await b.evaluate(`document.querySelector(".retired-table .r-steps").firstChild.textContent`);
      const toast = await toastAfter(b, `${base}/promote.html?tenant=${T}`, "[data-restore]", [click("[data-restore]")]);
      return { row, steps, toast };
    };
    const unread = await look(records.unread);
    assert.deepEqual(unread.row, [["Restore not confirmed", "tag-warn"], null, `Detail: Sales: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`]);
    assert.deepEqual(unread.toast, { kind: "toast-warn", text: "The restore isn't confirmed: Sophos didn't say 2 steps went through, and the read-back didn't confirm them.", detail: `Detail: Sales: ${UNCLEAR}. Read back: ${UNAVAILABLE}.` });
    const recreated = await look(records.recreated);
    assert.deepEqual(recreated.row, [["Restore not confirmed", "tag-warn"], null, `Detail: a.example.com: ${UNCLEAR}. Read back: ${UNAVAILABLE}.`]);
    assert.deepEqual(recreated.toast, { kind: "toast-warn", text: "The restore isn't confirmed: Sophos didn't say a step went through, and the read-back didn't confirm it.", detail: `Detail: a.example.com: ${UNCLEAR}. Read back: ${UNAVAILABLE}.` });
    const unchanged = await look(records.unchanged);
    assert.deepEqual(unchanged.row, [["Restore didn't finish", "tag-warn"], null, `Detail: Sales: ${UNCLEAR}. A read-back found it unchanged (tags differ), so it wasn't restored.`]);
    assert.match(unchanged.steps, /^Sales: restore failed; /, "the step found unchanged reads as failed");
    assert.deepEqual(unchanged.toast, { kind: "toast-warn", text: "Restore didn't finish.", detail: `Detail: Sales: ${UNCLEAR}. A read-back found it unchanged (tags differ), so it wasn't restored.` });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 2: a rollback's Website Management change ----------

test("Build: a rollback whose Website Management change Sophos answered 500 says what the read-back found, and never calls it accepted", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const results = {};
  let built;
  for (const [name, rules] of Object.entries({
    unread: (t) => {
      t.unclear("POST", /\/local-sites$/);
      t.refuse("GET", /\/local-sites$/, 503, afterWrite(t));
    },
    unmade: (t) => {
      t.ignore("POST", /\/local-sites$/);
      t.unclear("POST", /\/local-sites$/);
    },
  })) {
    const dataDir = await dataDirFor(`v0323-pages-wm-${name}`);
    const tenant = new Tenant();
    const { build } = seedPilot(tenant, dataDir);
    const id = randomUUID();
    tenant.localSites.set(id, { id, url: "kept.example.com", tags: ["staff"] });
    const run = await runReadiness(dataDir, tenant, { id: T, name: "Example Tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, TOOL);
    built = { ...(await getBuild(dataDir, T, build.id)), snapshotFile: run.snapshot.file };
    await saveRecord(dataDir, built);
    tenant.localSites.delete(id);
    rules(tenant);
    results[name] = await rollback(dataDir, ctxOf(tenant), build.id, { dryRun: false });
  }
  let answer;
  const { server: srv, base } = await server({
    ...buildReads(() => [built]),
    [`POST /api/build/${T}/${built.id}/rollback`]: (body) => (body.dryRun ? { ...built, restorePlan: [{ op: "create", url: "kept.example.com", body: { url: "kept.example.com" } }] } : { ...answer, id: built.id }),
  });
  let b;
  try {
    b = await openBrowser();
    const roll = (r) => {
      answer = r;
      return toastAfter(b, `${base}/build.html?tenant=${T}`, "[data-rollback]", [click("[data-rollback]")]);
    };
    assert.deepEqual(await roll(results.unread), {
      kind: "toast-warn",
      text: "The rollback isn't confirmed: Sophos didn't say a change went through, and the read-back didn't confirm it.",
      detail: `Detail: create kept.example.com: ${UNCLEAR}. A read-back couldn't read Website Management (${UNAVAILABLE}), so the change isn't confirmed.`,
    });
    assert.deepEqual(await roll(results.unmade), { kind: "toast-warn", text: "Rollback didn't finish.", detail: `Detail: create kept.example.com: ${UNCLEAR}. A read-back found it not as the snapshot has it, so it wasn't made.` });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- items 3 and 4: the Allow ----------

test("Pilot: an Allow whose link couldn't be read back isn't said to have failed, and one whose list was found by name but not read isn't called accepted", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const entries = {};
  let pilot;
  let policy;
  for (const [name, rules] of Object.entries({
    link: (t, profileId) => {
      t.unclear("PUT", new RegExp(`/profiles/${profileId}$`));
      t.refuse("GET", new RegExp(`/profiles/${profileId}$`), 503, afterWrite(t, t.writes + 1));
    },
    created: (t) => {
      t.unclear("POST", /\/site-lists$/);
      t.refuse("GET", /\/site-lists\/[^/]+(\/sites)?$/, 503, afterWrite(t));
    },
  })) {
    const dataDir = await dataDirFor(`v0323-pages-allow-${name}`);
    const tenant = new Tenant();
    const { profileId } = seedPilot(tenant, dataDir);
    const ctx = ctxOf(tenant);
    rules(tenant, profileId);
    entries[name] = { ...(await addAllow(dataDir, ctx, "chat.example.org")).entry, buildStatus: "built" };
    tenant.rules.length = 0;
    pilot = await activePilot(dataDir, T);
    ({ policy } = await readPilotPolicy(ctx, pilot));
    assert.equal((await loadPilotRecord(dataDir, T)).allows.length, 1);
  }
  let entry;
  const events = [{ id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://chat.example.org/' blocked due to category 'Chat'", created_at: now, endpoint_id: "w1", user_id: "u1" }];
  const { server: srv, base } = await server({
    [`GET /api/pilot/${T}`]: () => ({ pilot, policy, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [{ ...entry, buildId: pilot.buildId }] }),
    [`GET /api/pilot/${T}/digest`]: { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(events) },
    [`POST /api/pilot/${T}/allow`]: (body) => (body.dryRun ? { plan: { host: "chat.example.org", site: "chat.example.org", pilot, steps: [{ op: "create-list", name: "Example pilot allows", site: "chat.example.org" }], problems: [], notes: [] } } : { plan: {}, entry }),
  });
  let b;
  try {
    b = await openBrowser();
    const look = async (e) => {
      entry = e;
      await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
      const rows = await b.evaluate(ROWS("Allow entries", ".order-list > li"));
      const toast = await toastAfter(b, `${base}/pilot.html?tenant=${T}`, '[data-allow="chat.example.org"]', [click('[data-allow="chat.example.org"]'), { until: "!!document.querySelector('#allow-go')" }, click("#allow-go")]);
      return { rows, toast };
    };
    const link = await look(entries.link);
    assert.deepEqual(link.rows, [[["Not confirmed", "tag-warn"], "Sophos made the list, but didn't say its link to the profile went through, and the read-back didn't confirm it. Undo removes the list.", SAID]]);
    assert.deepEqual(link.toast, { kind: "toast-warn", text: "Sophos made the list for chat.example.org, but didn't say its link to the profile went through, and the read-back didn't confirm it. Undo it from Allow entries.", detail: SAID });
    const created = await look(entries.created);
    assert.deepEqual(created.rows, [[["Not confirmed", "tag-warn"], "Sophos didn't say the Allow went through, and the read-back didn't confirm it.", SAID]]);
    assert.deepEqual(created.toast, { kind: "toast-warn", text: "Sophos didn't say the Allow for chat.example.org went through, and the read-back didn't confirm it.", detail: SAID });
  } finally {
    srv.close();
    await b?.close();
  }
});

// ---------- item 5: the Build page after an Allow undo ----------

test("Build: an Allow undo whose list delete a read-back still found is red, with what to do and why on its Detail line", { skip: skipBrowser, timeout: 90_000 }, async () => {
  const dataDir = await dataDirFor("v0323-pages-build");
  const tenant = new Tenant();
  const { build } = seedPilot(tenant, dataDir);
  const ctx = ctxOf(tenant);
  const { entry } = await addAllow(dataDir, ctx, "chat.example.org");
  const LIST = new RegExp(`/site-lists/${entry.listId}$`);
  tenant.ignore("DELETE", LIST);
  tenant.unclear("DELETE", LIST);
  await undoAllow(dataDir, ctx, entry.id);
  tenant.rules.length = 0;
  const rec = await getBuild(dataDir, T, build.id);
  const { server: srv, base } = await server(buildReads(() => [rec]));
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/build.html?tenant=${T}`, 1440, ".steps-list");
    assert.deepEqual((await b.evaluate(ROWS("Plan", ".steps-list > li"))).pop(), [["Delete failed", "tag-bad"], "The delete failed. Undo the Allow again on the Pilot page, or check it in Sophos Fusion.", `Detail: ${UNCLEAR}. A read-back still found the list, so it wasn't deleted.`]);
  } finally {
    srv.close();
    await b?.close();
  }
});
