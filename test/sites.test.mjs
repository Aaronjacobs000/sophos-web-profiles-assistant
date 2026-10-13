import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSite, needsRewrite, broadness } from "../backend/dist/domain/sites.js";

test("plain domains pass through; *.example.com becomes example.com", () => {
  assert.deepEqual(parseSite("example.com"), { raw: "example.com", value: "example.com", kind: "domain", host: "example.com", issues: [] });
  const w = parseSite("*.example.com");
  assert.equal(w.kind, "wildcard");
  assert.equal(w.value, "example.com", "the site list API refused *.example.com on 13/10/2026");
  assert.ok(w.issues.includes("wildcard"));
  assert.equal(needsRewrite(w), true);
});

test("schemes, case and spaces are flagged; a port stays, as the API takes it", () => {
  const s = parseSite(" HTTPS://Www.Example.com:8443/path ");
  assert.equal(s.kind, "url");
  assert.equal(s.value, "www.example.com:8443/path");
  assert.ok(s.issues.includes("scheme"));
  assert.ok(s.issues.includes("whitespace"));
  assert.ok(s.issues.includes("uppercase"));
  assert.equal(needsRewrite(s), true);
  assert.equal(needsRewrite(parseSite("Example.COM")), false, "case alone doesn't need a rewrite");
  assert.equal(parseSite("example.com:8443").value, "example.com:8443");
  assert.equal(needsRewrite(parseSite("example.com:8443")), false);
});

test("top-level domains with a leading dot", () => {
  assert.equal(parseSite(".com").kind, "tld");
  assert.equal(parseSite(".co.uk").value, ".co.uk");
});

test("IP addresses and ranges are recognized", () => {
  assert.equal(parseSite("203.0.113.5").kind, "ipv4");
  assert.equal(parseSite("203.0.113.0/24").kind, "cidr4");
  assert.equal(parseSite("2001:db8::1").kind, "ipv6");
  assert.equal(parseSite("2001:db8::/32").kind, "cidr6");
  assert.equal(parseSite("999.1.1.1").kind, "invalid");
});

test("junk is invalid", () => {
  assert.equal(parseSite("").kind, "invalid");
  assert.equal(parseSite("exa mple.com").kind, "domain", "inner spaces are squeezed out and flagged");
  assert.ok(parseSite("exa mple.com").issues.includes("whitespace"));
  assert.equal(parseSite("bad_host!.com").kind, "invalid");
});

test("broad entries: everything, TLDs, public suffixes, wide ranges, shared platforms", () => {
  assert.equal(broadness(parseSite("*")).reason, "everything");
  assert.equal(parseSite("*").value, "");
  assert.equal(broadness(parseSite("com")).reason, "top-level-domain");
  assert.equal(broadness(parseSite(".com")).reason, "top-level-domain");
  assert.equal(broadness(parseSite(".co.uk")).reason, "public-suffix");
  assert.equal(broadness(parseSite("*.com.au")).reason, "public-suffix");
  assert.equal(broadness(parseSite("10.0.0.0/8")).reason, "wide-ip-range");
  assert.equal(broadness(parseSite("10.1.2.0/24")).broad, false);
  assert.equal(broadness(parseSite("*.amazonaws.com")).reason, "shared-platform");
  assert.equal(broadness(parseSite("sharepoint.com")).reason, "shared-platform");
});

test("narrow entries are not broad", () => {
  assert.equal(broadness(parseSite("contoso.sharepoint.com")).broad, false);
  assert.equal(broadness(parseSite("payroll.contoso.example")).broad, false);
  assert.equal(broadness(parseSite("sophos.com")).broad, false);
  assert.equal(broadness(parseSite("203.0.113.9")).broad, false);
});
