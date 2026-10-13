import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CATALOG, compress, expand, expandPreset, readClassic, groups } from "../backend/dist/domain/categories.js";
import { IntelixClient, notWorthLookingUp } from "../backend/dist/domain/intelix.js";
import { classify, siteListsFrom, inputsFromText, summarise, resultsCsv, SITES_PER_LIST } from "../backend/dist/domain/cleanup.js";
import { parseCsv, toCsv } from "../backend/dist/domain/csv.js";
import { buildDesign, appliesToFor, pilotPolicyBody, checkProfileBody } from "../backend/dist/domain/design.js";
import { planWebsiteManagementRestore, compareToSnapshot } from "../backend/dist/domain/restore.js";
import { buildSnapshot } from "../backend/dist/domain/snapshot.js";
import { inventory, ok, wcPolicy } from "./fixtures.mjs";

const C = DEFAULT_CATALOG;

test("the built-in catalog has 85 categories in 8 groups and 5 presets", () => {
  assert.equal(C.categories.length, 85);
  assert.equal(groups(C).length, 8);
  assert.equal(C.presets.length, 5);
  const gen = C.categories.find((c) => c.name === "generative-ai");
  assert.equal(gen.group, "business");
});

test("Optimal productivity blocks productivity and social networking, as the API metadata says", () => {
  const a = expandPreset(C, "optimal-productivity");
  assert.equal(a.advertisements, "block");
  assert.equal(a["social-networks"], "block");
  assert.ok(!Object.values(a).includes("warn"), "no preset uses warn");
});

test("compress meets the coverage rule: every category once, group or category, plus uncategorized", () => {
  const a = expandPreset(C, "keep-it-clean");
  a["generative-ai"] = "warn";
  const body = compress(C, a);
  assert.ok(!body.categoryGroupActions.some((g) => g.name === "business"), "business can't be a group action once one member differs");
  assert.equal(body.categoryActions.filter((c) => C.categories.find((x) => x.name === c.name)?.group === "business").length, 19);
  assert.ok(body.categoryActions.some((c) => c.name === "uncategorized"));
  assert.deepEqual(expand(C, body), a);
  assert.deepEqual(checkProfileBody(C, { filterByCategory: true, ...body }), []);
  assert.match(checkProfileBody(C, { filterByCategory: true, categoryGroupActions: body.categoryGroupActions.slice(0, 3), categoryActions: [] })[0], /missing/);
});

test("classic categories read as profile categories; inherit takes the Base policy's action", () => {
  const settings = {
    "endpoint.web-control.categories.1.action": { value: "block" },
    "endpoint.web-control.categories.37.action": { value: "block" },
    "endpoint.web-control.categories.52.action": { value: "warn" },
    "endpoint.web-control.categories.2.action": { value: "inherit" },
  };
  const base = { "endpoint.web-control.categories.2.action": { value: "block" } };
  const r = readClassic(C, settings, base);
  assert.equal(r.actions["sexually-explicit"], "block");
  assert.equal(r.actions.anonymizers, "block");
  assert.equal(r.actions.translators, "block");
  assert.equal(r.actions.advertisements, "block");
  assert.deepEqual(r.splits.map((s) => s.classicId), [37]);
  assert.deepEqual(r.lost.map((l) => l.label), ["Violence"]);
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {} } = handler(String(url), init, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

test("Intelix: token with Basic auth, lookup on the regional host with the raw token, category mapped", async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith("/oauth2/token")) return { body: { access_token: "tok-1", expires_in: 3600, token_type: "Bearer" } };
    return { body: { productivityCategory: "PROD_GENERATIVE_AI", securityCategory: "SEC_UNCATEGORIZED", riskLevel: "TRUSTED", requestId: "r1" } };
  });
  const c = new IntelixClient({ clientId: "id", clientSecret: "secret", region: "au", fetchImpl: f, sleep: async () => {} });
  const r = await c.lookup("chatgpt.com");
  assert.equal(r.profileCategory, "generative-ai");
  assert.equal(r.securityRisk, false);
  assert.equal(f.calls[0].init.headers.Authorization, `Basic ${btoa("id:secret")}`);
  assert.equal(f.calls[0].init.body, "grant_type=client_credentials");
  assert.equal(f.calls[1].url, "https://au.api.labs.sophos.com/lookup/urls/v1/chatgpt.com");
  assert.equal(f.calls[1].init.headers.Authorization, "tok-1");
  await c.lookup("https://www.example.com/a b");
  assert.equal(f.calls[2].url, "https://au.api.labs.sophos.com/lookup/urls/v1/https%3A%2F%2Fwww.example.com%2Fa%20b", "token reused, URL percent-encoded");
});

