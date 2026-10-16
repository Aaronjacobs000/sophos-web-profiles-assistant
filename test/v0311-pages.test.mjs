// v0.3.11, as drawn in a headless Chrome or Edge (skipped without one): the
// note on an unfinished rollback ends the reason with a full stop, the Pilot
// page says when the pilot policy wasn't read (not gone) and offers a retry,
// Allow is off with a reason while the pilot policy is gone, and retire
// records say their status in plain words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../backend/dist/domain/digest.js";
import { openBrowser, pageServer, skipBrowser } from "./browser.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const tenant = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant, partner: null, version: "0.3.11", readOnly: false };
const store = { days: [], total: 0, imported: 0, state: { tenantId: T, enabled: false, runs: [] } };
const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: ["w1"] } };
const policy = { id: "p1", name: pilot.policyName, enabled: false, priority: 1, endpoints: ["w1"], endpointGroups: [], users: [], userGroups: [] };
const GONE = `The pilot policy "WF pilot: Example profile" is no longer in the tenant. Roll the build back on the Build page to remove what's left of it, or build a new pilot.`;
const now = new Date().toISOString();
const events = [
  { id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://app.example.com/login' blocked due to category 'Social Networking'", created_at: now, endpoint_id: "w1", user_id: "u1" },
  { id: "e2", type: "Event::Endpoint::WebControlViolation", name: "'https://chat.example.org/' blocked due to category 'Chat'", created_at: now, endpoint_id: "w2", user_id: "u2" },
];
const digestOf = (list, extra = {}) => ({ days: 7, since: null, pilotOnly: false, pilotDevices: null, imported: 0, otherWebEvents: 0, ...summarize(list), ...extra });

/** The Pilot policy card's text, buttons and links. */
const PILOT_CARD = `(() => { const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Pilot policy"); return { text: c.textContent.replace(/\\s+/g, " ").trim(), buttons: [...c.querySelectorAll("button")].map((b) => b.textContent.trim()), tag: c.querySelector(".card-head .tag")?.textContent }; })()`;

test("the note on an unfinished rollback ends Sophos's reason with a full stop before the next sentence", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const unfinished = { at: "2026-10-15T02:00:00.000Z", reason: "Sophos API error 500: InternalServerError", left: [{ kind: "policy", name: pilot.policyName }] };
  const view = { pilot: { ...pilot, buildStatus: "rollback-partial", rollbackUnfinished: unfinished }, policy, store, allows: [] };
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: () => view, [`/api/pilot/${T}/digest`]: digestOf([]) });
  let b;
  try {
    b = await openBrowser();
    const banner = async () => {
      await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".banner-warn");
      return b.evaluate(`document.querySelector(".banner-warn").textContent.replace(/\\s+/g, " ").trim()`);
    };
    assert.equal(await banner(), `The rollback didn't finish. Still in the tenant: the policy "WF pilot: Example profile". Sophos API error 500: InternalServerError. Roll it back again from the Build page, or carry on with the pilot.`);
    // A reason that already ends a sentence keeps its own stop.
    unfinished.reason = "Sophos API request got no answer within 30 s. A read-back still found it, so it wasn't deleted.";
    assert.match(await banner(), /so it wasn't deleted\. Roll it back again/);
  } finally {
    server.close();
    await b?.close();
  }
});

