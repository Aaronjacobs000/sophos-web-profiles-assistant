// Guard, from v0.3.17: nothing a route, timer or background job meets stops
// the server. The real server runs against a mocked Sophos Fusion API that
// refuses or garbles every answer, with a data folder whose files are broken
// or can't be saved, and every API route the server has (read from its
// routers, so a route added later is covered too) is called. After each
// call the process must still be running, every answer must be an answer
// (an /api error is JSON with a message), and the log must not show an
// unhandled error. The background jobs run too: the SIEM collector's first
// run (brought forward from a minute to a moment), a clean-up run and an
// estate scan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statusRouter } from "../backend/dist/routes/status.js";
import { credentialsRouter } from "../backend/dist/routes/credentials.js";
import { logsRouter } from "../backend/dist/routes/logs.js";
import { estateRouter } from "../backend/dist/routes/estate.js";
import { readinessRouter } from "../backend/dist/routes/readiness.js";
import { convertRouter } from "../backend/dist/routes/convert.js";
import { pilotRouter } from "../backend/dist/routes/pilot.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = "00000000-0000-4000-a000-000000000001";
const P = "66666666-6666-4666-8666-666666666666";
const ID = "88888888-0000-4000-8000-000000000001";
const BUILD = "55555555-5555-4555-8555-555555555552";
const SNAP = "example-tenant_20261016-010000.json";
const HOST = "https://api-us01.central.sophos.com";
const ENV = {
  tenant: "CREDENTIAL_MODE=tenant\nSOPHOS_TENANT_CLIENT_ID=mock-client-id\nSOPHOS_TENANT_CLIENT_SECRET=mock-client-secret\nSOPHOS_TENANT_LABEL=Example Tenant\n",
  partner: "CREDENTIAL_MODE=partner\nSOPHOS_PARTNER_CLIENT_ID=mock-client-id\nSOPHOS_PARTNER_CLIENT_SECRET=mock-client-secret\nSOPHOS_PARTNER_LABEL=Example Partner\n",
};

/**
 * Loaded into the server before it starts. Sophos ID and whoami work, so the
 * server is connected; every other Sophos and Intelix call answers as
 * MOCK_ANSWER says: "refuse" is a 403 for everything, "garble" is a 200 with
 * an empty object for every read (no items, no fields) and a 403 for every
 * write. The SIEM collector's first run, a minute after start, comes after a moment.
 */
const MOCK = `const real = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const m = (init.method ?? "GET").toUpperCase();
  if (u.hostname === "127.0.0.1") return real(input, init);
  if (u.hostname === "id.sophos.com") return json({ access_token: "mock", expires_in: 3600, errorCode: "success" });
  if (u.pathname === "/whoami/v1") {
    return process.env.MOCK_MODE === "partner"
      ? json({ id: "${P}", idType: "partner", apiHosts: { global: "https://api.central.sophos.com" } })
      : json({ id: "${T}", idType: "tenant", apiHosts: { global: "https://api.central.sophos.com", dataRegion: "${HOST}" } });
  }
  if (u.pathname === "/partner/v1/tenants") return json({ items: [{ id: "${T}", name: "Example Tenant", dataRegion: "us01", apiHost: "${HOST}" }], pages: { current: 1, total: 1 } });
  if (process.env.MOCK_ANSWER === "garble" && m === "GET") return json({});
  return json({ error: "Forbidden", message: "mock refuses this" }, 403);
};
const setTimeoutReal = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => setTimeoutReal(fn, ms === 60_000 && /startCollector/.test(new Error().stack ?? "") ? 300 : ms, ...args);
`;

/** Every route on the server's routers, as method and path. */
function serverRoutes() {
  const out = [];
  for (const router of [statusRouter, credentialsRouter, logsRouter, estateRouter, readinessRouter, convertRouter, pilotRouter]) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), route: layer.route.path });
    }
  }
  return out;
}

