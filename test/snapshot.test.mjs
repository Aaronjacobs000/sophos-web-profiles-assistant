import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSnapshot, validateSnapshot, canonicalJson, THREAT_WEB_KEYS, SNAPSHOT_KIND } from "../backend/dist/domain/snapshot.js";
import { initState } from "../backend/dist/state.js";
import { saveSnapshot, loadSnapshot, listSnapshots, objectsHash, snapshotPath } from "../backend/dist/services/snapshot-store.js";
import { inventory, ok, wcPolicy, tpPolicy } from "./fixtures.mjs";

// Every folder this file makes in the temp directory goes once its tests are done (v0.3.22, as in v0.3.21), so a run leaves nothing there.
const made = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const TOOL = { name: "web-profiles-assistant", version: "0.1.0" };
let root;

before(async () => {
  // A repo root with no .env: the state starts unconfigured and makes no network calls.
  root = await mkdtemp(path.join(os.tmpdir(), "wpa-snap-"));
  made.push(root);
  await initState(root, "0.1.0");
});

function rich() {
  return inventory({
    webControlPolicies: ok([wcPolicy({ name: "Staff", appliesTo: { users: ["u1", "u-gone"], userGroups: ["g1"] } }), wcPolicy({ name: "Base Policy", priority: 0 })]),
    threatProtectionPolicies: ok([
      tpPolicy({ settings: { "endpoint.threat-protection.exclusions.scanning": { value: [{ value: "files.example", type: "web" }, { value: "C:\\x\\", type: "path" }] } } }),
    ]),
    localSites: ok([{ id: "1", url: "sophos.com", tags: ["Allow"], comment: "Ticket 666" }]),
    scanningExclusions: ok([{ id: "e1", type: "web", value: "203.0.113.0/24" }, { id: "e2", type: "path", value: "C:\\temp\\" }]),
    profiles: ok([{ id: "p1", name: "Corporate baseline", description: "Owner: IT", preset: "keep-it-clean", siteListActions: [] }]),
    siteLists: ok([{ id: "l1", name: "Approved SaaS", numberOfSites: 1, sites: [{ id: "s1", site: "payroll.example", siteType: "domain" }] }]),
    userGroups: ok([{ id: "g1", name: "Head office" }]),
    referencedUsers: ok({ ids: ["u1", "u-gone"], found: [{ id: "u1", name: "Pat", email: "pat@example.com" }] }),
  });
}

test("the snapshot keeps every web-control object and only the web keys of Threat Protection", () => {
  const s = buildSnapshot(rich(), TOOL);
  assert.equal(s.kind, SNAPSHOT_KIND);
  assert.equal(s.objects.webControlPolicies.length, 2);
  assert.equal(s.objects.websiteManagement[0].comment, "Ticket 666");
  assert.equal(s.objects.siteLists[0].sites[0].site, "payroll.example");
  const tp = s.objects.threatProtectionWebSettings[0];
  assert.deepEqual(Object.keys(tp.settings).sort(), [...THREAT_WEB_KEYS].sort());
  assert.ok(!("endpoint.threat-protection.exploit-mitigation.enabled" in tp.settings));
  assert.deepEqual(tp.webExclusions, [{ value: "files.example", type: "web" }]);
  assert.deepEqual(s.objects.webScanningExclusions.map((x) => x.value), ["203.0.113.0/24"]);
  assert.deepEqual(s.references.users, [
    { id: "u1", name: "Pat", email: "pat@example.com", exists: true },
    { id: "u-gone", exists: false },
  ]);
  assert.equal(s.counts.siteListSites, 1);
  assert.deepEqual(s.unreadSections, []);
  assert.ok(!("endpoints" in s.objects), "devices are context, not objects to restore");
});

test("an unread section is null and listed, never an empty list", () => {
  const s = buildSnapshot(inventory({ localSites: { ok: false, status: 403, error: "Forbidden" } }), TOOL);
  assert.equal(s.objects.websiteManagement, null);
  assert.deepEqual(s.unreadSections, ["localSites"]);
  assert.equal(s.counts.websiteManagementEntries, null);
});

test("validateSnapshot accepts a snapshot and names what is wrong with anything else", () => {
  assert.equal(validateSnapshot(buildSnapshot(rich(), TOOL)).ok, true);
  assert.equal(validateSnapshot(null).ok, false);
  const wrong = validateSnapshot({ kind: "something", schemaVersion: 9, objects: { siteLists: "x" } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.problems.length, 11);
  assert.ok(wrong.problems.includes("objects.siteLists must be a list or null."));
  assert.ok(wrong.problems.includes("objects.webControlPolicies is missing."));
});

test("canonical JSON ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("a saved snapshot carries its hash, reads back intact, and shows tampering", async () => {
  const snapshot = buildSnapshot(rich(), TOOL);
  const saved = await saveSnapshot(path.join(root, "data"), snapshot);
  assert.match(saved.file, /^contoso-legal_\d{8}-\d{6}\.json$/);
  assert.equal(saved.hash, objectsHash(snapshot));

  const back = await loadSnapshot(path.join(root, "data"), snapshot.tenant.id, saved.file);
  assert.equal(back.intact, true);
  assert.deepEqual(back.problems, []);
  assert.equal(back.snapshot.integrity.objects, saved.hash);

  const list = await listSnapshots(path.join(root, "data"), snapshot.tenant.id);
  assert.equal(list[0].file, saved.file);

  const file = snapshotPath(path.join(root, "data"), snapshot.tenant.id, saved.file);
  const text = JSON.parse(await readFile(file, "utf8"));
  text.objects.websiteManagement[0].url = "evil.example";
  await writeFile(file, JSON.stringify(text));
  const tampered = await loadSnapshot(path.join(root, "data"), snapshot.tenant.id, saved.file);
  assert.equal(tampered.intact, false);
  assert.match(tampered.problems.join(" "), /integrity hash does not match/);

  const audit = await readFile(path.join(root, "data", "audit.log"), "utf8");
  assert.match(audit, /"action":"save-snapshot"/);
});

test("snapshot paths refuse anything outside the tenant folder", () => {
  assert.throws(() => snapshotPath("/tmp/data", "00000000-0000-4000-a000-000000000001", "../../.env"));
  assert.throws(() => snapshotPath("/tmp/data", "../etc", "contoso_20261013-115300.json"));
});
