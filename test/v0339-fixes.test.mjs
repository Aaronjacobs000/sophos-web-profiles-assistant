// v0.3.39, as drawn in a headless Chrome or Edge (skipped without one), from
// designs and dry runs the services make against an in-memory tenant. The
// Builds table now reads a dry run of a profile the Design step no longer
// plans as "Dry run out of date", as the headline has since v0.3.38, not
// "Dry run passed. Ready to create N objects." And when the last plan's
// profile is no longer planned, the Policy name box drops the name the tool
// made from it ("WF pilot: <old profile>"), which would name the new pilot
// after the old profile, but keeps a name the user typed.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { designFor, dryRun } from "../backend/dist/services/build-service.js";
import { T, Tenant, ctxOf, dataDirFor } from "./memory-tenant.mjs";
import { device, wcPolicy } from "./fixtures.mjs";
import { openBrowser, pageServer, skipBrowser } from "./browser.mjs";

before(() => setReadBackDelays([0, 0]));

const tenantInfo = { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };
const status = { status: "configured-ok", mode: "tenant", error: null, tenant: tenantInfo, partner: null, version: "0.3.39", readOnly: false };
const WATCH = `window.__unhandled = []; window.addEventListener("unhandledrejection", (e) => window.__unhandled.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__unhandled.push(String(e.message)));`;

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

/** The headline, the Policy name box, and each Builds row's pilot name and status. */
const PAGE = `({
  headline: document.querySelector("h1").textContent,
  name: document.querySelector("#pname").value,
  rows: [...document.querySelectorAll(".data-table tbody tr")].map((tr) => [tr.children[1].textContent, tr.children[2].textContent]),
})`;

test("Build: a dry run of a profile no longer planned reads out of date in the Builds table, and its made-up policy name isn't put back", { skip: skipBrowser, timeout: 120_000 }, async () => {
  const two = classicTenant(["Sales", "Finance"]);
  const dir = await dataDirFor("v0339-two");
  const planned = (await designFor(dir, ctxOf(two))).design;
  const [sales, finance] = planned.profiles;
  const run = (profile, name) => dryRun(dir, ctxOf(two), { profileKey: profile.key, name, enabled: false, targets: { endpoints: ["w1"] } });
  const made = await run(finance);
  const typed = await run(finance, "Finance pilot");
  const salesRun = await run(sales);
  assert.deepEqual([made, typed, salesRun].map((r) => [r.pilot.name, r.checks.every((c) => c.ok)]), [["WF pilot: Finance profile", true], ["Finance pilot", true], ["WF pilot: Sales profile", true]]);
  // Finance renamed: its profile is planned under a new name and key, so both Finance dry runs are out of date; Sales's isn't.
  const renamed = (await designFor(await dataDirFor("v0339-renamed"), ctxOf(classicTenant(["Sales", "Finance team"])))).design;

  let shown = { design: renamed, items: [] };
  const { server, base } = await pageServer({
    "/api/status": status,
    [`/api/design/${T}`]: () => ({ design: shown.design, genAi: {} }),
    [`/api/pilot-targets/${T}`]: { endpoints: [{ id: "w1", hostname: "EXAMPLE-PC-01", kind: "computer", eligible: true }], endpointGroups: [], userGroups: [] },
    [`/api/build/${T}`]: () => ({ items: shown.items }),
  });
  const ready = (rec) => `Dry run passed. Ready to create ${rec.steps.length} objects.`;
  let b;
  try {
    b = await openBrowser();
    await b.call("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
    const open = async () => {
      await b.open(`${base}/build.html?tenant=${T}`, 1440, ".data-table");
      const page = await b.evaluate(PAGE);
      assert.deepEqual(await b.evaluate("window.__unhandled"), [], "nothing uncaught");
      return page;
    };

    // The made-up name for a profile that's gone is dropped, so the server names the pilot after the profile chosen now.
    shown = { design: renamed, items: [made, typed, salesRun] };
    assert.deepEqual(await open(), {
      headline: "Dry run out of date",
      name: "",
      rows: [["WF pilot: Finance profile", "Dry run out of date"], ["Finance pilot", "Dry run out of date"], ["WF pilot: Sales profile", ready(salesRun)]],
    });
    assert.equal(await b.evaluate(`document.querySelector("#pname").placeholder`), "WF pilot: profile name");

    // A name the user typed is kept.
    shown = { design: renamed, items: [typed, made] };
    assert.deepEqual(await open(), { headline: "Dry run out of date", name: "Finance pilot", rows: [["Finance pilot", "Dry run out of date"], ["WF pilot: Finance profile", "Dry run out of date"]] });

    // With the profile still planned, the made-up name is put back as before, and every row is ready.
    shown = { design: planned, items: [made, salesRun] };
    assert.deepEqual(await open(), { headline: ready(made), name: "WF pilot: Finance profile", rows: [["WF pilot: Finance profile", ready(made)], ["WF pilot: Sales profile", ready(salesRun)]] });
  } finally {
    server.close();
    await b?.close();
  }
});
