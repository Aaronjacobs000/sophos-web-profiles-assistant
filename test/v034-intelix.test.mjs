// v0.3.4: fixes found testing SophosLabs Intelix live (13/10/2026).

import { test } from "node:test";
import assert from "node:assert/strict";
import { IntelixClient, isSecurityRisk, worthALookup } from "../backend/dist/domain/intelix.js";
import { DEFAULT_CATALOG } from "../backend/dist/domain/categories.js";
import { classify, inputsFromText } from "../backend/dist/domain/cleanup.js";
import { parseSite } from "../backend/dist/domain/sites.js";
import { classifyInputs } from "../backend/dist/services/cleanup-service.js";

const C = DEFAULT_CATALOG;

test("a trusted update site isn't a security risk; threats are", () => {
  assert.equal(isSecurityRisk("SEC_TRUSTED_UPDATE_SITE"), false, "sophos.com came back with this live");
  assert.equal(isSecurityRisk("SEC_UNCATEGORIZED"), false);
  assert.equal(isSecurityRisk(undefined), false);
  assert.equal(isSecurityRisk("SEC_ILLEGAL_PHISHING"), true);
  assert.equal(isSecurityRisk("SEC_PUA_ADWARE"), true);
  assert.equal(isSecurityRisk("SEC_MALWARE_SOMETHING_NEW"), true, "a new threat category still counts");
});

test("the client reads a live-shaped answer: Software updates, trusted, no risk", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
    return new Response(JSON.stringify({ productivityCategory: "PROD_SOFTWARE_UPDATES", productivityScore: 90, requestId: "r", riskLevel: "TRUSTED", securityCategory: "SEC_TRUSTED_UPDATE_SITE", securityScore: 90, ttl: 2592000 }), { status: 200 });
  };
  const c = new IntelixClient({ clientId: "id", clientSecret: "s", region: "au", fetchImpl });
  const l = await c.lookup("sophos.com");
  assert.equal(l.profileCategory, "software-updates");
  assert.equal(l.securityRisk, false);
  assert.equal(l.riskLevel, "TRUSTED");
  const r = classify({ id: "1", raw: "sophos.com", source: "paste", targets: [{ name: "your list", action: "allow", categoryActions: { "software-updates": "allow" } }] }, C, { lookup: l });
  assert.equal(r.verdict, "covered", r.reason);
});

test("only single public sites and addresses are worth a paid lookup", () => {
  for (const [raw, want] of [["chatgpt.com", true], ["8.8.8.8", true], ["https://docs.example.com/a", true], ["203.0.113.0/24", false], [".com", false], ["10.1.2.3", false], ["intranet.corp", false], ["bad host!", false]]) {
    assert.equal(worthALookup(parseSite(raw)), want, raw);
  }
});

test("the clean-up doesn't pay for entries no policy acts on, ranges or private names", async () => {
  const asked = [];
  const intelix = { lookups: 0, lookup: async (q) => (asked.push(q), { url: q, productivityCategory: "PROD_GENERATIVE_AI", profileCategory: "generative-ai", securityRisk: false }) };
  const target = { name: "Staff", action: "block", categoryActions: { "generative-ai": "warn" } };
  const inputs = [
    { id: "a", raw: "chatgpt.com", source: "website-management", targets: [target] },
    { id: "b", raw: "unused.example.com", source: "website-management", targets: [] },
    { id: "c", raw: "203.0.113.0/24", source: "website-management", targets: [target] },
    { id: "d", raw: "intranet.corp", source: "website-management", targets: [target] },
    { id: "e", raw: "chatgpt.com/c/1", source: "website-management", targets: [target] },
  ];
  const { results } = await classifyInputs(inputs, C, { dns: false, intelix });
  assert.deepEqual(asked, ["chatgpt.com", "chatgpt.com/c/1"]);
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.a.categoryLabel, "Generative AI");
  assert.match(by.a.reason, /SophosLabs puts it in Generative AI, which the profile warns on; keep a block entry/);
  assert.equal(by.b.verdict, "remove");
  assert.match(by.c.reason, /address range has no SophosLabs category/);
});

test("a site SophosLabs doesn't know comes back with no category, and says so", async () => {
  const fetchImpl = async (url) => String(url).includes("oauth2")
    ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ productivityScore: 50, securityScore: 30, ttl: 300, requestId: "r" }), { status: 200 });
  const l = await new IntelixClient({ clientId: "id", clientSecret: "s", region: "au", fetchImpl }).lookup("unknown.example.net");
  assert.equal(l.productivityCategory, undefined);
  assert.equal(l.securityRisk, false);
  const r = classify({ id: "1", raw: "unknown.example.net", source: "paste", targets: [{ name: "your list", action: "allow", categoryActions: {} }] }, C, { lookup: l });
  assert.match(r.reason, /SophosLabs has no category for it yet/);
  assert.equal(r.needsDecision, true);
});

test("a broad entry that a category already covers needs no review", () => {
  const l = { url: "blogspot.com", productivityCategory: "PROD_BLOGS_AND_FORUMS", profileCategory: "blogs-forums", securityRisk: false };
  const r = classify({ id: "1", raw: "blogspot.com", source: "paste", targets: [{ name: "Staff", action: "allow", categoryActions: { "blogs-forums": "allow" } }] }, C, { lookup: l });
  assert.equal(r.verdict, "covered");
  assert.equal(r.needsDecision, false);
  assert.equal(r.broad, undefined);
});
