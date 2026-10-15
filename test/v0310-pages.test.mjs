// v0.3.10, as drawn in a headless Chrome or Edge (skipped without one): the
// Build page's table and toasts use plain words, the Pilot page says when the
// pilot policy is gone, and the narrow rail (761 to 1100 px) cuts nothing off.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../backend/dist/domain/digest.js";
import { STEPS } from "../frontend/js/shell.js";
import { openBrowser, pageServer, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.10", readOnly: false };

const steps = [
  { order: 1, kind: "site-list", key: "l1", name: "Example Block", method: "POST", path: "/web-filters/v1/site-lists", summary: "1 site, block", body: {}, status: "created", id: "l1" },
  { order: 2, kind: "profile", key: "profile", name: "Example profile", method: "POST", path: "/web-filters/v1/profiles", summary: "Site lists only, 1 site list", body: {}, status: "created", id: "pr1" },
  { order: 3, kind: "policy", key: "pilot", name: "WF pilot: Example profile", method: "POST", path: "/endpoint/v1/policies", summary: "Web Control, top of the order", body: {}, status: "created", id: "p1" },
];
const pilotOptions = { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: [] } };
const build = (n, buildStatus) => ({ id: `0000000${n}-0000-4000-a000-000000000000`, tenantId: T, tenantName: "Example Tenant", createdAt: `2026-10-1${n}T01:00:00.000Z`, status: buildStatus, pilot: pilotOptions, steps, checks: [{ ok: true, level: "ok", text: "Profiles: 0 in the account, 1 to add, limit 20." }] });
const pilot = { buildId: "b1", buildStatus: "rollback-partial", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: [] } };

test("the Build page's table and toasts say each build and rollback status in plain words", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const builds = [build(5, "rollback-partial"), build(4, "rolled-back"), build(3, "built"), build(2, "partial"), build(1, "failed")];
  let rollbackTo = "rollback-partial";
  const { server, base } = await pageServer({
    "/api/status": status,
    [`/api/design/${T}`]: { design: { profiles: [{ key: "profile", name: "Example profile" }] } },
    [`/api/pilot-targets/${T}`]: { endpoints: [], endpointGroups: [], userGroups: [] },
    [`/api/build/${T}`]: () => ({ items: builds }),
    [`POST /api/build/${T}/dry-run`]: () => ({ ...build(6, "dry-run"), steps: steps.map((s) => ({ ...s, status: "planned" })) }),
    [`POST /api/build/${T}/execute`]: () => build(6, "partial"),
    [`POST /api/build/${T}/${builds[0].id}/rollback`]: (body) => (body.dryRun ? { ...builds[0], restorePlan: [] } : { ...builds[0], status: rollbackTo }),
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/build.html?tenant=${T}`, 1440, ".data-table");
    const cells = await b.evaluate(`[...document.querySelectorAll(".data-table tbody tr")].map((tr) => tr.children[2].textContent.trim())`);
    assert.deepEqual(cells, ["Rollback didn't finish", "Rolled back", "Built 3 objects", "Build didn't finish", "Build failed"]);

    const lastToast = async (action) => {
      await b.evaluate(`window.confirm = () => true; document.querySelectorAll(".toast").forEach((t) => t.remove()); ${action}; true`);
      await b.waitFor(".toast");
      return b.evaluate(`[...document.querySelectorAll(".toast")].pop().textContent`);
    };
    assert.equal(await lastToast(`document.querySelector("[data-rollback]").click()`), "Rollback didn't finish.");
    rollbackTo = "rolled-back";
    assert.equal(await lastToast(`document.querySelector("[data-rollback]").click()`), "Rolled back.");

    await b.evaluate(`document.querySelector("#dry").click(); true`);
    for (let i = 0; i < 50 && !(await b.evaluate(`!document.querySelector("#go").disabled`)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await lastToast(`document.querySelector("#go").click()`), "Build didn't finish.");
  } finally {
    server.close();
    await b?.close();
  }
});

test("the Pilot page says the pilot policy is gone, and what to do, instead of the rollback note", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const problem = `The pilot policy "WF pilot: Example profile" is no longer in the tenant. Roll the build back on the Build page to remove what's left of it, or build a new pilot.`;
  const unfinished = { at: "2026-10-15T02:00:00.000Z", reason: "Sophos API error 500: InternalServerError", left: steps.map((s) => ({ kind: s.kind, name: s.name })) };
  const view = { pilot: { ...pilot, rollbackUnfinished: unfinished }, policy: null, problem, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [] };
  const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([]) };
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: () => view, [`/api/pilot/${T}/digest`]: digest });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    const card = () => b.evaluate(`(() => { const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Pilot policy"); return { text: c.textContent.replace(/\\s+/g, " ").trim(), build: [...c.querySelectorAll("a")].map((a) => [a.textContent.trim(), a.getAttribute("href")]) }; })()`);
    const gone = await card();
    assert.ok(gone.text.includes(problem), gone.text);
    assert.ok(gone.text.includes("WF pilot: Example profile"), gone.text);
    assert.ok(gone.text.includes("not in the tenant"), gone.text);
    assert.ok(!gone.text.includes("The rollback didn't finish"), gone.text);
    assert.ok(!gone.text.includes("carry on with the pilot"), gone.text);
    assert.deepEqual(gone.build, [["Open the Build page", `/build.html?tenant=${T}`]]);

    // With the policy still there, the note on the unfinished rollback stays.
    view.policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
    delete view.problem;
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    const there = await card();
    assert.ok(there.text.includes("The rollback didn't finish"), there.text);
    assert.ok(!there.text.includes("no longer in the tenant"), there.text);
  } finally {
    server.close();
    await b?.close();
  }
});

