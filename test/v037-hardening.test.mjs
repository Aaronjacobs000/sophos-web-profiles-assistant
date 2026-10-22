// v0.3.7 hardening: no framing by other sites, the API answers only the
// tool's own pages, settings values stay on one line in .env, and the data
// folder, the credential file and the audit log are private to the account
// that runs the tool.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { noFraming, ownPagesOnly } from "../backend/dist/middleware/local-host.js";
import { readEnvFile, renderEnvFile, setEnvValues } from "../backend/dist/config/env-file.js";
import { getState, initState } from "../backend/dist/state.js";
import { audit } from "../backend/dist/services/audit-log.js";

// Every folder this file makes in the temp directory goes once its tests are done (v0.3.22, as in v0.3.21), so a run leaves nothing there.
const made = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function fakeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("no other site can frame the tool's pages", () => {
  const res = fakeRes();
  let passed = false;
  noFraming({ headers: {} }, res, () => (passed = true));
  assert.ok(passed);
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'");
});

test("the API refuses a request a browser marks as coming from another site", () => {
  for (const site of ["cross-site", "same-site"]) {
    const res = fakeRes();
    let passed = false;
    ownPagesOnly({ method: "GET", headers: { "sec-fetch-site": site } }, res, () => (passed = true));
    assert.equal(passed, false, site);
    assert.equal(res.statusCode, 403, site);
    assert.equal(res.body.error, "forbidden_site", site);
  }
  for (const headers of [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}]) {
    const res = fakeRes();
    let passed = false;
    ownPagesOnly({ method: "GET", headers }, res, () => (passed = true));
    assert.equal(passed, true, JSON.stringify(headers));
  }
});

test("a value with a line break can't add its own lines to .env", async () => {
  const file = { path: "/x/.env", lines: [{ kind: "entry", key: "SOPHOS_TENANT_LABEL", value: "Old", originalLine: "SOPHOS_TENANT_LABEL=Old" }] };
  for (const value of ["Contoso\nCHROME_PATH=/tmp/x", "Contoso\rCHROME_PATH=/tmp/x", "Contoso\r\nX=y"]) {
    assert.throws(() => setEnvValues(file, { SOPHOS_TENANT_LABEL: value }), /line break/, JSON.stringify(value));
    assert.throws(() => setEnvValues(file, { INTELIX_CLIENT_SECRET: value }), /line break/, "a new key too");
  }
  const ok = renderEnvFile(setEnvValues(file, { SOPHOS_TENANT_LABEL: "Contoso Legal #1" }));
  assert.equal(ok.trim(), 'SOPHOS_TENANT_LABEL="Contoso Legal #1"');
  assert.equal((await readEnvFile("/nonexistent/.env")).lines.length, 0);
});

test("the data folder, the credential file and the audit log are private to the account that runs the tool", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v037-"));
  made.push(root);
  writeFileSync(path.join(root, ".env"), "SOPHOS_TENANT_CLIENT_ID=\n", { mode: 0o644 });
  await initState(root, "0.3.7");
  const dataDir = getState().dataDir;
  assert.equal(statSync(dataDir).mode & 0o777, 0o700, "data folder");
  assert.equal(statSync(path.join(root, ".env")).mode & 0o777, 0o600, ".env made by hand");
  await audit({ tenantId: "00000000-0000-4000-a000-000000000001", tenantName: "Test tenant", action: "save-snapshot", ok: true });
  assert.equal(statSync(path.join(dataDir, "audit.log")).mode & 0o777, 0o600, "audit.log");
});
