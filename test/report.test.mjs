import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, formatWhen } from "../backend/dist/domain/report.js";
import { buildScorecard } from "../backend/dist/domain/scorecard.js";
import { inventory, ok } from "./fixtures.mjs";

function result(inv) {
  return {
    tenant: inv.tenant,
    readAt: inv.readAt,
    durationMs: inv.durationMs,
    calls: inv.calls,
    scorecard: buildScorecard(inv),
    snapshot: { file: "contoso-legal_20261013-115200.json", hash: "b2254fdb2ea98faf9f4c193dc42b4b28db8efaf579a3dcd17c8df6d24d6985ed", bytes: 1000 },
  };
}

test("the report is one self-contained page that says it is unofficial", () => {
  const html = renderReport(result(inventory()), { generatedAt: "2026-10-13T01:00:00.000Z", toolVersion: "0.1.0", timeZone: "Australia/Sydney" });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /Contoso Legal needs one fix before a pilot/);
  assert.match(html, /Unofficial tool, not from Sophos/);
  assert.match(html, /Fix before the pilot/);
  assert.match(html, /contoso-legal_20261013-115200\.json/);
  assert.doesNotMatch(html, /<script|<link |src="http|href="http/i, "no scripts or external files");
  assert.doesNotMatch(html, /[–—]/, "no em or en dashes");
});

test("tenant data is escaped", () => {
  const inv = inventory({ localSites: ok([{ id: "1", url: "<img src=x onerror=alert(1)>.example", tags: ["<b>tag</b>"] }]) });
  inv.tenant = { ...inv.tenant, name: 'Evil "<script>"' };
  const html = renderReport(result(inv), { generatedAt: "2026-10-13T01:00:00.000Z", toolVersion: "0.1.0" });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;b&gt;tag&lt;\/b&gt;/);
});

test("dates read DD/MM/YYYY HH:MM in the given time zone", () => {
  assert.equal(formatWhen("2026-10-13T00:52:00.000Z", "Australia/Sydney"), "13/10/2026 11:52");
  assert.equal(formatWhen("2026-10-13T00:52:00.000Z", "UTC"), "13/10/2026 00:52");
});
