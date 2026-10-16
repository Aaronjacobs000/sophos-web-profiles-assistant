// v0.3.18: the customer report says an unread section plainly, with what
// Sophos answered on its own Detail line; one tenant whose saved collection
// setting can't be read no longer stops SIEM collection for the others, in
// `npm run collect` or on the server's timer, and the run says which tenant
// wasn't collected and why; and the unused results modal is gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport } from "../backend/dist/domain/report.js";
import { buildScorecard } from "../backend/dist/domain/scorecard.js";
import { enabledTenants, startCollector } from "../backend/dist/services/siem-store.js";
import { getRingBuffer } from "../backend/dist/log.js";
import { inventory } from "./fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = "00000000-0000-4000-a000-000000000001";
const T2 = "00000000-0000-4000-a000-000000000002";
const P = "66666666-6666-4666-8666-666666666666";
const RAW = "Sophos API error 403: Forbidden - mock refuses this";
const put = (file, text) => (mkdirSync(path.dirname(file), { recursive: true }), writeFileSync(file, text));

// ---------- the customer report ----------

const refused = { ok: false, status: 403, error: RAW };
function report(over) {
  const inv = inventory({ tenant: { ...inventory().tenant, name: "Example Tenant" }, ...over });
  const r = { tenant: inv.tenant, readAt: inv.readAt, durationMs: inv.durationMs, calls: inv.calls, scorecard: buildScorecard(inv), snapshot: null };
  return renderReport(r, { generatedAt: "2026-10-17T01:00:00.000Z", toolVersion: "0.3.18", timeZone: "UTC" });
}

/** The report's text less its Detail lines, and the text of its Detail lines. */
function split(html) {
  const body = html.slice(html.indexOf("<body>"));
  const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const details = [...body.matchAll(/<p class="detail" data-error-detail>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]));
  return { main: text(body.replace(/<p class="detail" data-error-detail>[\s\S]*?<\/p>/g, "")), details };
}

