// v0.3.1 fixes: servers refused on the computer pilot, Website Management
// category overrides (including 34, Phishing & Fraud), and broad entries
// flagged in the site list cleaner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CATALOG, classicOverrideAction, CLASSIC_ALWAYS_BLOCKED } from "../backend/dist/domain/categories.js";
import { classify, siteListsFrom, inputsFromText } from "../backend/dist/domain/cleanup.js";
import { buildDesign } from "../backend/dist/domain/design.js";
import { buildScorecard } from "../backend/dist/domain/scorecard.js";
import { tenantInputs } from "../backend/dist/services/cleanup-service.js";
import { serverRefusal } from "../backend/dist/services/build-service.js";
import { inventory, ok, wcPolicy } from "./fixtures.mjs";

const C = DEFAULT_CATALOG;
const block16 = { "endpoint.web-control.categories.16.action": { value: "block" }, "endpoint.web-control.categories.37.action": { value: "warn" } };

test("category 34 is Phishing & Fraud: no policy setting, always blocked as an override", () => {
  assert.ok(CLASSIC_ALWAYS_BLOCKED.has(34) && CLASSIC_ALWAYS_BLOCKED.has(46) && CLASSIC_ALWAYS_BLOCKED.has(48));
  assert.deepEqual(classicOverrideAction(34, {}, undefined, true), { action: "block", how: "always-blocked", label: "Phishing & Fraud" });
  assert.equal(classicOverrideAction(34, {}, undefined, false).action, "block", "blocked even with category filtering off");
  assert.deepEqual(classicOverrideAction(16, block16, undefined, true), { action: "block", how: "policy", label: "Gambling" });
  assert.equal(classicOverrideAction(56, block16, undefined, true).how, "follows-37");
  assert.equal(classicOverrideAction(56, block16, undefined, true).action, "warn");
  assert.equal(classicOverrideAction(16, block16, undefined, false).how, "filtering-off");
  assert.equal(classicOverrideAction(55, block16, undefined, true).how, "no-setting", "Custom has no setting");
  assert.equal(classicOverrideAction(16, { "endpoint.web-control.categories.16.action": { value: "inherit" } }, block16, true).action, "block", "inherit takes the Base policy's action");
});

const overrideSites = [
  { id: "o34", url: "fake-bank-login.example.com", categoryId: 34 },
  { id: "o16", url: "casino.example.com", categoryId: 16 },
  { id: "o55", url: "custom.example.com", categoryId: 55 },
];

test("the scorecard lists category overrides and says which are always blocked", () => {
  const sc = buildScorecard(inventory({ localSites: ok(overrideSites), webControlPolicies: ok([wcPolicy({ name: "Base Policy", priority: 0, settings: block16 })]) }));
  const item = sc.items.find((i) => i.id === "category-overrides");
  assert.ok(item, "a category-overrides item");
  assert.equal(item.severity, "plan");
  assert.match(item.detail, /Phishing & Fraud, Spam URLs or Spyware, which classic always blocks/);
  assert.match(item.detail, /1 entry uses a classic category with no profile equivalent/);
  assert.ok(item.evidence.includes("fake-bank-login.example.com: Phishing & Fraud (always blocked)"));
  assert.ok(!sc.items.some((i) => i.id === "untagged-entries"), "overrides aren't untagged entries");
});

test("the design carries overrides into site lists with the policy's action; 34 goes into Block", () => {
  const base = wcPolicy({ id: "b", name: "Base Policy", priority: 0, settings: { ...block16, "endpoint.web-control.categories.4.action": { value: "allow" } } });
  const d = buildDesign(C, [base], overrideSites, null, { date: "13/10/2026", existingProfiles: 0, existingSiteLists: 0 });
  const lists = d.siteLists.map((l) => [l.action, l.sites]);
  assert.deepEqual(lists, [["block", ["fake-bank-login.example.com", "casino.example.com"]]]);
  const flags = d.profiles[0].flags.join(" ");
  assert.match(flags, /1 Website Management entry overrides its category to one classic always blocks/);
  assert.match(flags, /custom\.example\.com \(Custom\)/, "the Custom override is named as not carried over");
});

test("the clean-up keeps an override entry instead of calling it unused", () => {
  const base = wcPolicy({ id: "b", name: "Base Policy", priority: 0, settings: block16 });
  const inputs = tenantInputs(C, [base], overrideSites);
  const by = Object.fromEntries(inputs.map((i) => [i.id, i]));
  assert.equal(by.o34.targets[0].action, "block");
  assert.match(by.o34.targets[0].name, /category override: Phishing & Fraud/);
  assert.equal(by.o55.targets.length, 0);
  const r34 = classify(by.o34, C);
  assert.equal(r34.verdict, "exception");
  assert.equal(r34.needsDecision, false);
  assert.match(r34.reason, /always blocks; profiles have no category override, so it moves to a Block site list/);
  const r55 = classify(by.o55, C);
  assert.equal(r55.verdict, "exception", "not removed as unused");
  assert.equal(r55.needsDecision, true);
  assert.match(r55.reason, /Overrides its category to Custom/);
});

test("broad entries need review, with a reason, and stay out of site lists until decided", () => {
  const inputs = inputsFromText([".com", "*.com", "co.uk", "*.blogspot.com", "10.0.0.0/8", "intranet.example.com", "*.example.com"].join("\n"), "allow", {});
  const seen = new Set();
  const rs = inputs.map((i) => classify(i, C, { seen }));
  const by = Object.fromEntries(rs.map((r) => [r.raw, r]));
  for (const raw of [".com", "*.com", "co.uk", "*.blogspot.com", "10.0.0.0/8"]) {
    assert.equal(by[raw].needsDecision, true, raw);
    assert.ok(by[raw].broad, raw);
    assert.match(by[raw].reason, /^Broad \(/, raw);
  }
  assert.match(by[".com"].reason, /matches every \.com site/);
  assert.equal(by["intranet.example.com"].broad, undefined);
  assert.equal(by["*.example.com"].broad, undefined, "a wildcard on one organization's domain isn't broad");
  const { lists, leftOut } = siteListsFrom(rs, "Test");
  assert.deepEqual(lists.flatMap((l) => l.sites).sort(), ["example.com", "intranet.example.com"]);
  assert.equal(leftOut.length, 5);
  const decided = rs.map((r) => (r.raw === "co.uk" ? { ...r, decided: { verdict: "exception", action: "allow" } } : r));
  assert.ok(siteListsFrom(decided, "Test").lists.flatMap((l) => l.sites).includes("co.uk"), "a decision lets it through");
});

test("the server refusal names the server and says why", () => {
  assert.match(serverRefusal(["DC01"], "device"), /^DC01 is a server device\. The pilot is a Web Control policy, which applies to computers/);
  assert.match(serverRefusal(["S1", "S2"], "device group"), /^S1, S2 are server device groups/);
});
