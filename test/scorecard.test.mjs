import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScorecard, policyOrder } from "../backend/dist/domain/scorecard.js";
import { inventory, ok, wcPolicy, tpPolicy, device } from "./fixtures.mjs";

const ids = (sc) => sc.items.map((i) => i.id);
const item = (sc, id) => sc.items.find((i) => i.id === id);

test("decryption off in every live Threat Protection policy is a fix", () => {
  const sc = buildScorecard(inventory());
  assert.equal(item(sc, "decryption-off").severity, "fix");
  assert.equal(item(sc, "decryption-off").title, "HTTPS decryption is off in the Threat Protection policy");
  assert.equal(sc.verdict, "fixes");
  assert.match(sc.headline, /^Contoso Legal needs one fix before a pilot$/);
});

test("decryption on in some policies is a plan item; disabled policies don't count", () => {
  const on = { "endpoint.threat-protection.web-control.tls-decryption.enabled": { value: true } };
  const sc = buildScorecard(
    inventory({
      threatProtectionPolicies: ok([tpPolicy({ settings: on }), tpPolicy({ name: "Kiosk", priority: 1 }), tpPolicy({ name: "Old", priority: 2, enabled: false })]),
    }),
  );
  assert.equal(item(sc, "decryption-partial").severity, "plan");
  assert.deepEqual(item(sc, "decryption-partial").evidence, ["Kiosk"]);
  assert.ok(!ids(sc).includes("decryption-off"));
});

test("decryption and Block QUIC on everywhere pass", () => {
  const on = {
    "endpoint.threat-protection.web-control.tls-decryption.enabled": { value: true },
    "endpoint.threat-protection.web-control.tls-decryption.quic.enabled": { value: true },
  };
  const sc = buildScorecard(inventory({ threatProtectionPolicies: ok([tpPolicy({ settings: on })]) }));
  assert.equal(item(sc, "decryption-on").severity, "ok");
  assert.equal(item(sc, "quic-on").severity, "ok");
  assert.equal(sc.verdict, "ready");
  assert.equal(sc.headline, "Contoso Legal is ready for a pilot");
});

test("no eligible device is a fix; some ineligible is a plan item", () => {
  const none = buildScorecard(inventory({ endpoints: ok([device("b", "windows", "2025.2.3.8.0"), device("m", "macOS", "2026.1.0")]) }));
  assert.equal(item(none, "eligible-none").severity, "fix");
  const some = buildScorecard(inventory());
  assert.equal(item(some, "eligible-partial").severity, "plan");
  assert.match(item(some, "eligible-partial").detail, /1 macOS device, 1 Windows device below Sophos Endpoint 2026.1/);
});

test("Website Management: unused tags, untagged entries, duplicates, rewrites and broad Allows", () => {
  const allowTags = { "endpoint.web-control.tags.settings": { value: [{ tag: "Allowed", action: "allow" }, { tag: "Blocked", action: "block" }] } };
  const sc = buildScorecard(
    inventory({
      webControlPolicies: ok([wcPolicy({ name: "Staff", settings: allowTags }), wcPolicy({ name: "Base Policy", priority: 0 })]),
      localSites: ok([
        { id: "1", url: "*.amazonaws.com", tags: ["Allowed"] },
        { id: "2", url: "payroll.contoso.example", tags: ["Allowed"] },
        { id: "3", url: "https://bad.example/", tags: ["Blocked"] },
        { id: "4", url: "promo2019.contoso.example", tags: ["Campaign 2019"] },
        { id: "5", url: "orphan.example" },
        { id: "6", url: "payroll.contoso.example", tags: ["Allowed"] },
        { id: "7", url: "youtube.com", categoryId: 49 },
      ]),
    }),
  );
  assert.deepEqual(item(sc, "unused-tags").evidence, ["Campaign 2019 (1)"]);
  assert.deepEqual(item(sc, "untagged-entries").evidence, ["orphan.example"]);
  assert.deepEqual(item(sc, "duplicate-entries").evidence, ["payroll.contoso.example (2 times)"]);
  assert.deepEqual(item(sc, "rewrite-entries").evidence, ["*.amazonaws.com", "https://bad.example/"]);
  assert.equal(item(sc, "broad-allows").evidence.length, 1);
  assert.match(item(sc, "broad-allows").evidence[0], /^\*\.amazonaws\.com: anyone can host content/);
  const wm = sc.facts.websiteManagement;
  assert.equal(wm.entries, 7);
  assert.equal(wm.categoryOverrides, 1);
  assert.deepEqual(wm.byAction, { allow: 3, block: 1, warn: 0, mixed: 0, none: 3 });
});