test("the report says a section it couldn't read plainly, with what Sophos answered on the item's Detail line", () => {
  const { main, details } = split(report({ endpoints: refused }));
  assert.doesNotMatch(main, /Sophos API error|Forbidden|mock refuses/, "the raw answer isn't in the report's main text");
  assert.match(main, /Couldn't read devices \(403\) The checks that need devices are skipped\. What to do:/);
  assert.deepEqual(details, [`Detail: ${RAW}.`]);
});

test("the report of a tenant nothing could be read in says so plainly, with what Sophos answered on the Detail line", () => {
  const all = Object.fromEntries(Object.entries(inventory()).filter(([, v]) => v && typeof v === "object" && "ok" in v).map(([k]) => [k, refused]));
  const { main, details } = split(report(all));
  assert.doesNotMatch(main, /Sophos API error|Forbidden|mock refuses/, "neither the summary nor the item holds the raw answer");
  assert.match(main, /Example Tenant could not be read Every read was refused \(403\)\. Tenant Example Tenant/);
  assert.match(main, /The API credential can't read this tenant What to do:/);
  assert.deepEqual(details, [`Detail: ${RAW}.`]);
});

test("a report with every section read has no Detail line", () => {
  assert.deepEqual(split(report({})).details, []);
});

// ---------- SIEM collection with one broken setting ----------

/** A data folder with collection on for two tenants, the first one's saved setting not JSON. */
function twoTenants() {
  const dir = mkdtempSync(path.join(tmpdir(), "wpa-v0318-siem-"));
  const dataDir = path.join(dir, "data");
  put(path.join(dataDir, "siem", T, "state.json"), "{not json");
  put(path.join(dataDir, "siem", T2, "state.json"), JSON.stringify({ tenantId: T2, enabled: true, runs: [] }));
  return { dir, dataDir };
}

test("the tenants with collection on are still listed when one tenant's saved setting can't be read, which is listed apart with why", async () => {
  const { dir, dataDir } = twoTenants();
  try {
    const { enabled, unread } = await enabledTenants(dataDir);
    assert.deepEqual(enabled, [T2]);
    assert.deepEqual(unread.map((u) => u.tenantId), [T]);
    assert.match(unread[0].error, /JSON/);
    assert.ok(unread[0].error.includes(path.join(dataDir, "siem", T, "state.json")), "the error names the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server's collector still collects the other tenants when one tenant's saved setting can't be read, and logs which one and why", async (t) => {
  const { dir, dataDir } = twoTenants();
  const asked = [];
  const client = { tenantRequest: async (tenantId, p) => (asked.push(`${tenantId} ${p}`), { items: [], has_more: false }) };
  const contextFor = (id) => {
    if (id !== T && id !== T2) throw new Error(`Tenant ${id} is not one this credential manages.`);
    return { client, tenantId: id, summary: { displayName: id === T ? "Example Tenant" : "Example Tenant 2" } };
  };
  const unhandled = [];
  const on = (reason) => unhandled.push(String(reason));
  process.on("unhandledRejection", on);
  try {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    startCollector(dataDir, 1, contextFor);
    t.mock.timers.tick(60_000);
    const done = () => JSON.parse(readFileSync(path.join(dataDir, "siem", T2, "state.json"), "utf8")).runs.length > 0;
    for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setImmediate(r));
    t.mock.timers.reset();
    assert.deepEqual(asked, [`${T2} /siem/v1/events`], "the other tenant was collected");
    assert.ok(done(), "and its run is on file");
    const lines = getRingBuffer().filter((l) => l.section === "siem").map((l) => l.message);
    assert.ok(lines.some((m) => /^No SIEM collection for Example Tenant: its saved collection setting couldn't be read\. .*JSON/.test(m)), lines.join("\n"));
    assert.ok(!lines.some((m) => /No SIEM collection this time/.test(m)), "the run wasn't skipped");
    assert.deepEqual(unhandled, []);
  } finally {
    t.mock.timers.reset();
    process.off("unhandledRejection", on);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Sophos ID, whoami and the partner's two tenants answer; the SIEM API answers each tenant with no events. Every other call is refused. */
const MOCK = `const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (u.hostname === "id.sophos.com") return json({ access_token: "mock", expires_in: 3600, errorCode: "success" });
  if (u.pathname === "/whoami/v1") return json({ id: "${P}", idType: "partner", apiHosts: { global: "https://api.central.sophos.com" } });
  if (u.pathname === "/partner/v1/tenants") return json({ items: [{ id: "${T}", name: "Example Tenant", dataRegion: "us01", apiHost: "https://api-us01.central.sophos.com" }, { id: "${T2}", name: "Example Tenant 2", dataRegion: "us01", apiHost: "https://api-us01.central.sophos.com" }], pages: { current: 1, total: 1 } });
  if (u.pathname === "/siem/v1/events") { console.error("[mock] SIEM " + new Headers(init.headers).get("X-Tenant-ID")); return json({ items: [], has_more: false }); }
  return json({ error: "Forbidden" }, 403);
};
`;

test("npm run collect collects the other tenants when one tenant's saved setting can't be read, and says which one and why in plain words", async () => {
  const { dir, dataDir } = twoTenants();
  try {
    writeFileSync(path.join(dir, "mock.mjs"), MOCK);
    writeFileSync(path.join(dir, "test.env"), "CREDENTIAL_MODE=partner\nSOPHOS_PARTNER_CLIENT_ID=mock-client-id\nSOPHOS_PARTNER_CLIENT_SECRET=mock-client-secret\nSOPHOS_PARTNER_LABEL=Example Partner\n", { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", path.join(dir, "mock.mjs"), path.join(root, "backend/dist/collect.js")], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, WPA_ENV_FILE: path.join(dir, "test.env"), WPA_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(timer);
    assert.equal(code, 1, "a tenant wasn't collected, so the run ends with 1 for the scheduler");
    assert.match(err, new RegExp(`\\[mock\\] SIEM ${T2}`), "the other tenant was collected");
    assert.doesNotMatch(err, new RegExp(`\\[mock\\] SIEM ${T}`));
    assert.match(out, new RegExp(`^Example Tenant 2 \\(${T2}\\): 0 new web events of 0, 1 pages$`, "m"));
    assert.match(err, new RegExp(`^Example Tenant \\(${T}\\): not collected, because its saved collection setting couldn't be read\\.\\n  Detail: .*JSON.*state\\.json\\)\\.$`, "m"));
    assert.equal(JSON.parse(readFileSync(path.join(dataDir, "siem", T2, "state.json"), "utf8")).runs.length, 1, "its run is on file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the results modal ----------

test("the unused results modal is gone from the page helpers, and nothing asks for it", () => {
  const ui = readFileSync(path.join(root, "frontend/js/ui.js"), "utf8");
  assert.doesNotMatch(ui, /resultsModal|result-list|result-row/);
  const css = readFileSync(path.join(root, "frontend/css/components.css"), "utf8");
  assert.doesNotMatch(css, /\.result-list|\.result-row|\.result-notes/, "nor its styles");
});