test("the Pilot page says a pilot policy it couldn't read wasn't read, not that it's gone, and Retry reads it again", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const unread = "Sophos API error 403: Forbidden";
  let view = { pilot, policy: null, policyUnread: unread, store, allows: [] };
  let pilotReads = 0;
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: () => (pilotReads++, view), [`/api/pilot/${T}/digest`]: () => digestOf(events) });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, ".order-list");
    const card = await b.evaluate(PILOT_CARD);
    assert.equal(card.tag, "Not read");
    // Since v0.3.13 Sophos's answer is on its own Detail line.
    assert.ok(card.text.includes(`The tool couldn't read the pilot policy. That doesn't mean it's gone. Retry, or check it in Sophos Fusion. Detail: ${unread}.`), card.text);
    assert.ok(!/Not found|no longer in the tenant|not in the tenant/.test(card.text), card.text);
    assert.deepEqual(card.buttons, ["Retry"]);
    // Retry reads it again; read this time, the card shows the policy.
    view = { pilot, policy, store, allows: [] };
    const before = pilotReads;
    await b.evaluate(`document.querySelector("[data-retry]").click(); true`);
    for (let i = 0; i < 50 && (await b.evaluate(PILOT_CARD)).tag !== "Off"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(pilotReads, before + 1);
    assert.equal((await b.evaluate(PILOT_CARD)).tag, "Off");
  } finally {
    server.close();
    await b?.close();
  }
});

test("the pilot devices filter says the pilot policy wasn't read, instead of counting no hits, and can be turned off", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const unread = "Sophos API error 500: InternalServerError";
  let view = { pilot, policy, store, allows: [] };
  let digest = digestOf(events);
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: () => view, [`/api/pilot/${T}/digest`]: () => digest });
  const PAGE = `({ h1: document.querySelector("h1").textContent.trim(), box: { checked: document.querySelector("#pilotonly").checked, disabled: document.querySelector("#pilotonly").disabled }, text: document.querySelector("#main").textContent.replace(/\\s+/g, " "), retry: document.querySelectorAll("[data-retry]").length, sites: document.querySelectorAll("[data-allow]").length })`;
  const settle = async (want) => {
    for (let i = 0; i < 50 && !(await b.evaluate(`document.querySelector("h1").textContent.trim()`)).includes(want); i++) await new Promise((r) => setTimeout(r, 100));
    return b.evaluate(PAGE);
  };
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "#pilotonly");
    // The policy now fails to read, so the filter can't tell which devices are on the pilot.
    view = { pilot, policy: null, policyUnread: unread, store, allows: [] };
    digest = digestOf([], { pilotOnly: true, pilotUnread: unread });
    await b.evaluate(`document.querySelector("#pilotonly").click(); true`);
    const on = await settle("Couldn't read");
    assert.equal(on.h1, "Couldn't read the pilot's devices");
    // Sophos's answer is on a separate detail line since v0.3.14.
    assert.ok(on.text.includes(`The tool couldn't read which devices are on the pilot, so the digest isn't shown. Retry, or untick Pilot devices only to see every device. Detail: ${unread}.`), on.text);
    assert.ok(!/No hits|No warned or blocked hits|no longer in the tenant|Not found/.test(on.text), on.text);
    assert.equal(on.retry, 2, "a Retry on the pilot card and one in place of the digest");
    assert.deepEqual(on.box, { checked: true, disabled: false }, "a ticked box can still be unticked");
    // Unticked: every device's hits again.
    view = { pilot, policy, store, allows: [] };
    digest = digestOf(events);
    await b.evaluate(`document.querySelector("#pilotonly").click(); true`);
    const off = await settle("blocked");
    assert.equal(off.h1, "0 warned and 2 blocked in the last 7 days");
    assert.equal(off.sites, 2);
    assert.deepEqual(off.box, { checked: false, disabled: false });
  } finally {
    server.close();
    await b?.close();
  }
});

