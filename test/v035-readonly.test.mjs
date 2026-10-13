// v0.3.5: read-only mode, the data folder and credential file outside the
// repo, the partner tenant allow-list, and fixes from a read-only test on a
// real customer tenant.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { guardRequest, installFetchGuard, readOnlyMode, ReadOnlyModeError } from "../backend/dist/sophos/read-only-guard.js";
import { SophosClient } from "../backend/dist/sophos/client/sophos-client.js";
import { storagePaths, tenantAllowList } from "../backend/dist/state.js";

const ON = { READ_ONLY: "1" };
const FUSION = "https://api-us01.central.sophos.com/endpoint/v1/settings/web-control/local-sites";

test("read-only mode refuses every write to a Sophos host, and nothing else", () => {
  assert.equal(readOnlyMode({}), false);
  assert.equal(readOnlyMode({ READ_ONLY: "true" }), true);
  assert.doesNotThrow(() => guardRequest(FUSION, "POST", {}), "off by default");
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    assert.throws(() => guardRequest(FUSION, m, ON), ReadOnlyModeError, m);
  }
  assert.throws(() => guardRequest("https://api.central.sophos.com/partner/v1/tenants", "POST", ON), /refused POST api\.central\.sophos\.com\/partner\/v1\/tenants before it was sent/);
  assert.throws(() => guardRequest("https://api-eu02.central.sophos.com/web-filters/v1/site-lists", "DELETE", ON), ReadOnlyModeError);
  assert.doesNotThrow(() => guardRequest(FUSION, "GET", ON));
  assert.doesNotThrow(() => guardRequest(FUSION, undefined, ON), "no method means GET");
  assert.doesNotThrow(() => guardRequest("https://id.sophos.com/api/v2/oauth2/token", "POST", ON), "the Sophos ID token call");
  assert.doesNotThrow(() => guardRequest("https://api.labs.sophos.com/oauth2/token", "POST", ON), "the Intelix token call");
  assert.doesNotThrow(() => guardRequest("https://au.api.labs.sophos.com/lookup/urls/v1/x.com", "GET", ON), "Intelix lookups are GETs");
  assert.throws(() => guardRequest("https://id.sophos.com/api/v2/other", "POST", ON), ReadOnlyModeError, "only the token path");
});

test("the fetch guard refuses a write before the real fetch is called", async () => {
  const prev = process.env.READ_ONLY;
  process.env.READ_ONLY = "1";
  try {
    const sent = [];
    const target = { fetch: async (url, init) => (sent.push(`${init?.method ?? "GET"} ${url}`), new Response("{}", { status: 200 })) };
    installFetchGuard(target);
    installFetchGuard(target);
    await assert.rejects(() => target.fetch(FUSION, { method: "POST", body: "{}" }), ReadOnlyModeError);
    await assert.rejects(async () => target.fetch(new Request(FUSION, { method: "DELETE" })), ReadOnlyModeError);
    await target.fetch(FUSION);
    await target.fetch("https://id.sophos.com/api/v2/oauth2/token", { method: "POST" });
    assert.deepEqual(sent, [`GET ${FUSION}`, "POST https://id.sophos.com/api/v2/oauth2/token"], "the refused writes never reached fetch");
  } finally {
    if (prev === undefined) delete process.env.READ_ONLY;
    else process.env.READ_ONLY = prev;
  }
});

test("the Sophos client refuses a write in read-only mode even without the fetch guard", async () => {
  const prev = process.env.READ_ONLY;
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => (sent.push(init?.method ?? "GET"), new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  process.env.READ_ONLY = "1";
  try {
    const client = new SophosClient({ getToken: async () => "t" }, { resolveApiHost: async () => "https://api-us01.central.sophos.com" });
    await assert.rejects(client.tenantRequest("t1", "/endpoint/v1/settings/web-control/local-sites", { method: "POST", body: {} }), ReadOnlyModeError);
    await client.tenantRequest("t1", "/endpoint/v1/settings/web-control/local-sites");
    assert.deepEqual(sent, ["GET"]);
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.READ_ONLY;
    else process.env.READ_ONLY = prev;
  }
});

test("a credential file and data folder can live outside the repo", () => {
  const root = "/repo";
  assert.deepEqual(storagePaths(root, {}), { envPath: path.join(root, ".env"), dataDir: path.join(root, "data") });
  assert.deepEqual(storagePaths(root, { WPA_ENV_FILE: "/secure/customer.env", WPA_DATA_DIR: "/secure/data" }), { envPath: "/secure/customer.env", dataDir: "/secure/data" });
});

test("WPA_TENANTS limits a partner credential to the listed tenants", () => {
  assert.equal(tenantAllowList({}), null);
  assert.deepEqual([...tenantAllowList({ WPA_TENANTS: " AAAA-1 , bbbb-2,," })], ["aaaa-1", "bbbb-2"]);
});
