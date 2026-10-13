import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersion,
  compareVersions,
  meetsMinimum,
  coreAgentVersion,
  deviceEligibility,
  summariseEligibility,
} from "../backend/dist/domain/eligibility.js";
import { device } from "./fixtures.mjs";

test("versions parse and compare part by part", () => {
  assert.deepEqual(parseVersion("2026.2.2.1.0"), [2026, 2, 2, 1, 0]);
  assert.equal(parseVersion("2026.1-beta"), null);
  assert.equal(parseVersion(""), null);
  assert.ok(compareVersions([2026, 1], [2026, 1, 0, 0]) === 0);
  assert.ok(compareVersions([2025, 2, 3, 8], [2026, 1]) < 0);
});

test("the minimum is Sophos Endpoint 2026.1", () => {
  assert.equal(meetsMinimum("2026.1.0.1"), true);
  assert.equal(meetsMinimum("2026.1"), true);
  assert.equal(meetsMinimum("2026.2.2.1.0"), true);
  assert.equal(meetsMinimum("2027.0.0"), true);
  assert.equal(meetsMinimum("2026.0.9.9"), false);
  assert.equal(meetsMinimum("2025.2.3.8.0"), false, "Help: classic settings are for Windows on 2025.2.3.8 or earlier");
  assert.equal(meetsMinimum(null), false);
});

test("coreAgent is the version that counts, and only when installed", () => {
  assert.equal(coreAgentVersion(device("x", "windows", "2026.2.0.1")), "2026.2.0.1");
  const notInstalled = device("y", "windows", null, { assignedProducts: [{ code: "coreAgent", version: "2026.3.0.1", status: "notInstalled" }] });
  assert.equal(coreAgentVersion(notInstalled), null);
  const otherProducts = device("z", "windows", null, { assignedProducts: [{ code: "interceptX", version: "2026.3.0.1", status: "installed" }] });
  assert.equal(coreAgentVersion(otherProducts), null);
});

test("only Windows on 2026.1 or later is eligible", () => {
  assert.equal(deviceEligibility(device("a", "windows", "2026.2.2.1.0")).reason, "eligible");
  assert.equal(deviceEligibility(device("b", "windows", "2025.2.3.10.0")).reason, "windows-old-agent");
  assert.equal(deviceEligibility(device("c", "windows", null)).reason, "windows-no-agent-version");
  assert.equal(deviceEligibility(device("d", "macOS", "2026.3.0.1")).reason, "macos", "macOS is not eligible even on a new agent");
  assert.equal(deviceEligibility(device("e", "linux", "2026.3.0.16")).reason, "linux");
  const server = deviceEligibility(device("s", "windows", "2026.1.0.5", { type: "server", os: { platform: "windows", isServer: true } }));
  assert.equal(server.eligible, true);
  assert.equal(server.kind, "server");
});

test("the summary leaves Linux out of the percentage and counts older versions", () => {
  const s = summariseEligibility([
    device("a", "windows", "2026.2.2.1.0"),
    device("b", "windows", "2025.2.3.8.0"),
    device("c", "windows", "2025.2.3.10.0"),
    device("d", "macOS", "2026.1.0.1"),
    device("e", "linux", "2026.3.0.16", { type: "server" }),
  ]);
  assert.equal(s.inScope, 4);
  assert.equal(s.eligible, 1);
  assert.equal(s.percent, 25);
  assert.equal(s.byReason.linux, 1);
  assert.equal(s.ineligibleTotal, 3);
  assert.deepEqual(s.oldWindowsVersions, [{ version: "2025.2.3", count: 2 }]);
  assert.equal(summariseEligibility([]).percent, 0);
});
