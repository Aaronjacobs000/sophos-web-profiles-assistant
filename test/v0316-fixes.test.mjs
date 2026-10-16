// v0.3.16: a route whose work fails (a save to disk, a file that can't be
// read or parsed, a read Sophos refuses) answers with an error and the server
// keeps running. Before, such a failure was left unhandled, which stops the
// server on Node 20 and later. The collection setting's save (PUT
// /pilot/:tenantId/schedule) first, then every other route that awaited work
// outside a try. Each case runs the real server against a mocked Sophos
// Fusion API, with its own data folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = "00000000-0000-4000-a000-000000000001";
const P = "66666666-6666-4666-8666-666666666666";
const HOST = "https://api-us01.central.sophos.com";
const ENV = {
  tenant: "CREDENTIAL_MODE=tenant\nSOPHOS_TENANT_CLIENT_ID=mock-client-id\nSOPHOS_TENANT_CLIENT_SECRET=mock-client-secret\nSOPHOS_TENANT_LABEL=Example Tenant\n",
  partner: "CREDENTIAL_MODE=partner\nSOPHOS_PARTNER_CLIENT_ID=mock-client-id\nSOPHOS_PARTNER_CLIENT_SECRET=mock-client-secret\nSOPHOS_PARTNER_LABEL=Example Partner\n",
};

/** A mocked Sophos Fusion API, loaded into the server before it starts: one tenant, empty lists, and the policies read refused (403) while MOCK_REFUSE_FILE exists. */
const MOCK = `import { existsSync } from "node:fs";
const real = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (u.hostname === "127.0.0.1") return real(input, init);
  if (u.hostname === "id.sophos.com") return json({ access_token: "mock", expires_in: 3600, errorCode: "success" });
  if (u.pathname === "/whoami/v1") {
    return process.env.MOCK_MODE === "partner"
      ? json({ id: "${P}", idType: "partner", apiHosts: { global: "https://api.central.sophos.com" } })
      : json({ id: "${T}", idType: "tenant", apiHosts: { global: "https://api.central.sophos.com", dataRegion: "${HOST}" } });
  }
  if (u.pathname === "/partner/v1/tenants") return json({ items: [{ id: "${T}", name: "Example Tenant", dataRegion: "us01", apiHost: "${HOST}" }], pages: { current: 1, size: 100, total: 1, maxSize: 100 } });
  if (u.pathname === "/endpoint/v1/policies" && existsSync(process.env.MOCK_REFUSE_FILE)) return json({ error: "Forbidden", message: "mock refuses this read" }, 403);
  return json({ items: [], pages: { current: 1, total: 1 } });
};
`;

/** A free port on this computer. */
async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** The real server on a free port, with its own credential file and data folder, against the mock. */
async function startServer(mode) {
  const dir = mkdtempSync(path.join(tmpdir(), "wpa-v0316-"));
  const dataDir = path.join(dir, "data");
  writeFileSync(path.join(dir, "test.env"), ENV[mode], { mode: 0o600 });
  writeFileSync(path.join(dir, "mock-sophos.mjs"), MOCK);
  const refuse = path.join(dir, "refuse-policies");
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", path.join(dir, "mock-sophos.mjs"), path.join(root, "backend/dist/server.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), WPA_ENV_FILE: path.join(dir, "test.env"), WPA_DATA_DIR: dataDir, SIEM_COLLECT_HOURS: "0", MOCK_MODE: mode, MOCK_REFUSE_FILE: refuse },
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
    throw new Error(`The server didn't start configured:\n${out.text}`);
  }
  return { child, out, dataDir, refuse, base: `http://127.0.0.1:${port}`, stop };
}

/** Sends one request and gives up after 5 s. */
async function send(base, c) {
  try {
    const res = await fetch(`${base}${c.url}`, { method: c.method, headers: c.body ? { "content-type": "application/json" } : {}, body: c.body ? JSON.stringify(c.body) : undefined, signal: AbortSignal.timeout(5000) });
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
  } catch (err) {
    return { status: 0, error: err.name === "TimeoutError" ? "no answer in 5 s" : `${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ""}` };
  }
}

const put = (file, text) => (mkdirSync(path.dirname(file), { recursive: true }), writeFileSync(file, text));
/** Replaces a folder with a file, so nothing can be saved in it. */
const notAFolder = (dir) => (rmSync(dir, { recursive: true, force: true }), put(dir, "not a folder"));

