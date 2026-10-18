// The tool's pages served with a fixed API, and a headless Chrome or Edge
// driven over the DevTools protocol, for tests that look at a page as drawn.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { findBrowser } from "../backend/dist/services/pdf.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = findBrowser();

/** Why a browser test can't run here, or false when it can. A run can turn them off with WPA_SKIP_BROWSER=1 (the temp folder test in v0321-fixes does). */
export const skipBrowser = process.env.WPA_SKIP_BROWSER === "1" ? "browser tests are off for this run" : !browser ? "no Chrome or Edge on this computer" : typeof WebSocket === "undefined" ? "this Node has no WebSocket" : false;

/**
 * The frontend on a free port. api maps "METHOD /path" (or "/path" for a GET)
 * to a JSON body, or to a function of the request body that returns one.
 */
export async function pageServer(api) {
  const app = express();
  app.use(express.json());
  app.all("/api/*", (req, res) => {
    const found = api[`${req.method} ${req.path}`] ?? (req.method === "GET" ? api[req.path] : undefined);
    if (found === undefined) return res.status(404).json({ error: "not_found" });
    res.json(typeof found === "function" ? found(req.body) : found);
  });
  app.use(express.static(path.join(root, "frontend")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A headless browser and one page in it. */
export async function openBrowser() {
  const profile = mkdtempSync(path.join(tmpdir(), "wpa-pages-"));
  const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + String(d)).slice(-2000)));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    // The browser's helper processes can hold its stderr open for a while after it exits; the test doesn't wait for them.
    child.stderr.destroy();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const portFile = path.join(profile, "DevToolsActivePort");
  // The browser creates the file before it writes the port in it, so a read in between finds no port (and a fetch then goes to port 80).
  const portIn = () => (existsSync(portFile) ? /^\d+$/.exec(readFileSync(portFile, "utf8").split("\n")[0].trim())?.[0] : undefined);
  let port;
  for (let i = 0; i < 300 && !(port = portIn()) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
  if (!port) {
    await stop();
    throw new Error(`The browser didn't start: ${stderr}`);
  }
  let ws;
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      if (!target) await new Promise((r) => setTimeout(r, 100));
    }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("Couldn't connect to the browser."));
    });
  } catch (err) {
    await stop();
    throw err;
  }
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /** The value of an expression in the page; a promise is awaited. */
  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ""}`);
    return r.result.value;
  };
  /** Opens url at a width, desktop mode, and waits until selector is on the page. */
  const open = async (url, width, selector) => {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
    await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const loaded = new Promise((resolve) => listeners.push((m) => m.method === "Page.loadEventFired" && resolve()));
    await call("Page.navigate", { url });
    await loaded;
    await waitFor(selector);
  };
  /** Waits until selector is on the page, for up to 10 s. */
  const waitFor = async (selector) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Nothing matched ${selector}.`);
  };
  const close = async () => {
    ws.close();
    await stop();
  };
  await call("Page.enable");
  await call("Runtime.enable");
  return { call, evaluate, open, waitFor, close };
}
