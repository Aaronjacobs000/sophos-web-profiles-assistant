// v0.3.33. A request body the server couldn't read (JSON that doesn't parse,
// a body over the 3 MB limit, a charset or content encoding it can't decode)
// was answered with a 500 internal_error, and the parser's own message, which
// can quote part of the body, went to the answer and the log. Such a request
// now gets the parser's 4xx status and a short plain message, and the log
// line names what was wrong without the body. Every other error still gets a
// 500 as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { errorHandler } from "../backend/dist/middleware/error-handler.js";
import { tempIn } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Sent in each bad body, so a test can tell whether any of the body came back. */
const MARK = "marked-body-value-7f3a";

/** A free port on this computer. */
async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** The real server on a free port, read only and not set up, with its own credential file and data folder. */
async function startServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "wpa-v0333-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "backend/dist/server.js")], {
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
  if (!/listening on/.test(out.text)) {
    await stop();
    throw new Error(`The server didn't start:\n${out.text}`);
  }
  return { child, out, base: `http://127.0.0.1:${port}`, stop };
}

async function send(base, url, { method = "PUT", headers = { "content-type": "application/json" }, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, headers, body, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
}

const CASES = [
  {
    name: "JSON that doesn't parse",
    request: { body: `{"clientId": "${MARK}", "clientSecret": ${MARK}}` },
    status: 400,
    answer: { error: "bad_request", message: "The request body isn't valid JSON." },
    logged: "entity.parse.failed",
  },
  {
    name: "a body over the 3 MB limit",
    request: { body: JSON.stringify({ clientId: MARK, pad: "x".repeat(3 * 1024 * 1024) }) },
    status: 413,
    answer: { error: "payload_too_large", message: "The request body is too large." },
    logged: "entity.too.large",
  },
  {
    name: "a charset other than UTF-8",
    request: { headers: { "content-type": "application/json; charset=latin1" }, body: JSON.stringify({ clientId: MARK }) },
    status: 415,
    answer: { error: "unsupported_media_type", message: "Send JSON in UTF-8." },
    logged: "charset.unsupported",
  },
  {
    name: "a content encoding the server can't decode",
    request: { headers: { "content-type": "application/json", "content-encoding": "br" }, body: JSON.stringify({ clientId: MARK }) },
    status: 415,
    answer: { error: "unsupported_media_type", message: "The request body's content encoding isn't supported." },
    logged: "encoding.unsupported",
  },
];

test("a request body the server can't read gets the parser's 4xx status and a plain message, not a 500", { timeout: 60_000 }, async () => {
  const s = await startServer();
  try {
    for (const c of CASES) {
      const r = await send(s.base, "/api/credentials", c.request);
      assert.equal(r.status, c.status, `${c.name}: ${r.text}`);
      assert.match(r.type, /^application\/json/, c.name);
      assert.deepEqual(JSON.parse(r.text), c.answer, c.name);
      assert.ok(!r.text.includes(MARK), `${c.name}: none of the body comes back`);
    }
    // The server is still running and answering, and its log names each problem without the body.
    const logs = await send(s.base, "/api/logs", { method: "GET", headers: {} });
    assert.equal(logs.status, 200);
    const lines = JSON.parse(logs.text).items.map((e) => `${e.level} ${e.message}`);
    for (const c of CASES) assert.ok(lines.some((l) => l === `warn [PUT /api/credentials] ${c.status} ${c.logged}`), `${c.name} is logged: ${lines.join(" | ")}`);
    assert.ok(!logs.text.includes(MARK), "none of a body reaches the log");
    assert.ok(!s.out.text.includes(MARK), "none of a body reaches the console");
    assert.ok(!lines.some((l) => l.startsWith("error [PUT /api/credentials]")), "nothing is logged as a server error");
    // A good body still reaches the route, which answers with its own check.
    const good = await send(s.base, "/api/credentials", { body: "{}" });
    assert.equal(good.status, 400);
    assert.deepEqual(JSON.parse(good.text), { error: "bad_request", message: "A JSON body is required." });
  } finally {
    await s.stop();
  }
});

/** An app with the server's JSON parser and error handler, and routes that fail as given. */
async function appWith(routes) {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  for (const [route, fail] of Object.entries(routes)) {
    app.post(route, (_req, _res, next) => next(fail()));
  }
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("every other error still gets a 500 internal_error with its message", async () => {
  const typed500 = () => Object.assign(new Error("stream is not readable"), { status: 500, statusCode: 500, expose: false, type: "stream.not.readable" });
  const { server, base } = await appWith({
    "/plain": () => new Error("the save failed"),
    "/string": () => "a thrown string",
    "/typed-500": typed500,
    "/status-out-of-range": () => Object.assign(new Error("not a client error"), { status: 600, type: "made.up" }),
    "/expose-false": () => Object.assign(new Error("a 4xx the request didn't cause"), { status: 409, expose: false }),
  });
  try {
    const cases = [
      ["/plain", "the save failed"],
      ["/string", "a thrown string"],
      ["/typed-500", "stream is not readable"],
      ["/status-out-of-range", "not a client error"],
      ["/expose-false", "a 4xx the request didn't cause"],
    ];
    for (const [url, message] of cases) {
      const r = await send(base, url, { method: "POST", body: "{}" });
      assert.equal(r.status, 500, url);
      assert.deepEqual(JSON.parse(r.text), { error: "internal_error", message }, url);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a 4xx error marked as the client's, from body-parser or http-errors, keeps its status", async () => {
  const { server, base } = await appWith({
    // What body-parser passes on when a gzip body won't inflate: a 400 marked for the client, with no type.
    "/inflate": () => Object.assign(new Error(`incorrect header check ${MARK}`), { status: 400, statusCode: 400, expose: true }),
    "/status-code-only": () => Object.assign(new Error(MARK), { statusCode: 413, type: "entity.too.large" }),
  });
  try {
    const inflate = await send(base, "/inflate", { method: "POST", body: "{}" });
    assert.equal(inflate.status, 400);
    assert.deepEqual(JSON.parse(inflate.text), { error: "bad_request", message: "The request body couldn't be read." });
    const codeOnly = await send(base, "/status-code-only", { method: "POST", body: "{}" });
    assert.equal(codeOnly.status, 413);
    assert.deepEqual(JSON.parse(codeOnly.text), { error: "payload_too_large", message: "The request body is too large." });
    // The 1 KB parser in front of the routes answers the same way as the server's.
    const big = await send(base, "/plain-route-not-reached", { method: "POST", body: JSON.stringify({ pad: "x".repeat(2048) }) });
    assert.equal(big.status, 413);
    assert.deepEqual(JSON.parse(big.text), { error: "payload_too_large", message: "The request body is too large." });
    for (const r of [inflate, codeOnly]) assert.ok(!r.text.includes(MARK), "the error's own message doesn't come back");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