// Each case: the request, and what to break in the data folder (or in Sophos) once it has worked.
const CASES = [
  { name: "PUT /pilot/:tenantId/schedule, the tenant's SIEM folder can't be made", method: "PUT", url: `/api/pilot/${T}/schedule`, body: { enabled: true }, break: (s) => notAFolder(path.join(s.dataDir, "siem", T)) },
  { name: "PUT /pilot/:tenantId/schedule, the saved setting isn't JSON", method: "PUT", url: `/api/pilot/${T}/schedule`, body: { enabled: true }, break: (s) => put(path.join(s.dataDir, "siem", T, "state.json"), "{not json") },
  { name: "GET /snapshots/:tenantId, a snapshot that can't be read", method: "GET", url: `/api/snapshots/${T}`, break: (s) => (mkdirSync(path.join(s.dataDir, "snapshots", T), { recursive: true }), symlinkSync(path.join(s.dataDir, "missing"), path.join(s.dataDir, "snapshots", T, "example-tenant_20261016-010000.json"))) },
  { name: "GET /report/:tenantId.html, a check result without its fields", method: "GET", url: `/api/report/${T}.html`, break: (s) => put(path.join(s.dataDir, "results", `${T}.json`), "{}") },
  { name: "GET /report/:tenantId.pdf, a check result without its fields", method: "GET", url: `/api/report/${T}.pdf`, break: (s) => put(path.join(s.dataDir, "results", `${T}.json`), "{}") },
  { name: "GET /cleanup/:tenantId, a clean-up run that isn't JSON", method: "GET", url: `/api/cleanup/${T}`, break: (s) => put(path.join(s.dataDir, "cleanup", `${T}.json`), "{not json") },
  { name: "GET /cleanup/:tenantId/:which.csv, a clean-up run that isn't JSON", method: "GET", url: `/api/cleanup/${T}/results.csv`, break: (s) => put(path.join(s.dataDir, "cleanup", `${T}.json`), "{not json") },
  { name: "GET /cleaner, a cleaner run that isn't JSON", method: "GET", url: "/api/cleaner", break: (s) => put(path.join(s.dataDir, "cleanup", "cleaner.json"), "{not json") },
  { name: "GET /cleaner/:which.csv, a cleaner run that isn't JSON", method: "GET", url: "/api/cleaner/results.csv", break: (s) => put(path.join(s.dataDir, "cleanup", "cleaner.json"), "{not json") },
  { name: "PUT /design/:tenantId, the choice can't be saved", method: "PUT", url: `/api/design/${T}`, body: { genAi: {} }, break: (s) => notAFolder(path.join(s.dataDir, "design")) },
  { name: "PUT /design/:tenantId, Sophos refuses the policies read", method: "PUT", url: `/api/design/${T}`, body: { genAi: {} }, break: (s) => writeFileSync(s.refuse, "") },
  { name: "GET /build/:tenantId, a build record that isn't JSON", method: "GET", url: `/api/build/${T}`, break: (s) => put(path.join(s.dataDir, "builds", T, "55555555-5555-4555-8555-555555555555.json"), "{not json") },
  // The estate view keeps the scan it read in memory, so the file is broken before the first read, as after a restart.
  { name: "GET /estate, a saved scan that isn't JSON", mode: "partner", first: true, method: "GET", url: "/api/estate", break: (s) => put(path.join(s.dataDir, "estate", `${P}.json`), "{not json") },
];

for (const c of CASES) {
  test(`${c.name}: answers with an error, and the server keeps running`, { timeout: 60_000 }, async () => {
    const s = await startServer(c.mode ?? "tenant");
    try {
      // Works before it breaks (409 where there's nothing to show yet), so the failure is the one the case makes.
      if (!c.first) {
        const ok = await send(s.base, c);
        assert.ok(ok.status === 200 || ok.status === 409, `before it breaks: ${ok.status || ok.error} ${ok.body ?? ""}`);
      }
      c.break(s);
      const r = await send(s.base, c);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(s.child.exitCode, null, `the server stopped:\n${s.out.text.split("\n").slice(-12).join("\n")}`);
      assert.ok(r.status >= 400 && r.status < 600, `answered ${r.status || r.error}`);
      assert.match(r.type, /application\/json/, "a JSON answer");
      const body = JSON.parse(r.body);
      assert.ok(body.error && typeof body.message === "string" && body.message.length > 0, `an error with a message, got ${r.body}`);
      assert.ok(!/unhandled/i.test(s.out.text), "nothing logged as unhandled");
      const status = await send(s.base, { method: "GET", url: "/api/status" });
      assert.equal(status.status, 200, "the server still answers");
    } finally {
      await s.stop();
    }
  });
}
