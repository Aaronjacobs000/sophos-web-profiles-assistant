// v0.3.37. The Build page's Pilot policy card offers the profiles the Design
// step planned. When it planned none (every Web Control policy already on a
// profile, disabled, or off for categories with no site exceptions, or no Web
// Control policies at all), the select was empty with nothing to say why, and
// a dry run failed with "Choose a profile for the pilot policy." The card now
// says the Design step planned no profiles and links to it, and Dry run and
// Create are off. The Design step also skipped a policy as already on a
// profile when it held web-profile.enabled and filter-by-web-profile.enabled
// with no profile, which the readiness check and the retire step have read as
// classic since v0.3.31: it now converts it. Designs come from the services
// against an in-memory tenant (memory-tenant.mjs); the page tests run in a
// headless Chrome or Edge (skipped without one).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_CATALOG } from "../backend/dist/domain/categories.js";
import { buildDesign } from "../backend/dist/domain/design.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, dryRun, execute } from "../backend/dist/services/build-service.js";
import { T, TOOL, Tenant, classicTenant, ctxOf, dataDirFor } from "./memory-tenant.mjs";
import { wcPolicy } from "./fixtures.mjs";
import { openBrowser, pageServer, skipBrowser } from "./browser.mjs";

before(() => setReadBackDelays([0, 0]));

const EN = "endpoint.web-control.web-profile.enabled";
const FB = "endpoint.web-control.filter-by-web-profile.enabled";
const ID = "endpoint.web-control.web-profile-id";
const ON = { [EN]: { value: true }, [FB]: { value: true }, [ID]: { value: "prof-1" } };
const OFF = { [EN]: { value: false }, [FB]: { value: false }, [ID]: { value: "" } };
const ON_PROFILE = "Already uses a web filtering profile.";

/** The three settings with only the named ones set, the rest as a live classic policy holds them. */
const withSet = (...keys) => Object.fromEntries([EN, FB, ID].map((k) => [k, keys.includes(k) ? ON[k] : OFF[k]]));
const named = (name, settings, over = {}) => wcPolicy({ id: randomUUID(), name, settings, ...over });
const design = (policies) => buildDesign(DEFAULT_CATALOG, policies, [], null, { date: "12/11/2026", existingProfiles: 0, existingSiteLists: 0 });

// ---------- design.ts: on a profile only with all three settings ----------

test("the Design step skips a policy as on a profile only with all three profile settings set, as the readiness check reads it", () => {
  const d = design([
    named("None set", withSet()),
    named("Enabled only", withSet(EN)),
    named("Filter only", withSet(FB)),
    named("Id only", withSet(ID)),
    named("Enabled and filter", withSet(EN, FB)),
    named("Enabled and id", withSet(EN, ID)),
    named("Filter and id", withSet(FB, ID)),
    named("Blank id", { ...ON, [ID]: { value: "  " } }),
    // What POST /endpoint/v1/policies with no settings holds, read live on 29/10/2026.
    named("New from the API", { [EN]: { value: true }, [FB]: { value: false }, [ID]: { value: "" } }),
    named("All three", withSet(EN, FB, ID)),
  ]);
  const skipped = Object.fromEntries(d.policies.map((p) => [p.policyName, p.skipped ?? null]));
  assert.deepEqual(skipped, {
    "None set": null,
    "Enabled only": null,
    "Filter only": null,
    "Id only": null,
    "Enabled and filter": null,
    "Enabled and id": null,
    "Filter and id": null,
    "Blank id": null,
    "New from the API": null,
    "All three": ON_PROFILE,
  });
  const converted = d.profiles.flatMap((p) => p.sourcePolicies.map((s) => s.name)).sort();
  assert.deepEqual(converted, Object.keys(skipped).filter((n) => n !== "All three").sort(), "every policy without a profile is converted");
});

test("a tenant whose only policy holds two of the settings and no profile gets a profile to pilot, not an empty Build page", async () => {
  const dataDir = await dataDirFor("v0337-two-set");
  const tenant = new Tenant();
  const base = named("Base Policy", withSet(EN, FB), { priority: 0 });
  tenant.policies.set(base.id, base);
  const { design: d } = await designFor(dataDir, ctxOf(tenant));
  assert.equal(d.policies[0].skipped, undefined, "it isn't skipped as on a profile");
  assert.deepEqual(d.profiles.map((p) => p.sourcePolicies.map((s) => s.name)), [["Base Policy"]]);
  assert.equal(tenant.writes, 0, "the design only reads");
});