/** The bodies each route is sent: the ones that reach furthest into its work. A route not named here gets {}. */
const BODIES = {
  "POST /credentials/test": [{ mode: "tenant", clientId: "mock-client-id", clientSecret: "mock-client-secret" }, { mode: "partner", clientId: "mock-client-id", clientSecret: "mock-client-secret" }],
  "PUT /intelix": [{ clientId: "mock-intelix-id", clientSecret: "mock-intelix-secret", region: "au" }],
  "POST /intelix/test": [{ clientId: "mock-intelix-id", clientSecret: "mock-intelix-secret", region: "au" }, {}],
  "POST /cleanup/:tenantId/run": [{ dns: false, intelix: true }],
  "PUT /cleanup/:tenantId/decisions": [{ decisions: { [ID]: { verdict: "remove" } } }],
  "POST /cleanup/:tenantId/lists": [{ dryRun: true }, { dryRun: false }, { undo: true }],
  "POST /cleaner/classify": [{ text: "blocked.example.com\nhttps://app.example.org/login", dns: false, intelix: true }, { tenantId: T, dns: false, intelix: false }],
  "PUT /cleaner/decisions": [{ decisions: { [ID]: { verdict: "exception" } } }],
  "POST /cleaner/lists": [{ tenantId: T, dryRun: true }, { tenantId: T, dryRun: false }, { undo: true }],
  "PUT /design/:tenantId": [{ genAi: { p1: "block" } }],
  "POST /build/:tenantId/dry-run": [{ profileKey: "profile", targets: { endpoints: [], endpointGroups: [], userGroups: [] } }],
  "POST /build/:tenantId/execute": [{ profileKey: "profile", enabled: false, targets: { endpoints: [], endpointGroups: [], userGroups: [] } }],
  "POST /build/:tenantId/:buildId/rollback": [{ dryRun: true }, { dryRun: false }],
  "POST /diff/:tenantId": [{}, { snapshotFile: SNAP }],
  "PUT /pilot/:tenantId/schedule": [{ enabled: true }],
  "POST /pilot/:tenantId/import": [{ label: "events.json", data: { items: [{ id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://app.example.com/' blocked due to category 'Chat'", created_at: "2026-10-16T01:00:00.000Z" }] } }, { data: "not events" }],
  "POST /pilot/:tenantId/allow": [{ host: "app.example.com", dryRun: true }, { host: "app.example.com", dryRun: false }, {}],
  "POST /promote/:tenantId/wave": [{ devices: ["w1"], dryRun: true }, { devices: ["w1"], dryRun: false }],
  "POST /promote/:tenantId/enabled": [{ enabled: true }],
  "POST /retire/:tenantId/plan": [{ tags: ["Example tag"] }],
  "POST /retire/:tenantId/execute": [{ tags: ["Example tag"], confirm: true }],
};

/** The calls for every route: its path with ids filled in, and each body (a GET has none). Saving the credential keeps the phase's mode. */
function calls(mode = "tenant") {
  const fill = (route) => route.replace(":tenantId", T).replace(":buildId", BUILD).replace(":id", ID).replace(":file", SNAP).replace(":which", "results");
  return serverRoutes().flatMap(({ method, route }) => {
    const url = `/api${fill(route)}`;
    if (method === "GET") return [{ method, url, route }, ...(route.includes(":which") ? [{ method, url: url.replace("/results.csv", "/0.csv"), route }] : [])];
    const bodies = route === "/credentials" ? [{ mode, clientId: "mock-client-id", clientSecret: "", label: "Example" }] : BODIES[`${method} ${route}`] ?? [{}];
    return bodies.map((body) => ({ method, url, route, body }));
  });
}

/** A free port on this computer. */
async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

const put = (file, text) => (mkdirSync(path.dirname(file), { recursive: true }), writeFileSync(file, text));

/** A data folder with a record of every kind, each with its fields, so the routes go as far as they can. */
function seedRecords(dataDir) {
  const at = "2026-10-15T01:00:00.000Z";
  const step = (order, kind, name, id) => ({ order, kind, key: kind === "policy" ? "pilot" : kind, name, method: "POST", path: "/", summary: "", body: {}, status: "created", id, readBack: "matches" });
  put(path.join(dataDir, "builds", T, `${BUILD}.json`), JSON.stringify({ id: BUILD, tenantId: T, tenantName: "Example Tenant", createdAt: at, status: "built", snapshotFile: SNAP, pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: ["w1"] } }, steps: [step(1, "site-list", "Example Block", "l1"), step(2, "profile", "Example profile", "pr1"), step(3, "policy", "WF pilot: Example profile", "p1")], checks: [] }));
  put(path.join(dataDir, "pilot", `${T}.json`), JSON.stringify({ tenantId: T, allows: [{ id: ID, at, host: "chat.example.org", site: "chat.example.org", buildId: BUILD, profileId: "pr1", listId: "l1", listName: "Example allows", siteId: "s1", createdList: true, status: "added", readBack: "site listed" }] }));
  put(path.join(dataDir, "promote", `${T}.json`), JSON.stringify({ tenantId: T, waves: [{ id: ID, at, buildId: BUILD, policyId: "p1", devices: [{ id: "w1", hostname: "EXAMPLE-PC-01" }], before: { endpoints: [], endpointGroups: [] }, after: { endpoints: ["w1"], endpointGroups: [] }, status: "moved" }] }));
  put(path.join(dataDir, "retire", T, `${ID}.json`), JSON.stringify({ id: ID, tenantId: T, at, tags: ["Example tag"], snapshotFile: SNAP, status: "retired", steps: [{ op: "delete-entry", id: "e1", url: "blocked.example.com", tags: ["Example tag"], status: "done", entry: { id: "e1", url: "blocked.example.com", tags: ["Example tag"] } }], warnings: [] }));
  put(path.join(dataDir, "siem", T, "state.json"), JSON.stringify({ tenantId: T, enabled: true, runs: [] }));
  put(path.join(dataDir, "siem", T, "events-2026-10-16.jsonl"), `${JSON.stringify({ id: "e1", type: "Event::Endpoint::WebControlViolation", name: "'https://app.example.com/' blocked due to category 'Chat'", created_at: "2026-10-16T01:00:00.000Z", endpoint_id: "w1" })}\n`);
  put(path.join(dataDir, "cleanup", "cleaner.json"), JSON.stringify({ scope: "cleaner", tenantId: null, startedAt: at, finishedAt: at, running: false, total: 1, done: 1, options: { dns: false, intelix: false }, intelixLookups: 0, results: [{ id: ID, raw: "blocked.example.com", site: { kind: "domain", value: "blocked.example.com", host: "blocked.example.com" }, tags: [], action: "block", verdict: "exception", reason: "No SophosLabs category looked up; kept until you decide.", needsDecision: true, source: "paste" }], decisions: {} }));
  put(path.join(dataDir, "cleanup", "cleaner.lists.json"), JSON.stringify({ tenantId: T, scope: "cleaner", createdAt: at, lists: [{ name: "Cleaned block", action: "block", sites: 1, id: "l9", status: "created" }] }));
  put(path.join(dataDir, "cleanup", `${T}.lists.json`), JSON.stringify({ tenantId: T, scope: T, createdAt: at, lists: [{ name: "Example cleaned block", action: "block", sites: 1, id: "l8", status: "created" }] }));
  put(path.join(dataDir, "design", `${T}.json`), JSON.stringify({ genAi: {} }));
}

/** Every file seedRecords writes, and the others the tool reads, made unreadable as JSON. */
function corruptRecords(dataDir) {
  for (const file of [
    `builds/${T}/${BUILD}.json`, `pilot/${T}.json`, `promote/${T}.json`, `retire/${T}/${ID}.json`, `siem/${T}/state.json`, `siem/${T}/events-2026-10-16.jsonl`,
    `cleanup/${T}.json`, `cleanup/cleaner.json`, `cleanup/${T}.lists.json`, `cleanup/cleaner.lists.json`, `design/${T}.json`, `results/${T}.json`,
    `snapshots/${T}/${SNAP}`, `estate/${P}.json`,
  ]) put(path.join(dataDir, file), "{not json");
}

/** Every folder the tool saves in, as a file, so no save can be made. */
function unsavable(dataDir) {
  for (const dir of ["builds", "pilot", "promote", "retire", "siem", "cleanup", "design", "results", "snapshots", "estate"]) {
    rmSync(path.join(dataDir, dir), { recursive: true, force: true });
    put(path.join(dataDir, dir), "not a folder");
  }
}

/** The real server on a free port, with its own credential file and data folder, against the mock. */
async function startServer({ mode, answer, prepare }) {
  const dir = mkdtempSync(path.join(tmpdir(), "wpa-guard-"));
  const dataDir = path.join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  prepare(dataDir);
  writeFileSync(path.join(dir, "test.env"), ENV[mode], { mode: 0o600 });
  writeFileSync(path.join(dir, "mock.mjs"), MOCK);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", path.join(dir, "mock.mjs"), path.join(root, "backend/dist/server.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), WPA_ENV_FILE: path.join(dir, "test.env"), WPA_DATA_DIR: dataDir, SIEM_COLLECT_HOURS: "1", MOCK_MODE: mode, MOCK_ANSWER: answer },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { text: "" };
  child.stdout.on("data", (d) => (out.text += d));
  child.stderr.on("data", (d) => (out.text += d));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  for (let i = 0; i < 100 && !/listening on/.test(out.text) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
  const stop = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  };
  if (!/configured-ok/.test(out.text) || !/listening on/.test(out.text)) {
    await stop();
    throw new Error(`The server didn't start connected:\n${out.text}`);
  }
  return { child, out, base: `http://127.0.0.1:${port}`, stop };
}

/** Sends one call and gives up after 30 s. */
async function send(base, c) {
  try {
    const res = await fetch(`${base}${c.url}`, { method: c.method, headers: c.body ? { "content-type": "application/json" } : {}, body: c.body ? JSON.stringify(c.body) : undefined, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
  } catch (err) {
    return { status: 0, error: err.name === "TimeoutError" ? "no answer in 30 s" : `${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ""}` };
  }
}

const PHASES = [
  { name: "every Sophos answer refused, every saved file broken", mode: "tenant", answer: "refuse", prepare: (d) => (seedRecords(d), corruptRecords(d)), collector: /No SIEM collection this time/ },
  { name: "every Sophos read an empty object, every record in place", mode: "tenant", answer: "garble", prepare: seedRecords, collector: /Collected SIEM web events/ },
  { name: "every Sophos answer refused, nothing can be saved", mode: "tenant", answer: "refuse", prepare: (d) => (seedRecords(d), unsavable(d)) },
  { name: "a partner credential, every Sophos answer refused, the saved estate broken", mode: "partner", answer: "refuse", prepare: corruptRecords },
];

test("the routes the guard calls are every route the server has", () => {
  const routes = serverRoutes();
  assert.ok(routes.length >= 50, `found ${routes.length} routes`);
  for (const r of routes) assert.ok(calls().some((c) => c.route === r.route && c.method === r.method), `${r.method} ${r.route} is called`);
});

for (const phase of PHASES) {
  test(`nothing stops the server: ${phase.name}`, { timeout: 240_000 }, async () => {
    const s = await startServer(phase);
    try {
      const wrong = [];
      for (const c of calls(phase.mode)) {
        const r = await send(s.base, c);
        const what = `${c.method} ${c.url}${c.body ? ` ${JSON.stringify(c.body).slice(0, 80)}` : ""}`;
        if (s.child.exitCode !== null) {
          wrong.push(`${what}: the server stopped`);
          break;
        }
        if (r.status === 0) wrong.push(`${what}: ${r.error}`);
        else if (r.status >= 400) {
          let body = null;
          try {
            body = JSON.parse(r.body);
          } catch {
            // Not JSON: listed below.
          }
          if (!/application\/json/.test(r.type) || !body || (body.error !== "unconfigured" && typeof (body.message ?? body.error) !== "string")) wrong.push(`${what}: ${r.status} without a JSON error (${r.type}) ${r.body.slice(0, 120)}`);
        }
      }
      // The background jobs started above (a clean-up run, an estate scan, the collector's first run) finish in their own time.
      await new Promise((r) => setTimeout(r, 1500));
      assert.deepEqual(wrong, [], s.out.text.split("\n").slice(-15).join("\n"));
      assert.equal(s.child.exitCode, null, `the server stopped:\n${s.out.text.split("\n").slice(-15).join("\n")}`);
      assert.equal((await send(s.base, { method: "GET", url: "/api/status" })).status, 200, "the server still answers");
      assert.ok(!/unhandled/i.test(s.out.text), `nothing was left unhandled:\n${s.out.text.split("\n").filter((l) => /unhandled/i.test(l)).slice(0, 5).join("\n")}`);
      if (phase.collector) assert.match(s.out.text, phase.collector, "the collector's first run happened, and ended as it should");
    } finally {
      await s.stop();
    }
  });
}
