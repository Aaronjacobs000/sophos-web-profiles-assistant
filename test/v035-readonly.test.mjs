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

// ---- found on a real customer tenant (read-only), rebuilt here with invented data ----

test("an entry that only overrides a category isn't counted as doing nothing", async () => {
  const { buildScorecard } = await import("../backend/dist/domain/scorecard.js");
  const { inventory, ok, device } = await import("./fixtures.mjs");
  const sc = buildScorecard(inventory({
    localSites: ok([{ id: "o1", url: "www.streaming.example.com", categoryId: 12, tags: ["Old block list"], comment: "ticket 1" }]),
    endpoints: ok([device("a", "windows", "2026.2.2.1.0"), device("b", "windows", null)]),
  }));
  const wm = sc.items.find((i) => i.id === "website-management");
  assert.match(wm.detail, /1 that works only through a category override/);
  assert.doesNotMatch(wm.detail, /no policy acts on/);
  assert.equal(wm.detail, "1 that works only through a category override.");
  const unused = sc.items.find((i) => i.id === "unused-tags");
  assert.match(unused.detail, /1 entry also overrides a site's category, which still applies/);
  assert.match(unused.fix, /Keep or remove the category overrides/);
  const elig = sc.items.find((i) => i.id === "eligible-partial");
  assert.ok(elig.evidence.some((e) => e === "B: Windows, no agent version"), elig.evidence.join("; "));
});

test("the live category wording parses, ampersand and all", async () => {
  const { parseHit, summarize } = await import("../backend/dist/domain/digest.js");
  const h = parseHit("'https://translate.example.com/' blocked due to category 'Proxies & Translators'");
  assert.equal(h.action, "blocked");
  assert.equal(h.reasonType, "category");
  assert.equal(h.reasonValue, "Proxies & Translators");
  const d = summarize([{ id: "1", type: "Event::Endpoint::WebControlViolation", name: "'https://translate.example.com/' blocked due to category 'Proxies & Translators'", created_at: "2026-10-13T01:00:00Z", source: "CORP\\user1", endpoint_id: "e1" }]);
  assert.deepEqual(d.byReason, [{ reason: "Category: Proxies & Translators", hits: 1 }]);
});

test("retiring a tag no policy uses doesn't warn about devices on classic settings", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { initState } = await import("../backend/dist/state.js");
  const { previewRetire } = await import("../backend/dist/services/retire-service.js");
  const { device, wcPolicy } = await import("./fixtures.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "wpa-v035-"));
  await initState(root, "0.3.5");
  const policies = [wcPolicy({ id: "p1", name: "Base Policy", priority: 0 })];
  const api = {
    tenantRequest: async (_t, p, o = {}) => {
      if ((o.method ?? "GET") !== "GET") throw new Error("no writes");
      if (p.endsWith("/local-sites")) return { items: [{ id: "s1", url: "www.streaming.example.com", categoryId: 12, tags: ["Old block list"] }], pages: { total: 1 } };
      if (p === "/endpoint/v1/policies") return { items: o.params.policyType === "web-control" ? policies : [], pages: { total: 1 } };
      if (p === "/endpoint/v1/endpoints") return { items: [device("old", "windows", "2025.2.3.8.0")], pages: {} };
      return { items: [], pages: { total: 1 } };
    },
  };
  const ctx = { tenantId: "00000000-0000-4000-a000-000000000001", client: api, summary: { displayName: "Test", region: "us01", apiHost: "x", credentialType: "tenant" } };
  const unusedTag = await previewRetire(path.join(root, "data"), ctx, ["Old block list"]);
  assert.deepEqual(unusedTag.warnings, []);
  policies[0].settings["endpoint.web-control.tags.settings"] = { value: [{ tag: "Old block list", action: "block" }] };
  const usedTag = await previewRetire(path.join(root, "data"), ctx, ["Old block list"]);
  assert.match(usedTag.warnings.join(" "), /1 devices can't use profiles/);
});

test("an override SophosLabs can't categorize carries its own action, with no decision needed", async () => {
  const { classify } = await import("../backend/dist/domain/cleanup.js");
  const { DEFAULT_CATALOG } = await import("../backend/dist/domain/categories.js");
  const input = { id: "1", raw: "www.shop.example.com", categoryId: 53, tags: [], source: "website-management", targets: [{ name: "Base Policy (category override: Weapons)", action: "block", categoryActions: {} }] };
  const unknown = classify(input, DEFAULT_CATALOG, { lookup: { url: "www.shop.example.com", securityRisk: false } });
  assert.equal(unknown.verdict, "exception");
  assert.equal(unknown.needsDecision, false);
  assert.match(unknown.reason, /puts it in Weapons, which its policy blocks\. SophosLabs has no category for it, so it moves to a Block site list/);
  const noLookup = classify(input, DEFAULT_CATALOG, {});
  assert.match(noLookup.reason, /No SophosLabs category was looked up/);
});

// ---- found on a large real customer tenant (about 2,900 devices), rebuilt with invented data ----

test("a shortened name ends at a word, without a dangling bracket", async () => {
  const { fitName } = await import("../backend/dist/domain/cleanup.js");
  assert.equal(fitName("Social/Video Block - Front Desk (North Site)", " profile"), "Social/Video Block - Front Desk profile");
  assert.equal(fitName("Short name", " profile"), "Short name profile");
  const long = "Averyveryverylongsinglewordpolicynamewithnospacesatall";
  assert.equal(fitName(long, " profile").length, 50);
});

test("reasons agree in number, and big counts read with separators", async () => {
  const { classify } = await import("../backend/dist/domain/cleanup.js");
  const { DEFAULT_CATALOG } = await import("../backend/dist/domain/categories.js");
  const t = (name) => ({ name, action: "allow", categoryActions: {} });
  const r = classify({ id: "1", raw: "portal.example.com", categoryId: 6, tags: [], source: "website-management", targets: [t("A (category override: Business)"), t("B (category override: Business)")] }, DEFAULT_CATALOG, {});
  assert.match(r.reason, /which its policies allow\./);
  const { buildScorecard } = await import("../backend/dist/domain/scorecard.js");
  const { inventory, ok, wcPolicy } = await import("./fixtures.mjs");
  const sc = buildScorecard(inventory({ webControlPolicies: ok([wcPolicy({ name: "Base Policy", priority: 0, settings: { "endpoint.web-control.categories.2.action": { value: "block" } } })]) }));
  const gap = sc.items.find((i) => i.id === "gap-check");
  assert.match(gap.title, /^1 policy uses /);
});

test("wave size defaults to about ten waves", async () => {
  const { suggestedWaveSize } = await import("../backend/dist/services/promote-service.js");
  assert.equal(suggestedWaveSize(0), 25);
  assert.equal(suggestedWaveSize(156), 25);
  assert.equal(suggestedWaveSize(1753), 200);
  assert.equal(suggestedWaveSize(20000), 500);
});
