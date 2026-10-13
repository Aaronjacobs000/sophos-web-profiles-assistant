import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadOnlyApi, ReadOnlyViolation, errorStatus } from "../backend/dist/sophos/api/requester.js";
import { readInventory } from "../backend/dist/services/inventory-reader.js";

const TENANT = { id: "00000000-0000-4000-a000-000000000001", name: "Test", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" };

/** A fake Sophos API: answers by path, records every request. */
function fakeApi(answers) {
  const seen = [];
  return {
    seen,
    async tenantRequest(_tenantId, path, options = {}) {
      seen.push({ method: options.method ?? "GET", path, params: options.params ?? {} });
      for (const [prefix, answer] of answers) {
        if (path === prefix || path.startsWith(prefix + "?")) {
          if (answer instanceof Error) throw answer;
          return typeof answer === "function" ? answer(path, options) : answer;
        }
      }
      return { items: [], pages: { total: 1 } };
    },
  };
}

test("the read-only client refuses every write before it is sent", async () => {
  const inner = fakeApi([]);
  const api = new ReadOnlyApi(inner);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await assert.rejects(api.tenantRequest("t", "/endpoint/v1/policies", { method }), ReadOnlyViolation);
  }
  assert.equal(inner.seen.length, 0);
  await api.tenantRequest("t", "/endpoint/v1/policies");
  assert.equal(api.calls, 1);
});

test("errorStatus reads the status from a Sophos client error", () => {
  assert.equal(errorStatus(new Error("Sophos API error 403: Forbidden - nope")), 403);
  assert.equal(errorStatus(new Error("Sophos API error (502): bad gateway")), 502);
  assert.equal(errorStatus(new Error("socket hang up")), undefined);
});

test("the inventory read uses GET only, keeps a refused section apart, and looks up only assigned users", async () => {
  const policy = {
    id: "p1",
    name: "Staff",
    type: "web-control",
    priority: 1,
    enabled: true,
    appliesTo: { users: ["u1", "u2"], userGroups: [] },
    settings: {},
  };
  const api = fakeApi([
    ["/endpoint/v1/policies", (_p, o) => ({ items: o.params.policyType === "web-control" ? [policy] : [], pages: { total: 1 } })],
    ["/endpoint/v1/settings/web-control/local-sites", new Error("Sophos API error 403: Forbidden - not licensed")],
    ["/endpoint/v1/settings/web-control/tls-decryption", { categories: [], excludedWebsites: { total: 0, items: [] } }],
    ["/endpoint/v1/settings/web-control/categories", [{ id: 0, name: "UNCATEGORIZED", label: "Uncategorized" }]],
    ["/web-filters/v1/profiles", { items: [{ id: "pr1", name: "Baseline" }], pages: { total: 1 } }],
    ["/web-filters/v1/profiles/pr1", { id: "pr1", name: "Baseline", preset: "keep-it-clean" }],
    ["/web-filters/v1/site-lists", { items: [{ id: "l1", name: "Approved" }], pages: { total: 1 } }],
    ["/web-filters/v1/site-lists/l1/sites", { items: [{ id: "s1", site: "a.example" }], pages: { total: 1 } }],
    ["/common/v1/directory/users", { items: [{ id: "u1", name: "Pat" }], pages: { total: 1 } }],
  ]);
  const inv = await readInventory(api, TENANT);
  assert.ok(api.seen.every((r) => r.method === "GET"));
  assert.equal(inv.localSites.ok, false);
  assert.equal(inv.localSites.status, 403);
  assert.equal(inv.webControlPolicies.ok, true);
  assert.equal(inv.profiles.data[0].preset, "keep-it-clean", "profiles are read in full by ID");
  assert.equal(inv.siteLists.data[0].sites[0].site, "a.example");
  assert.deepEqual(inv.referencedUsers.data.ids, ["u1", "u2"]);
  const userCall = api.seen.find((r) => r.path === "/common/v1/directory/users");
  assert.equal(userCall.params.ids, "u1,u2");
  assert.equal(inv.calls, api.seen.length);
});

test("a tenant that refuses every read leaves the users unlooked-up, not empty", async () => {
  const api = fakeApi([["", null]]);
  api.tenantRequest = async (_t, path) => {
    api.seen.push({ method: "GET", path });
    throw new Error("Sophos API error 403: Forbidden - no access");
  };
  const inv = await readInventory(api, TENANT);
  assert.equal(inv.referencedUsers.ok, false);
  assert.equal(inv.webControlPolicies.status, 403);
  assert.ok(!api.seen.some((r) => r.path === "/common/v1/directory/users"));
});

test("a refused credential reads as one plain sentence", async () => {
  const { friendlyAuthError } = await import("../backend/dist/routes/credentials.js");
  assert.equal(
    friendlyAuthError('Sophos auth failed (401): {"errorCode":"INVALID_CLIENT","trackingId":"e382","error":"invalidClient","message":"Client ID is invalid."}'),
    "Sophos refused the credential (401): Client ID is invalid.",
  );
  assert.equal(friendlyAuthError("Sophos auth failed (500): upstream down"), "Sophos refused the credential (500): upstream down.");
  assert.equal(friendlyAuthError("socket hang up"), "socket hang up");
});