test("assignments to deleted users and groups, and to empty groups", () => {
  const sc = buildScorecard(
    inventory({
      webControlPolicies: ok([
        wcPolicy({ name: "Marketing", appliesTo: { users: ["u-gone", "u-here"], userGroups: ["g-gone"] } }),
        wcPolicy({ name: "Contractors", priority: 2, appliesTo: { users: [], userGroups: ["g-empty"] }, settings: { "endpoint.web-control.categories.2.action": { value: "block" } } }),
        wcPolicy({ name: "Base Policy", priority: 0 }),
      ]),
      userGroups: ok([{ id: "g-empty", name: "Contractors FY24", users: { total: 0 }, groups: { total: 0 } }]),
      referencedUsers: ok({ ids: ["u-gone", "u-here"], found: [{ id: "u-here", name: "Pat" }] }),
    }),
  );
  assert.deepEqual(item(sc, "deleted-assignments").evidence, ["Marketing: 1 deleted user, 1 deleted user group"]);
  assert.deepEqual(item(sc, "empty-groups").evidence, ['Contractors: "Contractors FY24" (nothing else assigned)']);
  assert.match(item(sc, "gap-check").evidence[0], /^Contractors: advertisements block$/);
});

test("disabled, unassigned, duplicate and shadowed policies", () => {
  const sc = buildScorecard(
    inventory({
      webControlPolicies: ok([
        wcPolicy({ id: "a", name: "Executives", priority: 1, appliesTo: { users: ["u1", "u2"], userGroups: [] } }),
        wcPolicy({ id: "b", name: "Exec copy", priority: 2, appliesTo: { users: ["u1"], userGroups: [] }, settings: { "endpoint.web-control.categories.2.action": { value: "warn" } } }),
        wcPolicy({ id: "c", name: "Old kiosk", priority: 3, enabled: false }),
        wcPolicy({ id: "d", name: "Nobody", priority: 4 }),
        wcPolicy({ id: "e", name: "Base Policy", priority: 0 }),
      ]),
      referencedUsers: ok({ ids: ["u1", "u2"], found: [{ id: "u1" }, { id: "u2" }] }),
    }),
  );
  assert.deepEqual(item(sc, "idle-policies").evidence, ["Old kiosk: disabled", "Nobody: no assignment"]);
  assert.deepEqual(item(sc, "shadowed-policies").evidence, ["Exec copy (priority 2)"]);
  assert.match(item(sc, "duplicate-policies").evidence[0], /"Old kiosk" \(priority 3\) = "Nobody" \(priority 4\)/);
  assert.equal(item(sc, "assignments-ok").severity, "ok");
  assert.deepEqual(
    sc.facts.policies.map((p) => p.name),
    ["Executives", "Exec copy", "Old kiosk", "Nobody", "Base Policy"],
    "top of the order first, Base last",
  );
});

