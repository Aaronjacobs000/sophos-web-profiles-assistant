// v0.3.9: at phone width the rail sits above the page instead of beside it,
// so the page gets the full width and nothing runs off the side. Measured in a
// headless Chrome or Edge over the DevTools protocol; skipped without one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { findBrowser } from "../backend/dist/services/pdf.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = "00000000-0000-4000-a000-000000000001";
const browser = findBrowser();
const skip = !browser ? "no Chrome or Edge on this computer" : typeof WebSocket === "undefined" ? "this Node has no WebSocket" : false;

const pilot = { buildId: "b1", buildStatus: "built", policyId: "p1", policyName: "WF pilot: Example profile", enabledAtBuild: false, profileId: "pr1", profileName: "Example profile", targets: { endpoints: [] } };
const devices = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, hostname: `EXAMPLE-PC-${String(i + 1).padStart(2, "0")}`, group: "No group" }));
const API = {
  "/api/status": { status: "configured-ok", mode: "tenant", error: null, tenant: { tenantId: T, displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" }, partner: null, version: "0.3.9", readOnly: true },
  [`/api/promote/${T}`]: { pilot, policy: { id: "p1", name: pilot.policyName, enabled: false, priority: 1, type: "web-control", endpoints: 0, endpointGroups: 0, users: 0, userGroups: 0 }, mode: "devices", plan: { waves: [{ n: 1, devices }], inPilot: [], notEligible: [] }, waves: [], waveSize: 30 },
  [`/api/retire/${T}`]: { tags: [], records: [] },
};

/** The tool's pages with a fixed API, on a free port. */
async function pageServer() {
  const app = express();
  app.get("/api/*", (req, res) => (API[req.path] ? res.json(API[req.path]) : res.status(404).json({ error: "not_found" })));
  app.use(express.static(path.join(root, "frontend")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A headless browser and one page in it, driven over the DevTools protocol. */
async function openBrowser() {
  const profile = mkdtempSync(path.join(tmpdir(), "wpa-layout-"));
  const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + String(d)).slice(-2000)));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 300 && !existsSync(portFile) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(portFile)) {
    await stop();
    throw new Error(`The browser didn't start: ${stderr}`);
  }
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
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
  const close = async () => {
    ws.close();
    await stop();
  };
  return { call, listeners, close };
}

// Widths are the page's own (clientWidth), so a browser that draws a scrollbar measures the same.
const PROBE = `(() => {
  const iw = document.documentElement.clientWidth;
  const inScrollBox = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (/auto|scroll|hidden/.test(getComputedStyle(p).overflowX)) return true; return false; };
  const past = [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > iw + 1 && !inScrollBox(e); }).map((e) => e.tagName.toLowerCase() + "." + [...e.classList].join("."));
  const main = document.getElementById("main").getBoundingClientRect();
  const rail = document.getElementById("app-rail").getBoundingClientRect();
  return JSON.stringify({ iw, scrollWidth: document.documentElement.scrollWidth, past: past.slice(0, 10), mainLeft: main.left, mainWidth: main.width, mainTop: main.top, railBottom: rail.bottom, railWidth: rail.width });
})()`;

/** Opens a page at a width and measures the layout once the page has drawn. */
async function measure(b, url, width, ready) {
  await b.call("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
  await b.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const loaded = new Promise((resolve) => b.listeners.push((m) => m.method === "Page.loadEventFired" && resolve()));
  await b.call("Page.navigate", { url });
  await loaded;
  for (let i = 0; i < 100; i++) {
    const r = await b.call("Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(ready)}) && !!document.querySelector("#app-rail .steps")`, returnByValue: true });
    if (r.result.value) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  return JSON.parse((await b.call("Runtime.evaluate", { expression: PROBE, returnByValue: true })).result.value);
}

test("at 390 px the rail sits above the page, which gets the full width with nothing past the edge", { skip, timeout: 60_000 }, async () => {
  const { server, base } = await pageServer();
  let b;
  try {
    b = await openBrowser();
    await b.call("Page.enable");
    await b.call("Runtime.enable");
    for (const [page, ready] of [[`/promote.html?tenant=${T}`, ".wave-list"], ["/help.html", "#main h1"]]) {
      const m = await measure(b, base + page, 390, ready);
      assert.ok(m.iw > 370, `${page}: ${JSON.stringify(m)}`);
      assert.equal(m.scrollWidth, m.iw, `${page}: no sideways scroll: ${JSON.stringify(m)}`);
      assert.deepEqual(m.past, [], `${page}: nothing runs past the right edge`);
      assert.equal(m.mainLeft, 0, `${page}: the rail doesn't squeeze the page: ${JSON.stringify(m)}`);
      assert.equal(m.mainWidth, m.iw, page);
      assert.ok(m.mainTop >= m.railBottom, `${page}: the rail is above the page`);
    }
    // On a desktop the rail stays at the side.
    const wide = await measure(b, `${base}/promote.html?tenant=${T}`, 1440, ".wave-list");
    assert.equal(wide.mainLeft, 236);
    assert.equal(wide.railWidth, 236);
    assert.deepEqual(wide.past, []);
  } finally {
    server.close();
    await b?.close();
  }
});