test("Intelix: a 401 gets one new token, a 429 waits and retries, a refused credential says so", async () => {
  let n = 0;
  const f = fakeFetch((url) => {
    if (url.endsWith("/oauth2/token")) return { body: { access_token: `tok-${++n}`, expires_in: 3600 } };
    if (n === 1) return { status: 401, body: { error: "unauthorized" } };
    if (f.calls.filter((c) => c.url.includes("lookup")).length === 2) return { status: 429, body: {} };
    return { body: { productivityCategory: "PROD_NEWS", securityCategory: "SEC_MALWARE_REPOSITORY", riskLevel: "HIGH" } };
  });
  const c = new IntelixClient({ clientId: "a", clientSecret: "b", region: "us", fetchImpl: f, sleep: async () => {} });
  const r = await c.lookup("bad.example");
  assert.equal(r.securityRisk, true);
  assert.equal(r.profileCategory, "news");
  const refused = new IntelixClient({ clientId: "a", clientSecret: "b", region: "de", fetchImpl: fakeFetch(() => ({ status: 400, body: { error: "invalid_client" } })) });
  await assert.rejects(refused.getToken(), /Intelix refused the credential \(400: invalid_client\)/);
  assert.throws(() => new IntelixClient({ clientId: "a", clientSecret: "b", region: "eu" }), /Unknown Intelix region/);
});

test("private addresses and internal names aren't worth a paid lookup", () => {
  assert.equal(notWorthLookingUp("intranet"), true);
  assert.equal(notWorthLookingUp("files.corp"), true);
  assert.equal(notWorthLookingUp("10.1.2.3"), true);
  assert.equal(notWorthLookingUp("203.0.113.5"), false);
  assert.equal(notWorthLookingUp("sophos.com"), false);
});

const block = (name = "Staff") => ({ name, action: "block", categoryActions: expandPreset(C, "keep-it-clean") });
const allow = (name = "Staff") => ({ name, action: "allow", categoryActions: expandPreset(C, "keep-it-clean") });
const look = (cat, extra = {}) => ({ url: "x", productivityCategory: cat, profileCategory: cat === "PROD_UNCATEGORIZED" ? "uncategorized" : { PROD_SEXUALLY_EXPLICIT: "sexually-explicit", PROD_GENERATIVE_AI: "generative-ai", PROD_TRANSLATORS: "translators" }[cat], securityRisk: false, ...extra });

