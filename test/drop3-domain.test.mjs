import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHit, summarize, narrowAllow, WEB_CONTROL_EVENT } from "../backend/dist/domain/digest.js";
import { planWaves, planRetire } from "../backend/dist/domain/promote.js";
import { device, wcPolicy } from "./fixtures.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/siem-webcontrol-events.json", import.meta.url), "utf8"));

test("parseHit reads the live file type wording", () => {
  const h = parseHit("'https://updates-cdn.example.com/build/win/x64/setup-x64.exe' warned due to filetype 'Windows Executable (exe)'");
  assert.equal(h.action, "warned");
  assert.equal(h.host, "updates-cdn.example.com");
  assert.equal(h.reasonType, "filetype");
  assert.equal(h.reasonValue, "Windows Executable (exe)");
});

test("parseHit reads category and site list reasons, and keeps text it can't read", () => {
  assert.deepEqual(
    { ...parseHit("'https://casino.example.com/' blocked due to category 'Gambling'"), url: undefined },
    { url: undefined, host: "casino.example.com", action: "blocked", reasonType: "category", reasonValue: "Gambling" },
  );
  assert.equal(parseHit("'https://x.example.net/a' blocked due to site list 'Block 1'").reasonType, "site list");
  const odd = parseHit("Web page blocked for some new reason");
  assert.equal(odd.action, "unknown");
  assert.equal(odd.reasonValue, "Web page blocked for some new reason");
});

test("summarize counts the fixture by action, day, reason and host, and ignores other event types", () => {
  const d = summarize(FIXTURE.items);
  assert.equal(d.total, 18, "the application event is left out");
  assert.equal(d.byAction.warned, 14);
  assert.equal(d.byAction.blocked, 4);
  assert.equal(d.unparsed, 0);
  assert.deepEqual(d.byDay.map((x) => x.day), ["2026-10-12", "2026-10-13"]);
  assert.equal(d.byReason[0].reason, "File type: Windows Executable (exe)");
  assert.equal(d.byReason[0].hits, 12);
  const installer = d.hosts.find((h) => h.host === "downloads.example-browser.com");
  assert.equal(installer.hits, 6);
  assert.equal(installer.users, 2);
  assert.equal(installer.devices, 2);
  assert.ok(d.hosts.every((h) => h.host && h.host !== "(unreadable)"));
});

test("summarize filters by date", () => {
  const d = summarize(FIXTURE.items, "2026-10-13T00:00:00.000Z");
  assert.equal(d.total, 6, "the six made-up events of 13/10");
  assert.equal(d.byAction.blocked, 4);
  assert.ok(FIXTURE.items.some((e) => e.type !== WEB_CONTROL_EVENT));
});

test("narrowAllow keeps the exact host and refuses wildcards and top-level domains", () => {
  assert.equal(narrowAllow("updates-cdn.example.com"), "updates-cdn.example.com");
  assert.equal(narrowAllow("https://a.example.com/path?q=1"), "a.example.com");
  assert.equal(narrowAllow("*.example.com"), null);
  assert.equal(narrowAllow(".com"), null);
  assert.equal(narrowAllow("not a host!"), null);
});

const devs = [
  device("w1", "windows", "2026.2.2.1.0", { group: { name: "Sales" } }),
  device("w2", "windows", "2026.1.0.5", { group: { name: "Finance" } }),
  device("w3", "windows", "2026.2.0.1"),
  device("old", "windows", "2025.2.3.8.0"),
  device("mac", "macOS", "2026.2.0.1"),
  device("lin", "linux", "2026.3.0.16"),
  device("srv", "windows", "2026.2.2.1.0", { type: "server", os: { platform: "windows", isServer: true } }),
];

test("planWaves waves only eligible computers not on the pilot, grouped by device group", () => {
  const p = planWaves(devs, ["w3"], 1);
  assert.deepEqual(p.waves.map((w) => w.devices.map((d) => d.id)), [["w2"], ["w1"]], "Finance before Sales, w3 already on the pilot");
  assert.deepEqual(p.inPilot.map((d) => d.id), ["w3"]);
  const reasons = Object.fromEntries(p.notEligible.map((d) => [d.id, d.reason]));
  assert.equal(reasons.old, "windows-old-agent");
  assert.equal(reasons.mac, "macos");
  assert.equal(reasons.srv, "server", "a server can't go on a Web Control policy");
  assert.ok(!("lin" in reasons), "Linux has no Web Control");
  assert.equal(planWaves(devs, [], 25).waves.length, 1);
});

test("planWaves for a server pilot takes servers only", () => {
  const p = planWaves(devs, [], 10, "server");
  assert.deepEqual(p.waves.flatMap((w) => w.devices.map((d) => d.id)), ["srv"]);
});

const site = (id, url, tags, extra = {}) => ({ id, url, tags, ...extra });

test("planRetire takes tags out of policies first, then deletes or untags entries", () => {
  const current = [site("1", "a.example.com", ["old"]), site("2", "b.example.com", ["old", "keep"]), site("3", "c.example.com", ["keep"]), site("4", "d.example.com", ["old"], { categoryId: 3 })];
  const snapshot = current.map((s) => ({ ...s }));
  const pol = wcPolicy({ id: "pol1", name: "Sales", settings: { "endpoint.web-control.tags.settings": { value: [{ tag: "old", action: "allow" }, { tag: "keep", action: "block" }] } } });
  const plan = planRetire(["old"], snapshot, current, [pol, wcPolicy({ id: "pol2" })]);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.steps.map((s) => s.op), ["policy-tags", "delete-entry", "patch-entry", "patch-entry"]);
  assert.deepEqual(plan.steps[0].after, [{ tag: "keep", action: "block" }]);
  assert.deepEqual(plan.steps[2].after, ["keep"]);
  assert.deepEqual(plan.steps[3].after, [], "an entry with a category override is untagged, not deleted");
});

test("planRetire refuses entries the snapshot can't put back", () => {
  const current = [site("1", "a.example.com", ["old"]), site("9", "new.example.com", ["old"])];
  const plan = planRetire(["old"], [current[0]], current, []);
  assert.match(plan.problems.join(" "), /new\.example\.com isn't in the snapshot/);
  assert.match(planRetire(["old"], null, current, []).problems.join(" "), /no Website Management section/);
  assert.match(planRetire(["nope"], current, current, []).problems.join(" "), /No Website Management entry carries/);
});