test("logging off, threat-check web exclusions, schedules and decryption exclusions", () => {
  const sc = buildScorecard(
    inventory({
      webControlPolicies: ok([
        wcPolicy({ name: "Quiet", appliesTo: { users: ["u1"], userGroups: [] }, settings: { "endpoint.web-control.web-monitoring.enabled": { value: "no" }, "endpoint.web-control.schedule.enabled": { value: true } } }),
        wcPolicy({ name: "Profiled", priority: 2, appliesTo: { users: ["u2"], userGroups: [] }, settings: { "endpoint.web-control.web-profile.enabled": { value: true }, "endpoint.web-control.web-profile-log-web-events.enabled": { value: false }, "endpoint.web-control.web-profile-id": { value: "gone" } } }),
      ]),
      threatProtectionPolicies: ok([tpPolicy({ settings: { "endpoint.threat-protection.exclusions.scanning": { value: [{ value: "files.contoso.example", type: "web" }] } } })]),
      scanningExclusions: ok([{ id: "x", type: "web", value: "203.0.113.0/24" }, { id: "y", type: "path", value: "C:\\temp\\" }]),
      tlsDecryption: ok({ categories: [{ id: 14, name: "Finance & Investment", decryptionEnabled: false }], excludedWebsites: { total: 1 }, excludedWebsiteItems: [{ value: "bank.example" }] }),
      referencedUsers: ok({ ids: ["u1", "u2"], found: [{ id: "u1" }, { id: "u2" }] }),
    }),
  );
  assert.deepEqual(item(sc, "logging-off").evidence, ["Quiet", "Profiled"]);
  assert.deepEqual(item(sc, "web-exclusions").evidence, ["203.0.113.0/24", "files.contoso.example (Base Policy)"]);
  assert.deepEqual(item(sc, "schedules").evidence, ["Quiet"]);
  assert.deepEqual(item(sc, "decryption-exclusions").evidence, ["Category: Finance & Investment", "bank.example"]);
  assert.equal(item(sc, "missing-profile").severity, "fix");
});

test("a refused section is a fix and its checks are skipped; all refused is unreadable", () => {
  const refused = { ok: false, status: 403, error: "Sophos API error 403: Forbidden" };
  const sc = buildScorecard(inventory({ localSites: refused }));
  assert.equal(item(sc, "unread-localSites").severity, "fix");
  assert.equal(sc.facts.websiteManagement, null);
  assert.equal(sc.unread.length, 1);

  const all = Object.fromEntries(
    ["endpoints", "webControlPolicies", "serverWebControlPolicies", "threatProtectionPolicies", "serverThreatProtectionPolicies", "localSites", "classicCategories", "tlsDecryption", "scanningExclusions", "profiles", "siteLists", "endpointGroups", "userGroups", "referencedUsers"].map((k) => [k, refused]),
  );
  const dead = buildScorecard(inventory(all));
  assert.equal(dead.verdict, "unreadable");
  assert.equal(dead.headline, "Contoso Legal could not be read");
});

test("site lists: 20 per account, and more entries than lists can hold", () => {
  const lists = Array.from({ length: 17 }, (_, i) => ({ id: `l${i}`, name: `List ${i}`, numberOfSites: 1, sites: [{ site: "a.example" }] }));
  const sites = Array.from({ length: 15001 }, (_, i) => ({ id: String(i), url: `s${i}.example.com`, tags: ["Blocked"] }));
  const sc = buildScorecard(inventory({ siteLists: ok(lists), localSites: ok(sites) }));
  assert.equal(item(sc, "site-list-capacity").severity, "plan");
  assert.equal(item(sc, "site-list-capacity").title, "17 of 20 site lists used");
  assert.equal(item(sc, "over-site-list-ceiling").severity, "plan");
  assert.match(item(sc, "large-tags").evidence[0], /^Blocked \(15,001\)|^Blocked \(15001\)/);
});

test("profiles: capacity and owner", () => {
  const profiles = Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, name: `Profile ${i}`, description: i === 0 ? "" : "Owner: IT" }));
  const sc = buildScorecard(inventory({ profiles: ok(profiles) }));
  assert.equal(item(sc, "profile-capacity").severity, "plan");
  assert.equal(item(sc, "profile-capacity").title, "17 of 20 profiles used");
  assert.deepEqual(item(sc, "profiles-no-owner").evidence, ["Profile 0"]);
});

test("items are ordered fix, plan, info, ok, and the text has no em or en dashes", () => {
  const sc = buildScorecard(inventory());
  const order = { fix: 0, plan: 1, info: 2, ok: 3 };
  const seen = sc.items.map((i) => order[i.severity]);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.doesNotMatch(JSON.stringify(sc), /[\u2013\u2014]/);
});

test("policyOrder puts priority 1 first and the Base policy last", () => {
  const list = [{ name: "Base Policy", priority: 0 }, { name: "B", priority: 2 }, { name: "A", priority: 1 }];
  assert.deepEqual(list.sort(policyOrder).map((p) => p.name), ["A", "B", "Base Policy"]);
});