test("clean-up verdicts: Remove, Covered and Exception with reasons", () => {
  const seen = new Set();
  const v = (input, opts = {}) => classify({ id: input.raw, source: "website-management", targets: [block()], ...input }, C, { seen, ...opts });
  assert.equal(v({ raw: "*.example.com" }).site.value, "example.com");
  assert.equal(v({ raw: "bad host!" }).verdict, "remove");
  assert.equal(v({ raw: "Example.com" }).verdict, "remove", "repeats an earlier entry (example.com)");
  assert.match(v({ raw: "orphan.example", targets: [] }).reason, /No policy acts on its tag/);
  assert.match(v({ raw: "promo2019.example" }, { dns: { status: "nxdomain" } }).reason, /doesn't resolve/);
  const covered = v({ raw: "adult.example" }, { lookup: look("PROD_SEXUALLY_EXPLICIT") });
  assert.equal(covered.verdict, "covered");
  assert.match(covered.reason, /already blocks/);
  const exc = v({ raw: "chatgpt.com" }, { lookup: look("PROD_GENERATIVE_AI") });
  assert.equal(exc.verdict, "exception");
  assert.match(exc.reason, /Generative AI, which the profile allows; keep a block entry/);
  const risky = v({ raw: "malware.example" }, { lookup: look("PROD_NEWS", { securityRisk: true, securityCategory: "SEC_MALWARE_REPOSITORY", riskLevel: "HIGH" }) });
  assert.equal(risky.verdict, "covered");
  const riskyAllow = classify({ id: "r", raw: "malware2.example", source: "paste", targets: [allow()] }, C, { lookup: look("PROD_NEWS", { securityRisk: true, securityCategory: "SEC_MALWARE_REPOSITORY", riskLevel: "HIGH" }) });
  assert.equal(riskyAllow.needsDecision, true);
  const none = v({ raw: "payroll.contoso.example" });
  assert.equal(none.verdict, "exception");
  assert.equal(none.needsDecision, true, "no lookup: kept until decided");
  const mixed = classify({ id: "m", raw: "translate.example", source: "website-management", targets: [block("A"), allow("B")] }, C, { lookup: look("PROD_TRANSLATORS") });
  assert.equal(mixed.action, "mixed");
  assert.equal(mixed.needsDecision, true);
});

test("site lists: one action per list, at most 750 sites, decisions override verdicts", () => {
  const results = [];
  for (let i = 0; i < 760; i++) results.push(classify({ id: `b${i}`, raw: `b${i}.example.com`, source: "paste", targets: [block()] }, C, {}));
  results.push(classify({ id: "a1", raw: "payroll.example.com", source: "paste", targets: [allow()] }, C, {}));
  results.push({ ...classify({ id: "a2", raw: "gone.example.com", source: "paste", targets: [allow()] }, C, {}), decided: { verdict: "remove" } });
  const { lists } = siteListsFrom(results, "Contoso");
  assert.deepEqual(lists.map((l) => [l.name, l.action, l.sites.length]), [["Contoso Block 1", "block", SITES_PER_LIST], ["Contoso Block 2", "block", 10], ["Contoso Allow", "allow", 1]]);
  const s = summarise(results);
  assert.equal(s.remove, 1);
  assert.equal(s.exception, 761);
  assert.match(resultsCsv(results.slice(-1)), /gone\.example\.com.*,remove,yes,Your decision\./);
});

test("pasted lines and CSV become clean-up inputs", () => {
  const lines = inputsFromText("# comment\nexample.com\n\n https://b.example/x \n", "block", {});
  assert.deepEqual(lines.map((l) => [l.raw, l.targets[0].action]), [["example.com", "block"], ["https://b.example/x", "block"]]);
  const csv = inputsFromText('site,action,tags\n"a.example",allow,"Allow;Partners"\nb.example,,\n', "warn", {});
  assert.deepEqual(csv.map((c) => [c.raw, c.targets[0].action, c.tags]), [["a.example", "allow", ["Allow", "Partners"]], ["b.example", "warn", []]]);
});

test("CSV round trip, with formula injection neutralised", () => {
  const text = toCsv(["a", "b"], [["x,y", 'say "hi"'], ["=SUM(A1)", "ok"]]);
  assert.deepEqual(parseCsv(text), [["a", "b"], ["x,y", 'say "hi"'], ["'=SUM(A1)", "ok"]]);
});

test("design: nearest preset, custom when it differs, flags for the split and Generative AI", () => {
  const strict = wcPolicy({
    id: "p-strict",
    name: "Kiosk",
    settings: {
      "endpoint.web-control.categories.1.action": { value: "block" },
      "endpoint.web-control.categories.37.action": { value: "block" },
      "endpoint.web-control.tags.settings": { value: [{ tag: "Blocked", action: "block" }, { tag: "Allowed", action: "allow" }] },
    },
  });
  const basePolicy = wcPolicy({ id: "p-base", name: "Base Policy", priority: 0 });
  const sites = [
    { id: "s1", url: "bad.example", tags: ["Blocked"] },
    { id: "s2", url: "*.payroll.example", tags: ["Allowed"] },
    { id: "s3", url: "chatgpt.com", tags: ["Blocked"] },
  ];
  const d = buildDesign(C, [strict, basePolicy], sites, null, { date: "13/10/2026", existingProfiles: 0, existingSiteLists: 0 });
  assert.equal(d.profiles.length, 2);
  const kiosk = d.profiles.find((p) => p.sourcePolicies[0].name === "Kiosk");
  assert.equal(kiosk.mode, "custom");
  assert.deepEqual(checkProfileBody(C, kiosk.body), []);
  assert.ok(kiosk.flags.some((f) => /Proxies and translators/.test(f)));
  assert.ok(kiosk.flags.some((f) => /Generative AI is a new category/.test(f)));
  assert.ok(kiosk.flags.some((f) => /AI services \(chatgpt\.com\)/.test(f)));
  const lists = d.siteLists.filter((l) => kiosk.siteLists.some((x) => x.listKey === l.key));
  assert.deepEqual(lists.map((l) => [l.action, l.sites]), [["block", ["bad.example", "chatgpt.com"]], ["allow", ["payroll.example"]]]);
  assert.ok(kiosk.siteLists.find((l) => l.action === "block").priority > kiosk.siteLists.find((l) => l.action === "allow").priority);
  assert.ok(d.warnings.some((w) => /clean-up step hasn't run/.test(w)));
  const base = d.policies.find((p) => p.policyName === "Base Policy");
  assert.equal(base.nearestPreset.name, "keep-it-clean");
  assert.equal(base.nearestPreset.mismatches, 1, "classic Downloads (allowed) maps to Download freeware and shareware, which Keep it clean blocks");
  const preset = buildDesign(C, [wcPolicy({ id: "pb", name: "Base Policy", priority: 0, settings: { "endpoint.web-control.categories.10.action": { value: "block" } } })], [], null, { date: "13/10/2026", existingProfiles: 0, existingSiteLists: 0 });
  assert.equal(preset.profiles[0].mode, "preset");
  assert.equal(preset.profiles[0].body.preset, "keep-it-clean");
});

test("design merges the closest profiles to fit 20, and skips disabled policies", () => {
  const policies = [wcPolicy({ id: "b", name: "Base Policy", priority: 0 }), wcPolicy({ id: "off", name: "Old", enabled: false })];
  for (let i = 0; i < 22; i++) {
    policies.push(wcPolicy({ id: `p${i}`, name: `P${i}`, priority: i + 1, settings: { [`endpoint.web-control.categories.${[1, 3, 5, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 25, 26, 27, 28][i]}.action`]: { value: "warn" } } }));
  }
  const d = buildDesign(C, policies, [], null, { date: "13/10/2026", existingProfiles: 3, existingSiteLists: 0 });
  assert.equal(d.profiles.length, 17);
  assert.ok(d.warnings.some((w) => /Merged the profiles/.test(w)));
  assert.equal(d.policies.find((p) => p.policyId === "off").skipped, "Disabled: retire it rather than convert it.");
});

test("pilot appliesTo uses the shapes the API accepts", () => {
  assert.deepEqual(appliesToFor({ endpointGroups: ["g"] }), { endpoints: [], endpointGroups: ["g"] }, "device groups always travel with an endpoints key");
  assert.deepEqual(appliesToFor({ users: ["u"] }), { users: ["u"], userGroups: [] });
  assert.deepEqual(appliesToFor({}), { users: [], userGroups: [] });
  assert.throws(() => appliesToFor({ users: ["u"], endpoints: ["e"] }), /not both/);
  const body = pilotPolicyBody("WF pilot", "prof-1", { endpoints: ["e1"] }, false);
  assert.equal(body.priority, 1);
  assert.equal(body.settings["endpoint.web-control.filter-by-web-profile.enabled"].value, true, "the id alone is ignored without this");
  assert.equal(body.settings["endpoint.web-control.web-profile-id"].value, "prof-1");
  assert.equal(body.settings["endpoint.web-control.filetypes.exe-exe.action"].value, "warn");
  assert.equal(body.enabled, false);
});

test("Website Management restore: re-create, patch, and delete only what the tool made", () => {
  const snap = [
    { id: "1", url: "keep.example", tags: ["A"] },
    { id: "2", url: "gone.example", tags: ["B"], comment: "Ticket 9" },
    { id: "3", url: "changed.example", tags: ["C"] },
  ];
  const now = [
    { id: "1", url: "keep.example", tags: ["A"] },
    { id: "3", url: "changed.example", tags: ["X"] },
    { id: "9", url: "someone-else.example", tags: ["Z"] },
    { id: "10", url: "tool-made.example", tags: ["T"] },
  ];
  const steps = planWebsiteManagementRestore(snap, now, new Set(["10"]));
  assert.deepEqual(steps.map((s) => [s.op, s.url]), [["create", "gone.example"], ["patch", "changed.example"], ["delete", "tool-made.example"]]);
  assert.deepEqual(steps[0].body, { url: "gone.example", tags: ["B"], comment: "Ticket 9" });
});

test("snapshot diff: matches after a rollback; others' objects are reported, not counted", () => {
  const tp = ok([{ id: "tp1", name: "Base Policy", type: "threat-protection", priority: 0, enabled: true, settings: {} }]);
  const before = buildSnapshot(inventory({ threatProtectionPolicies: tp, webControlPolicies: ok([wcPolicy({ id: "a", name: "A", priority: 1 }), wcPolicy({ id: "base", name: "Base Policy", priority: 0 })]) }), { name: "t", version: "1" });
  const afterInv = inventory({
    threatProtectionPolicies: tp,
    webControlPolicies: ok([
      wcPolicy({ id: "other", name: "ZZ Claude MT thing", priority: 1 }),
      wcPolicy({ id: "a", name: "A", priority: 2 }),
      wcPolicy({ id: "base", name: "Base Policy", priority: 0 }),
    ]),
  });
  const after = buildSnapshot(afterInv, { name: "t", version: "1" });
  const d = compareToSnapshot(before, after, new Set());
  assert.equal(d.matches, true, "a shifted priority isn't a change; the order among the snapshot's own policies is the same");
  assert.equal(d.identical, false);
  assert.equal(d.othersCount, 1);
  const goneBefore = buildSnapshot(inventory({ threatProtectionPolicies: tp, webControlPolicies: ok([wcPolicy({ id: "x", name: "Theirs", priority: 1 }), wcPolicy({ id: "a", name: "A", priority: 2 }), wcPolicy({ id: "base", name: "Base Policy", priority: 0 })]) }), { name: "t", version: "1" });
  const g = compareToSnapshot(goneBefore, after, new Set(), new Set());
  assert.equal(g.sections[0].missing[0].byTool, false);
  assert.equal(g.matches, true, "a policy someone else removed neither counts nor shifts the order of the rest");
  assert.equal(compareToSnapshot(goneBefore, after, new Set(), new Set(["x"])).matches, false, "one this tool deleted does count");
  const leftover = compareToSnapshot(before, after, new Set(["other"]));
  assert.equal(leftover.matches, false, "an object the tool created and didn't remove fails the match");
  const changed = buildSnapshot(inventory({ threatProtectionPolicies: tp, webControlPolicies: ok([wcPolicy({ id: "a", name: "A", priority: 1, enabled: false }), wcPolicy({ id: "base", name: "Base Policy", priority: 0 })]) }), { name: "t", version: "1" });
  const c = compareToSnapshot(before, changed);
  assert.equal(c.matches, false);
  assert.deepEqual(c.sections[0].changed[0].fields, ["enabled"]);
});

test("profile and site list names fit the API's 50 characters, descriptions 250", async () => {
  const { fitName, NAME_MAX } = await import("../backend/dist/domain/cleanup.js");
  assert.equal(fitName("Short", " Allow"), "Short Allow");
  const long = "Contoso Legal Head Office Finance and Payroll Web Control";
  assert.equal(fitName(long, " Block 2").length, NAME_MAX);
  assert.ok(fitName(long, " Block 2").endsWith(" Block 2"));
  const policies = [wcPolicy({ id: "l1", name: long, priority: 1, settings: { "endpoint.web-control.categories.1.action": { value: "block" }, "endpoint.web-control.tags.settings": { value: [{ tag: "t", action: "allow" }] } } }), wcPolicy({ id: "l2", name: `${long} two`, priority: 2, settings: { "endpoint.web-control.categories.3.action": { value: "block" }, "endpoint.web-control.tags.settings": { value: [{ tag: "t", action: "allow" }] } } })];
  const d = buildDesign(C, policies, [{ id: "s", url: "payroll.example.com", tags: ["t"] }], null, { date: "13/10/2026", existingProfiles: 0, existingSiteLists: 0 });
  for (const p of d.profiles) {
    assert.ok(p.name.length <= 50, p.name);
    assert.ok(String(p.body.description).length <= 250);
  }
  assert.ok(d.siteLists.every((l) => l.name.length <= 50));
  assert.equal(new Set(d.profiles.map((p) => p.name.toLowerCase())).size, d.profiles.length, "names stay unique after shortening");
  const { lists } = siteListsFrom([{ id: "x", raw: "a.example.com", site: { value: "a.example.com" }, verdict: "exception", action: "allow", tags: [] }], `${long} cleaned`);
  assert.ok(lists[0].name.length <= 50 && lists[0].name.endsWith(" Allow"));
});