// ---------- the Build page with no profiles planned ----------

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.37", readOnly: false };
const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__unhandled.push(String(e.message)));`;
const NOTHING = "The Design step planned no profiles, so there's nothing to build.";

/** The Pilot policy card as drawn: its first line, its link, whether it has a select or a form, and the two buttons. */
const CARD = `(() => {
  const c = [...document.querySelectorAll(".panel-card")].find((s) => s.querySelector("h2")?.textContent === "Pilot policy");
  const note = c.querySelector("[data-no-profiles]");
  return {
    note: note?.querySelector("p")?.textContent.trim() ?? null,
    link: note?.querySelector("a")?.getAttribute("href") ?? null,
    select: !!c.querySelector("select"),
    form: !!document.querySelector("#pilot"),
    options: [...c.querySelectorAll("#profile option")].map((o) => o.textContent),
    dry: document.querySelector("#dry").disabled,
    go: document.querySelector("#go").disabled,
  };
})()`;

/** A tenant whose Web Control policies are all skipped: two on a profile, one disabled, one off for categories with no site exceptions. */
function skippedTenant() {
  const tenant = new Tenant();
  for (const p of [
    named("Base Policy", withSet(EN, FB, ID), { priority: 0 }),
    named("Sales", withSet(EN, FB, ID), { priority: 1 }),
    named("Old contractors", withSet(), { priority: 2, enabled: false }),
    named("Kiosks", { ...withSet(), "endpoint.web-control.web-filtering.enabled": { value: false } }, { priority: 3 }),
  ]) tenant.policies.set(p.id, p);
  return tenant;
}

test("Build: with no profiles planned, the Pilot policy card says so and links to Design, and Dry run and Create are off", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const skipped = (await designFor(await dataDirFor("v0337-skipped"), ctxOf(skippedTenant()))).design;
  assert.equal(skipped.profiles.length, 0);
  assert.deepEqual(skipped.policies.map((p) => p.skipped), [ON_PROFILE, ON_PROFILE, "Disabled: retire it rather than convert it.", "Category filtering is off and it has no site exceptions, so a profile would add nothing."]);
  const none = (await designFor(await dataDirFor("v0337-none"), ctxOf(new Tenant()))).design;
  assert.deepEqual([none.policies.length, none.profiles.length], [0, 0]);

  // A dry run that passed and a build made while the classic tenant still had a profile to plan.
  const classic = classicTenant();
  const classicDir = await dataDirFor("v0337-classic");
  const planned = (await designFor(classicDir, ctxOf(classic))).design;
  const pilot = { profileKey: planned.profiles[0].key, enabled: false, targets: { endpoints: ["w1"] } };
  const passed = await dryRun(classicDir, ctxOf(classic), pilot);
  assert.ok(passed.checks.every((c) => c.ok), "the dry run passed");
  const built = await execute(await dataDirFor("v0337-built"), ctxOf(classicTenant()), pilot, TOOL);
  assert.equal(built.status, "built");

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
  const link = `/design.html?tenant=${encodeURIComponent(T)}`;
  let b;
  try {
    b = await openBrowser();
    await b.call("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
    const open = async (ready) => {
      await b.open(`${base}/build.html?tenant=${T}`, 1440, ready);
      assert.equal(await b.evaluate(`document.querySelector("#main .banner-err")?.textContent ?? null`), null, "the page drew without an error");
      const card = await b.evaluate(CARD);
      assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
      return card;
    };

    // Every policy skipped: the card lists why (v0.3.38), as the Design step's Not converted card does.
    assert.deepEqual(await open("[data-no-profiles]"), { note: `${NOTHING} Why each policy wasn't converted:`, link, select: false, form: false, options: [], dry: true, go: true });
    await b.evaluate(`document.querySelector("#dry").click(); document.querySelector("#go").click(); true`);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(posts, [], "a click on either sends nothing");

    // No Web Control policies at all: there's no Not converted card to point at.
    shown = { design: none, items: [] };
    assert.deepEqual(await open("[data-no-profiles]"), { note: `${NOTHING} The tenant has no Web Control policies for the Design step to convert.`, link, select: false, form: false, options: [], dry: true, go: true });

    // The last record is a dry run that passed, from when there was a profile: the form it would fill isn't there, and Create stays off.
    shown = { design: skipped, items: [passed, built] };
    const card = await open(".steps-list");
    assert.deepEqual(card, { note: `${NOTHING} Why each policy wasn't converted:`, link, select: false, form: false, options: [], dry: true, go: true });
    assert.equal(await b.evaluate(`document.querySelectorAll(".steps-list > li").length`), passed.steps.length, "the plan still shows");
    assert.equal(await b.evaluate(`document.querySelector('[data-rollback="${built.id}"]')?.disabled`), false, "the build can still be rolled back");

    // With a profile planned, the card is the form it was.
    shown = { design: planned, items: [] };
    assert.deepEqual(await open("#profile"), { note: null, link: null, select: true, form: true, options: planned.profiles.map((p) => p.name), dry: false, go: true });

    assert.deepEqual(posts, []);
  } finally {
    server.close();
    await b?.close();
  }
});