test("while the pilot policy is gone, the Allow buttons are off and say why", { skip: skipBrowser, timeout: 60_000 }, async () => {
  let view = { pilot, policy: null, problem: GONE, store, allows: [] };
  const { server, base } = await pageServer({ "/api/status": status, [`/api/pilot/${T}`]: () => view, [`/api/pilot/${T}/digest`]: digestOf(events) });
  const ALLOW = `({ buttons: [...document.querySelectorAll("[data-allow]")].map((x) => ({ disabled: x.disabled, title: x.title })), hint: document.querySelector("[data-allow-off]")?.textContent.trim() ?? null })`;
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "[data-allow]");
    const gone = await b.evaluate(ALLOW);
    const why = "Allow is off: the pilot policy is no longer in the tenant.";
    assert.deepEqual(gone, { buttons: [{ disabled: true, title: why }, { disabled: true, title: why }], hint: why });
    // With the policy there, Allow is on and the note goes.
    view = { pilot, policy, store, allows: [] };
    await b.open(`${base}/pilot.html?tenant=${T}`, 1440, "[data-allow]");
    assert.deepEqual(await b.evaluate(ALLOW), { buttons: [{ disabled: false, title: "" }, { disabled: false, title: "" }], hint: null });
  } finally {
    server.close();
    await b?.close();
  }
});

test("retire records and the messages after a retire or restore say each status in plain words", { skip: skipBrowser, timeout: 60_000 }, async () => {
  const promo = { pilot, policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 1, endpointGroups: 0, users: 0, userGroups: 0 }, mode: "devices", plan: { waves: [], inPilot: [{ id: "w1" }], notEligible: [] }, waves: [], waveSize: 25 };
  const tagStep = (s, extra = {}) => ({ op: "policy-tags", policyId: "b", policyName: "Base Policy", before: [{ tag: "Example tag", action: "block" }], after: [], status: s, ...extra });
  const delStep = (s, extra = {}) => ({ op: "delete-entry", id: "s1", url: "blocked.example.com", tags: ["Example tag"], status: s, ...extra });
  const rec = (n, s, steps) => ({ id: `77777777-0000-4000-8000-00000000000${n}`, tenantId: T, at: `2026-10-1${n}T01:00:00.000Z`, tags: ["Example tag"], snapshotFile: `Example_Tenant_2026101${n}-010000.json`, status: s, steps, warnings: [] });
  const records = [
    rec(5, "restore-partial", [tagStep("restore-failed", { readBack: "tags differ" }), delStep("restored")]),
    rec(4, "failed", [tagStep("failed", { error: "Sophos API error 403: Forbidden" }), delStep("planned")]),
    rec(3, "partial", [tagStep("done", { readBack: "tags match" }), delStep("failed")]),
    rec(2, "restored", [tagStep("restored")]),
    rec(1, "retired", [tagStep("done")]),
  ];
  let restoredTo = "restore-partial";
  const { server, base } = await pageServer({
    "/api/status": status,
    [`/api/promote/${T}`]: promo,
    [`/api/retire/${T}`]: { tags: [], records },
    [`POST /api/retire/${T}/${records[0].id}/restore`]: () => ({ ...records[0], status: restoredTo }),
  });
  let b;
  try {
    b = await openBrowser();
    await b.open(`${base}/promote.html?tenant=${T}`, 1440, "[data-restore]");
    const rows = await b.evaluate(`(() => { const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Retired"); return [...c.querySelectorAll("tbody tr")].map((tr) => [tr.children[2].textContent.trim(), tr.children[3].textContent.trim()]); })()`);
    assert.deepEqual(rows, [
      ["Restore didn't finish", "Base Policy: restore failed (tags differ); blocked.example.com: restored"],
      ["Retire failed", "Base Policy: failed; blocked.example.com: not sent"],
      ["Retire didn't finish", "Base Policy: done (tags match); blocked.example.com: failed"],
      ["Restored", "Base Policy: restored"],
      ["Retired", "Base Policy: done"],
    ]);
    const lastToast = async () => {
      await b.evaluate(`window.confirm = () => true; document.querySelectorAll(".toast").forEach((t) => t.remove()); document.querySelector("[data-restore]").click(); true`);
      await b.waitFor(".toast");
      return b.evaluate(`[...document.querySelectorAll(".toast")].pop().textContent`);
    };
    assert.equal(await lastToast(), "Restore didn't finish.");
    restoredTo = "restored";
    assert.equal(await lastToast(), "Restored.");
  } finally {
    server.close();
    await b?.close();
  }
});
