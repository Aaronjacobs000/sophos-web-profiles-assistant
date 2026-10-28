// v0.3.34. A route parameter that isn't valid percent encoding (for example
// GET /api/report/%E0%A4%A.html) was answered with a 500 internal_error whose
// message quoted the parameter back, and the log line held it too. Express
// marks that error 400 but gives it no body-parser type, so the v0.3.33 rule
// didn't cover it. It now gets a 400 bad_request with a fixed plain message,
// and neither the answer nor the log holds the parameter. The app's own errors
// that carry a status still get a 500. The server case runs the real server,
// read only, against a mocked Sophos Fusion API, with its own data folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { errorHandler } from "../backend/dist/middleware/error-handler.js";
import { IntelixError } from "../backend/dist/domain/intelix.js";
import { UnclearWriteError } from "../backend/dist/sophos/client/sophos-client.js";
import { tempIn } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Sent in a bad parameter, so a test can tell whether any of it came back. */
const MARK = "marked-param-value-4c9e";
/** A percent escape that doesn't decode. */
const BAD = "%E0%A4%A";
const PATH_ANSWER = { error: "bad_request", message: "The request path isn't valid." };
const T = "00000000-0000-4000-a000-000000000001";
const HOST = "https://api-us01.central.sophos.com";

/** A mocked Sophos Fusion API, loaded into the server before it starts: one tenant and empty lists. */
const MOCK = `const real = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (u.hostname === "127.0.0.1") return real(input, init);
  if (u.hostname === "id.sophos.com") return json({ access_token: "mock", expires_in: 3600, errorCode: "success" });
  if (u.pathname === "/whoami/v1") return json({ id: "${T}", idType: "tenant", apiHosts: { global: "https://api.central.sophos.com", dataRegion: "${HOST}" } });
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

/** The real server on a free port, read only, with its own credential file and data folder, against the mock. */
async function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "wpa-v0334-"));
  writeFileSync(path.join(dir, "test.env"), "CREDENTIAL_MODE=tenant\nSOPHOS_TENANT_CLIENT_ID=mock-client-id\nSOPHOS_TENANT_CLIENT_SECRET=mock-client-secret\nSOPHOS_TENANT_LABEL=Example Tenant\n", { mode: 0o600 });
  writeFileSync(path.join(dir, "mock-sophos.mjs"), MOCK);
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", path.join(dir, "mock-sophos.mjs"), path.join(root, "backend/dist/server.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), READ_ONLY: "1", WPA_ENV_FILE: path.join(dir, "test.env"), WPA_DATA_DIR: path.join(dir, "data"), SIEM_COLLECT_HOURS: "0", ...tempIn(dir) },
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
  return { child, out, base: `http://127.0.0.1:${port}`, stop };
}

async function send(base, url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, headers, body, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
}

test("a route parameter that isn't valid percent encoding gets a 400 and a plain message that doesn't quote it", { timeout: 60_000 }, async () => {
  const s = await startServer();
  const urls = [`/api/report/${BAD}.html`, `/api/snapshots/${BAD}`, `/api/report/${MARK}${BAD}.pdf`, `/api/snapshots/${MARK}${BAD}/snapshot.json`];
  try {
    for (const url of urls) {
      const r = await send(s.base, url);
      assert.equal(r.status, 400, `${url}: ${r.text}`);
      assert.match(r.type, /^application\/json/, url);
      assert.deepEqual(JSON.parse(r.text), PATH_ANSWER, url);
      assert.ok(!r.text.includes(MARK) && !r.text.includes(BAD), `${url}: the parameter doesn't come back`);
    }
    // The log names the problem without the path or the parameter, and nothing is logged as a server error.
    const logs = await send(s.base, "/api/logs");
    assert.equal(logs.status, 200);
    const lines = JSON.parse(logs.text).items.map((e) => `${e.level} ${e.message}`);
    assert.equal(lines.filter((l) => l === "warn [GET] 400 path parameter not valid").length, urls.length, lines.join(" | "));
    assert.ok(!lines.some((l) => l.startsWith("error [GET")), `no server error is logged: ${lines.join(" | ")}`);
    for (const text of [logs.text, s.out.text]) {
      assert.ok(!text.includes(MARK), "none of a parameter reaches the log or the console");
      assert.ok(!text.includes(BAD) && !text.includes("Failed to decode"), "the bad escape isn't logged");
    }
    // A parameter that decodes still reaches its route, which answers with its own check.
    const good = await send(s.base, `/api/snapshots/${T.replace("-", "%2D")}`);
    assert.equal(good.status, 200, good.text);
    assert.deepEqual(JSON.parse(good.text), { items: [] });
  } finally {
    await s.stop();
  }
});

/** An app with the server's error handler, a route with a parameter, and routes that fail as given. */
async function appWith(routes) {
  const app = express();
  app.get("/things/:id", (req, res) => res.json({ id: req.params.id }));
  for (const [route, fail] of Object.entries(routes)) {
    app.get(route, (_req, _res, next) => next(fail()));
  }
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("only Express's parameter decode error gets the path answer; the app's own errors with a status still get a 500", async () => {
  const intelix = () => new IntelixError("Intelix refused the credential (400).", 400);
  const unclear = () => new UnclearWriteError("Sophos answered 400", "POST", 400);
  const { server, base } = await appWith({
    "/intelix": intelix,
    "/unclear-write": unclear,
    "/uri-error-no-status": () => new URIError("URI malformed"),
    "/uri-error-500": () => Object.assign(new URIError("URI malformed"), { status: 500 }),
    "/not-a-uri-error": () => Object.assign(new Error("Failed to decode param 'x'"), { name: "URIError", status: 400, statusCode: 400 }),
  });
  try {
    const bad = await send(base, `/things/${MARK}${BAD}`);
    assert.equal(bad.status, 400);
    assert.deepEqual(JSON.parse(bad.text), PATH_ANSWER);
    const good = await send(base, "/things/caf%C3%A9");
    assert.deepEqual(JSON.parse(good.text), { id: "café" });
    const cases = [
      ["/intelix", intelix().message],
      ["/unclear-write", unclear().message],
      ["/uri-error-no-status", "URI malformed"],
      ["/uri-error-500", "URI malformed"],
      ["/not-a-uri-error", "Failed to decode param 'x'"],
    ];
    for (const [url, message] of cases) {
      const r = await send(base, url);
      assert.equal(r.status, 500, url);
      assert.deepEqual(JSON.parse(r.text), { error: "internal_error", message }, url);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