test("from 761 to 1100 px the narrow rail shows each step's number, named in its title, and cuts nothing off", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const view = { pilot: null, policy: null, store: { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } }, allows: [] };
  const digest = { days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize([]) };
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: view, [`/api/pilot/${T}/digest`]: digest });
  const PROBE = `(() => {
    const rail = document.getElementById("app-rail");
    const box = rail.getBoundingClientRect();
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const cut = [...rail.querySelectorAll("*")].filter((e) => { const r = e.getBoundingClientRect(); return seen(e) && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).map((e) => e.className.baseVal ?? e.className);
    const steps = [...rail.querySelectorAll(".step-item")].map((a) => ({ title: a.title, name: seen(a.querySelector(".step-name")), num: seen(a.querySelector(".step-num")) }));
    const note = rail.querySelector(".rail-note");
    return { railWidth: box.width, scrollWidth: rail.scrollWidth, clientWidth: rail.clientWidth, cut, steps, note: seen(note) ? note.getBoundingClientRect().right <= box.right + 0.5 : "hidden" };
  })()`;
  let b;
  try {
    b = await openBrowser();
    for (const width of [800, 1024, 1100, 761]) {
      await b.open(`${base}/pilot.html?tenant=${T}`, width, "#app-rail .steps");
      const m = await b.evaluate(PROBE);
      assert.equal(m.railWidth, 76, `${width}: ${JSON.stringify(m)}`);
      assert.deepEqual(m.cut, [], `${width}: nothing in the rail runs past its edges: ${JSON.stringify(m)}`);
      assert.ok(m.scrollWidth <= m.clientWidth, `${width}: the rail doesn't scroll sideways: ${JSON.stringify(m)}`);
      assert.deepEqual(m.steps, STEPS.map((s) => ({ title: s.name, name: false, num: true })), `${width}: numbers only, each named in its title`);
      assert.equal(m.note, "hidden", `${width}: the note is hidden, like the footer`);
    }
    // On a desktop the steps keep their names and the note shows; at phone width the current step is still named.
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "#app-rail .steps");
    const wide = await b.evaluate(PROBE);
    assert.equal(wide.railWidth, 236);
    assert.deepEqual(wide.cut, []);
    assert.ok(wide.steps.every((s) => s.name && s.num), JSON.stringify(wide.steps));
    assert.equal(wide.note, true);
    await b.open(`${base}/pilot.html?tenant=${T}`, 390, "#app-rail .steps");
    const phone = await b.evaluate(PROBE);
    assert.deepEqual(phone.steps.map((s) => s.name), [false, false, false, false, true, false], JSON.stringify(phone.steps));
  } finally {
    server.close();
    await b?.close();
  }
});
