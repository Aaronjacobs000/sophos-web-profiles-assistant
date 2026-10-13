import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the static site list cleaner builds as one file and its library classifies without a server", async () => {
  execFileSync(process.execPath, [path.join(root, "scripts/build-static-cleaner.mjs")], { stdio: "pipe" });
  const html = readFileSync(path.join(root, "build/site-list-cleaner.html"), "utf8");
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|\/api\//, "no external files and no calls to the tool's server");
  assert.match(html, /Unofficial tool, not from Sophos/);
  const lib = html.split("<script>")[1].split("</script>")[0];
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ productivityCategory: "PROD_SEXUALLY_EXPLICIT", securityCategory: "SEC_UNCATEGORIZED", riskLevel: "LOW" }), { status: 200 });
  };
  const ctx = vm.createContext({ Response, btoa, fetch, setTimeout, URL, console });
  vm.runInContext(`${lib}\nglobalThis.__lib = { inputsFromText, classify, expandPreset, DEFAULT_CATALOG, IntelixClient, siteListsFrom };`, ctx);
  const { inputsFromText, classify, expandPreset, DEFAULT_CATALOG, IntelixClient, siteListsFrom } = ctx.__lib;
  const inputs = inputsFromText("adult.example\npayroll.contoso.example\n", "block", expandPreset(DEFAULT_CATALOG, "keep-it-clean"));
  const client = new IntelixClient({ clientId: "a", clientSecret: "b", region: "au" });
  const lookup = await client.lookup("adult.example");
  const r1 = classify(inputs[0], DEFAULT_CATALOG, { lookup });
  const r2 = classify(inputs[1], DEFAULT_CATALOG, {});
  assert.equal(r1.verdict, "covered");
  assert.equal(r2.verdict, "exception");
  assert.equal(siteListsFrom([r1, r2], "Cleaned").lists[0].sites[0], "payroll.contoso.example");
  assert.ok(calls.every((u) => u.includes("api.labs.sophos.com")), "only Intelix is called");
});
