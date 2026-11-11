// v0.3.38, as drawn in a headless Chrome or Edge (skipped without one), from
// designs and records the services make against an in-memory tenant. The
// Build page is clearer about where its profiles come from. With no profiles
// planned, the Pilot policy card lists each policy and why the Design step
// didn't convert it, or says the tenant has no Web Control policies, and the
// right-hand card no longer says to choose a profile. With profiles, a hint
// under Profile says it's the profile the pilot policy will use, from the
// Design step. The last plan or build's profile is put back in the select only
// when the Design step still plans it; otherwise the select stays on its first
// option and a line says the profile is no longer planned, and a dry run of
// that profile reads "Dry run out of date" with Create off, not "Ready to
// create".

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, dryRun, execute } from "../backend/dist/services/build-service.js";
import { T, TOOL, Tenant, ctxOf, dataDirFor } from "./memory-tenant.mjs";
import { device, wcPolicy } from "./fixtures.mjs";
import { openBrowser, pageServer, skipBrowser } from "./browser.mjs";
import { buildHeadline } from "../frontend/js/ui.js";

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.38", readOnly: false };
const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__unhandled.push(String(e.message)));`;
const ON = { "endpoint.web-control.web-profile.enabled": { value: true }, "endpoint.web-control.filter-by-web-profile.enabled": { value: true }, "endpoint.web-control.web-profile-id": { value: "prof-1" } };
const NOTHING = "The Design step planned no profiles, so there's nothing to build.";
const HINT = "The profile the pilot policy will use. The list comes from the Design step.";
const CHOOSE = "Choose the profile and pilot targets, then run a dry run. Nothing is written until you confirm.";

test("a dry run of a profile the Design step no longer plans is out of date, whatever its checks found", () => {
  const rec = (status, checks = []) => ({ status, steps: [{}, {}, {}], checks });
  assert.equal(buildHeadline(rec("dry-run", [{ ok: true }]), false, false), "Dry run out of date");
  assert.equal(buildHeadline(rec("dry-run", [{ ok: true }]), true, false), "Dry run out of date");
  assert.equal(buildHeadline(rec("dry-run", [{ ok: false }]), false, false), "Dry run out of date");
  assert.equal(buildHeadline(rec("dry-run", [{ ok: true }]), false, true), "Dry run passed. Ready to create 3 objects.");
  assert.equal(buildHeadline(rec("dry-run", [{ ok: true }]), false), "Dry run passed. Ready to create 3 objects.", "planned unless said");
  assert.equal(buildHeadline(rec("built"), false, false), "Built 3 objects", "only a dry run goes out of date");
  assert.equal(buildHeadline(null, false, false), "Plan the pilot");
});

/** A tenant with a classic policy per name, each blocking its own site through its own tag, so each gets its own profile. */
function classicTenant(names) {
  const tenant = new Tenant();
  names.forEach((name, i) => {
    const tag = `tag-${i}`;
    const p = wcPolicy({ id: randomUUID(), name, priority: i + 1, settings: { "endpoint.web-control.tags.settings": { value: [{ tag, action: "block" }] } } });
    tenant.policies.set(p.id, p);
    const id = randomUUID();
    tenant.localSites.set(id, { id, url: `blocked-${i}.example.com`, tags: [tag] });
  });
  tenant.endpoints = [device("w1", "windows", "2026.2.2.1.0")];
  return tenant;
}

/** The page as drawn: the headline, the Pilot policy card, the select, the two buttons and the right-hand cards. */
const PAGE = `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Pilot policy");
  const empty = c.querySelector("[data-no-profiles]");
  const sel = c.querySelector("#profile");
  return {
    headline: document.querySelector("h1").textContent,
    first: empty?.querySelector("p").textContent.trim() ?? null,
    reasons: empty ? [...empty.querySelectorAll("[data-not-converted] li")].map((li) => [li.querySelector("b").textContent, li.textContent]) : null,
    links: [...c.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href"), a.parentElement.textContent.trim()]),
    hint: c.querySelector("[data-profile-hint]")?.textContent ?? null,
    gone: c.querySelector("[data-profile-gone]")?.textContent ?? null,
    select: sel ? { value: sel.value, index: sel.selectedIndex, options: [...sel.options].map((o) => o.textContent) } : null,
    dry: document.querySelector("#dry").disabled,
    go: document.querySelector("#go").disabled,
    choose: [...document.querySelectorAll(".score-main .panel-card")].some((s) => s.textContent.includes("Choose the profile")),
    plan: !!document.querySelector(".steps-list"),
  };
})()`;

test("Build: the page says where its profiles come from, lists why none were planned, and puts back only a profile the Design step still plans", { skip: skipBrowser, timeout: 120_000 }, async () => {
  // Every policy skipped, one with a name that needs escaping.
  const skippedTenant = new Tenant();
  for (const p of [
    wcPolicy({ id: randomUUID(), name: "Base Policy", priority: 0, settings: ON }),
    wcPolicy({ id: randomUUID(), name: "R&D <lab>", priority: 1, enabled: false }),
    wcPolicy({ id: randomUUID(), name: "Kiosks", priority: 2, settings: { "endpoint.web-control.web-filtering.enabled": { value: false } } }),
  ]) skippedTenant.policies.set(p.id, p);
  const skipped = (await designFor(await dataDirFor("v0338-skipped"), ctxOf(skippedTenant))).design;
  const none = (await designFor(await dataDirFor("v0338-none"), ctxOf(new Tenant()))).design;

  // Two profiles planned; a dry run of the second, which passed; and a build of the first.
  const two = classicTenant(["Sales", "Finance"]);
  const twoDir = await dataDirFor("v0338-two");
  const planned = (await designFor(twoDir, ctxOf(two))).design;
  assert.deepEqual(planned.profiles.map((p) => p.name), ["Sales profile", "Finance profile"]);
  const pilot = (key) => ({ profileKey: key, enabled: false, targets: { endpoints: ["w1"] } });
  const passed = await dryRun(twoDir, ctxOf(two), pilot(planned.profiles[1].key));
  assert.ok(passed.checks.every((c) => c.ok), "the dry run passed");
  const built = await execute(await dataDirFor("v0338-built"), ctxOf(classicTenant(["Sales", "Finance"])), pilot(planned.profiles[0].key), TOOL);
  assert.equal(built.status, "built");
  // Finance renamed: its profile is planned under a new name and key, so the dry run's profile is gone; Sales's stays.
  const renamed = (await designFor(await dataDirFor("v0338-renamed"), ctxOf(classicTenant(["Sales", "Finance team"])))).design;
  assert.deepEqual(renamed.profiles.map((p) => p.name), ["Sales profile", "Finance team profile"]);

  let shown = { design: skipped, items: [] };
  const posts = [];
  const { server, base } = await pageServer({
    "/api/status": status,
    [`/api/design/${T}`]: () => ({ design: shown.design, genAi: {} }),
    [`/api/pilot-targets/${T}`]: { endpoints: [{ id: "w1", hostname: "EXAMPLE-PC-01", kind: "computer", eligible: true }], endpointGroups: [], userGroups: [] },
    [`/api/build/${T}`]: () => ({ items: shown.items }),
    [`POST /api/build/${T}/dry-run`]: () => (posts.push("dry-run"), passed),
    [`POST /api/build/${T}/execute`]: () => (posts.push("execute"), built),
  });
  const design = `/design.html?tenant=${encodeURIComponent(T)}`;
  let b;
  try {
    b = await openBrowser();
    await b.call("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
    const open = async (ready) => {
      await b.open(`${base}/build.html?tenant=${T}`, 1440, ready);
      const page = await b.evaluate(PAGE);
      assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
      return page;
    };

    // No profiles planned: each policy and why, escaped, with the link for the details; no select, no "Choose the profile".
    let page = await open("[data-no-profiles]");
    assert.equal(page.first, `${NOTHING} Why each policy wasn't converted:`);
    assert.deepEqual(page.reasons, [
      ["Base Policy", "Base Policy: Already uses a web filtering profile."],
      ["R&D <lab>", "R&D <lab>: Disabled: retire it rather than convert it."],
      ["Kiosks", "Kiosks: Category filtering is off and it has no site exceptions, so a profile would add nothing."],
    ]);
    assert.deepEqual(page.links, [["Open the Design step", design, "Open the Design step for the details."]]);
    assert.deepEqual([page.select, page.hint, page.dry, page.go, page.choose, page.headline], [null, null, true, true, false, "Plan the pilot"]);

    // No Web Control policies: it says so, with no list.
    shown = { design: none, items: [] };
    page = await open("[data-no-profiles]");
    assert.deepEqual([page.first, page.reasons, page.links], [`${NOTHING} The tenant has no Web Control policies for the Design step to convert.`, [], [["Design step", design, `${NOTHING} The tenant has no Web Control policies for the Design step to convert.`]]]);
    assert.equal(page.choose, false, "no card says to choose a profile");

    // No profiles now, and the last record is the dry run that passed: out of date, and Create stays off.
    shown = { design: skipped, items: [passed] };
    page = await open("[data-no-profiles]");
    assert.deepEqual([page.headline, page.plan, page.go, page.choose, page.gone], ["Dry run out of date", true, true, false, null]);

    // Profiles planned, no record yet: the hint under Profile, the first profile chosen, and the right-hand card says what to do.
    shown = { design: planned, items: [] };
    page = await open("#profile");
    assert.deepEqual(page.hint, HINT);
    assert.deepEqual(page.select, { value: planned.profiles[0].key, index: 0, options: ["Sales profile", "Finance profile"] });
    assert.deepEqual([page.gone, page.dry, page.go, page.choose, page.headline], [null, false, true, true, "Plan the pilot"]);
    assert.equal(await b.evaluate(`[...document.querySelectorAll(".score-main .panel-card")].find((s) => s.textContent.includes("Choose the profile")).textContent.trim()`), CHOOSE);

    // The dry run's profile still planned: put back, and ready to create.
    shown = { design: planned, items: [passed] };
    page = await open("#profile");
    assert.deepEqual(page.select, { value: planned.profiles[1].key, index: 1, options: ["Sales profile", "Finance profile"] });
    assert.deepEqual([page.gone, page.go, page.headline], [null, false, `Dry run passed. Ready to create ${passed.steps.length} objects.`]);

    // The dry run's profile no longer planned: the first option, one line saying so, out of date, and Create off.
    shown = { design: renamed, items: [passed] };
    page = await open("#profile");
    assert.deepEqual(page.select, { value: renamed.profiles[0].key, index: 0, options: ["Sales profile", "Finance team profile"] });
    assert.deepEqual([page.gone, page.dry, page.go, page.headline], ['The last dry run used the profile "Finance profile", which the Design step no longer plans.', false, true, "Dry run out of date"]);

    // A build whose profile is still planned is put back; one whose profile isn't says so, and keeps its headline.
    shown = { design: renamed, items: [built] };
    page = await open("#profile");
    assert.deepEqual([page.select.value, page.gone, page.go, page.headline], [renamed.profiles[0].key, null, true, `Built ${built.steps.length} objects`]);
    shown = { design: (await designFor(await dataDirFor("v0338-renamed-sales"), ctxOf(classicTenant(["Sales team", "Finance"])))).design, items: [built] };
    page = await open("#profile");
    assert.deepEqual([page.select.index, page.gone, page.go, page.headline], [0, 'The last build used the profile "Sales profile", which the Design step no longer plans.', true, `Built ${built.steps.length} objects`]);

    assert.deepEqual(posts, [], "only read");
  } finally {
    server.close();
    await b?.close();
  }
});
