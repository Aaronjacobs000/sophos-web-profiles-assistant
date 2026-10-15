// Drop 3 services against an in-memory fake of the Sophos APIs: the SIEM
// collector, the narrow Allow and its undo, promotion waves, and retiring
// tags with a restore. The live runs are in "Build report - drop 3.md".

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initState } from "../backend/dist/state.js";
import { setReadBackDelays } from "../backend/dist/services/write-check.js";
import { collect, readEvents, importEvents, storeSummary } from "../backend/dist/services/siem-store.js";
import { addAllow, planAllow, undoAllow, loadPilotRecord } from "../backend/dist/services/pilot-service.js";
import { moveWave, promotionView, setPilotEnabled, undoWave } from "../backend/dist/services/promote-service.js";
import { previewRetire, retire, restoreRetire } from "../backend/dist/services/retire-service.js";
import { designFor, dryRun, execute, getBuild, rollback } from "../backend/dist/services/build-service.js";
import { device, wcPolicy } from "./fixtures.mjs";

const T = "00000000-0000-4000-a000-000000000001";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/siem-webcontrol-events.json", import.meta.url), "utf8"));
let dataDir;

class FakeSophos {
  constructor() {
    this.calls = [];
    this.policies = new Map();
    this.profiles = new Map();
    this.lists = new Map();
    this.localSites = new Map();
    this.endpoints = [];
    this.siemPages = [];
    this.groups = [];
  }
  err(status, msg = "error") {
    return new Error(`Sophos API error ${status}: ${msg}`);
  }
  async tenantRequest(tenantId, p, o = {}) {
    const m = o.method ?? "GET";
    this.calls.push(`${m} ${p}`);
    const body = o.body;
    let r;
    if ((r = /^\/siem\/v1\/events$/.exec(p))) {
      const page = o.params.cursor ? this.siemPages.find((x) => x.cursorIn === o.params.cursor) : this.siemPages.find((x) => !x.cursorIn);
      if (!page) throw this.err(400, "bad cursor");
      return page.res;
    }
    if (p === "/endpoint/v1/endpoints") return { items: this.endpoints, pages: {} };
    if (p === "/endpoint/v1/endpoint-groups") return { items: this.groups, pages: { total: 1 } };
    if (p === "/endpoint/v1/policies" && m === "GET") return { items: [...this.policies.values()].filter((x) => x.type === o.params.policyType), pages: { total: 1 } };
    if ((r = /^\/endpoint\/v1\/policies\/([^/]+)$/.exec(p))) {
      const pol = this.policies.get(decodeURIComponent(r[1]));
      if (!pol) throw this.err(404);
      if (m === "GET") return structuredClone(pol);
      if (m === "PATCH") {
        if (body.appliesTo) pol.appliesTo = structuredClone(body.appliesTo);
        if (body.enabled !== undefined) pol.enabled = body.enabled;
        for (const [k, v] of Object.entries(body.settings ?? {})) pol.settings[k] = { value: structuredClone(v.value) };
        return structuredClone(pol);
      }
    }
    if ((r = /^\/web-filters\/v1\/profiles\/([^/]+)$/.exec(p))) {
      const prof = this.profiles.get(decodeURIComponent(r[1]));
      if (!prof) throw this.err(404);
      if (m === "GET") return structuredClone(prof);
      if (m === "PUT") {
        if (body.preset && body.categoryGroupActions) throw this.err(400, "preset with overrides");
        if (body.consumers || body.id) throw this.err(400, "read-only field sent");
        const next = { ...structuredClone(body), id: prof.id, consumers: prof.consumers };
        this.profiles.set(prof.id, next);
        return structuredClone(next);
      }
    }
    if (p === "/web-filters/v1/site-lists") {
      if (m === "GET") return { items: [...this.lists.values()].map(({ sites, ...l }) => ({ ...l, numberOfSites: sites.length })), pages: { total: 1 } };
      const id = randomUUID();
      this.lists.set(id, { id, name: body.name, description: body.description, sites: body.sites.map((s) => ({ id: randomUUID(), site: s })) });
      return { id, name: body.name, sites: body.sites };
    }
    if ((r = /^\/web-filters\/v1\/site-lists\/([^/]+)(\/sites)?(?:\/([^/]+))?$/.exec(p))) {
      const list = this.lists.get(decodeURIComponent(r[1]));
      if (!list) throw this.err(404);
      if (!r[2]) {
        if (m === "GET") return { id: list.id, name: list.name, sites: list.sites.map((s) => s.site) };
        if (m === "DELETE") {
          if ([...this.profiles.values()].some((pr) => (pr.siteListActions ?? []).some((a) => a.id === list.id))) throw this.err(409, "in use");
          this.lists.delete(list.id);
          return {};
        }
      } else if (!r[3]) {
        if (m === "GET") return { items: structuredClone(list.sites), pages: { total: 1 } };
        if (m === "POST") {
          const s = { id: randomUUID(), site: body.site.toLowerCase() };
          list.sites.push(s);
          return s;
        }
      } else if (m === "DELETE") {
        list.sites = list.sites.filter((s) => s.id !== r[3]);
        return {};
      }
    }
    if (p === "/endpoint/v1/settings/web-control/local-sites") {
      if (m === "GET") return { items: [...this.localSites.values()].map((x) => structuredClone(x)), pages: { total: 1 } };
      const id = randomUUID();
      this.localSites.set(id, { id, ...structuredClone(body) });
      return { id, ...body };
    }
    if ((r = /^\/endpoint\/v1\/settings\/web-control\/local-sites\/([^/]+)$/.exec(p))) {
      const s = this.localSites.get(decodeURIComponent(r[1]));
      if (!s) throw this.err(404);
      if (m === "GET") return structuredClone(s);
      if (m === "PATCH") {
        Object.assign(s, structuredClone(body));
        return structuredClone(s);
      }
      if (m === "DELETE") {
        this.localSites.delete(s.id);
        return {};
      }
    }
    if (m !== "GET") throw new Error(`fake: no route for ${m} ${p}`);
    return { items: [], pages: { total: 1 } };
  }
}

function ctxOf(fake) {
  return { tenantId: T, client: fake, summary: { displayName: "Test tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" } };
}

function seedPilot(fake, { users = false } = {}) {
  const listId = randomUUID();
  fake.lists.set(listId, { id: listId, name: "Sales Block", sites: [{ id: randomUUID(), site: "bad.example.com" }] });
  const profileId = randomUUID();
  fake.profiles.set(profileId, { id: profileId, name: "Sales profile", filterByCategory: true, preset: "keep-it-clean", categoryGroupActions: [{ name: "business", action: "allow" }], filterBySiteList: true, siteListActions: [{ id: listId, action: "block", priority: 31 }], consumers: [], updatedAt: "x" });
  const policyId = randomUUID();
  fake.policies.set(policyId, wcPolicy({ id: policyId, name: "WF pilot: Sales profile", priority: 1, enabled: false, appliesTo: users ? { users: [], userGroups: ["g1"] } : { endpoints: ["w1"], endpointGroups: [] } }));
  const build = {
    id: randomUUID(),
    tenantId: T,
    tenantName: "Test tenant",
    createdAt: new Date().toISOString(),
    status: "built",
    pilot: { profileKey: "k", name: "WF pilot: Sales profile", enabled: false, targets: { endpoints: ["w1"] } },
    steps: [
      { order: 1, kind: "site-list", key: "l", name: "Sales Block", method: "POST", path: "", summary: "", body: {}, status: "created", id: listId },
      { order: 2, kind: "profile", key: "k", name: "Sales profile", method: "POST", path: "", summary: "", body: {}, status: "created", id: profileId },
      { order: 3, kind: "policy", key: "pilot", name: "WF pilot: Sales profile", method: "POST", path: "", summary: "", body: {}, status: "created", id: policyId },
    ],
    checks: [],
  };
  const dir = path.join(dataDir, "builds", T);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${build.id}.json`), JSON.stringify(build));
  return { listId, profileId, policyId, buildId: build.id };
}

before(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-d3-"));
  await initState(root, "0.3.0");
  dataDir = path.join(root, "data");
  setReadBackDelays([0, 0]);
});

test("collect pages through the SIEM API, keeps web events once, and resumes from the cursor", async () => {
  const fake = new FakeSophos();
  const web = FIXTURE.items;
  fake.siemPages = [
    { res: { items: web.slice(0, 10), has_more: true, next_cursor: "c1" } },
    { cursorIn: "c1", res: { items: web.slice(10), has_more: false, next_cursor: "c2" } },
    { cursorIn: "c2", res: { items: web.slice(15), has_more: false, next_cursor: "c3" } },
  ];
  const t0 = Date.parse("2026-10-13T06:00:00Z");
  const run = await collect(dataDir, fake, T, t0);
  assert.equal(run.ok, true);
  assert.equal(run.pages, 2);
  assert.equal(run.fetched, 19);
  assert.equal(run.web, 18);
  assert.equal(run.added, 18);
  assert.equal(run.started, "from-date");
  assert.match(fake.calls[0], /^GET \/siem\/v1\/events$/);
  const again = await collect(dataDir, fake, T, t0 + 3600_000);
  assert.equal(again.started, "cursor", "an hour later it resumes from the cursor");
  assert.equal(again.added, 0, "events already stored aren't stored twice");
  assert.equal((await readEvents(dataDir, T)).length, 18);
  const late = await collect(dataDir, fake, T, t0 + 30 * 3600_000);
  assert.equal(late.started, "from-date", "a day-old cursor isn't used");
  assert.match(late.gap ?? "", /may be missing/);
  const imp = await importEvents(dataDir, T, { items: FIXTURE.items }, "fixture.json");
  assert.equal(imp.added, 0);
  const sum = await storeSummary(dataDir, T);
  assert.equal(sum.total, 18);
  assert.deepEqual(sum.days.map((d) => d.day), ["2026-10-12", "2026-10-13"]);
});

test("collect never writes: the SIEM client is read-only", async () => {
  const fake = new FakeSophos();
  fake.siemPages = [{ res: { items: [], has_more: false } }];
  await collect(dataDir, fake, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.ok(fake.calls.every((c) => c.startsWith("GET ")));
});

test("narrow Allow: the first creates and links a list with the top priority; undo removes the site, then the list", async () => {
  const fake = new FakeSophos();
  const ids = seedPilot(fake);
  const ctx = ctxOf(fake);
  const plan = await planAllow(dataDir, ctx, "https://updates-cdn.example.com/setup.exe");
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.steps.map((s) => s.op), ["create-list", "link-list"]);
  assert.equal(plan.steps[1].priority, 32, "above the block list's 31");
  assert.ok(fake.calls.every((c) => c.startsWith("GET ")), "planning only reads");

  const first = await addAllow(dataDir, ctx, "https://updates-cdn.example.com/setup.exe");
  assert.equal(first.entry.status, "added");
  assert.equal(first.entry.site, "updates-cdn.example.com");
  assert.match(first.entry.readBack, /profile links it as allow/);
  const prof = fake.profiles.get(ids.profileId);
  assert.ok(!prof.categoryGroupActions, "a preset profile is sent without overrides");
  assert.deepEqual(prof.siteListActions.map((a) => a.action), ["block", "allow"]);
  const build = await getBuild(dataDir, T, ids.buildId);
  assert.ok(build.steps.some((s) => s.id === first.entry.listId && s.status === "created"), "the build owns the list, so a rollback deletes it");

  const second = await addAllow(dataDir, ctx, "cdn2.example.com");
  assert.equal(second.plan.steps[0].op, "add-site");
  assert.equal(fake.lists.get(first.entry.listId).sites.length, 2);
  await assert.rejects(addAllow(dataDir, ctx, "cdn2.example.com"), /already allowed/);
  assert.match((await planAllow(dataDir, ctx, "*.example.com")).problems[0], /isn't a single host/);
  assert.match((await planAllow(dataDir, ctx, "bad.example.com")).notes.join(" "), /also in "Sales Block"/);

  const u2 = await undoAllow(dataDir, ctx, second.entry.id);
  assert.equal(u2.status, "undone");
  assert.equal(fake.lists.get(first.entry.listId).sites.length, 1);
  const u1 = await undoAllow(dataDir, ctx, first.entry.id);
  assert.equal(u1.status, "undone", u1.error);
  assert.ok(!fake.lists.has(first.entry.listId), "the list is deleted");
  assert.deepEqual(fake.profiles.get(ids.profileId).siteListActions.map((a) => a.id), [ids.listId], "the profile is back to its own lists");
  assert.equal((await getBuild(dataDir, T, ids.buildId)).steps.find((s) => s.id === first.entry.listId).status, "deleted");
  assert.equal((await loadPilotRecord(dataDir, T)).allows.filter((a) => a.status === "undone").length, 2);
});

test("promotion waves add eligible devices to the pilot in the device shape, read back, and undo", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-d3w-"));
  await initState(root, "0.3.0");
  dataDir = path.join(root, "data");
  const fake = new FakeSophos();
  const ids = seedPilot(fake);
  fake.endpoints = [device("w1", "windows", "2026.2.2.1.0"), device("w2", "windows", "2026.2.2.1.0"), device("w3", "windows", "2026.1.0.1"), device("old", "windows", "2025.2.3.8.0")];
  const ctx = ctxOf(fake);
  const view = await promotionView(dataDir, ctx, 1);
  assert.equal(view.mode, "devices");
  assert.deepEqual(view.plan.waves.map((w) => w.devices[0].id), ["w2", "w3"]);
  const dry = await moveWave(dataDir, ctx, ["w2", "old", "w1"], true);
  assert.equal(dry.problems.length, 2, "old can't use profiles and w1 is already on");
  await assert.rejects(moveWave(dataDir, ctx, ["old"], false));
  const w = await moveWave(dataDir, ctx, ["w2"], false);
  assert.equal(w.status, "moved", w.error);
  assert.deepEqual(fake.policies.get(ids.policyId).appliesTo, { endpoints: ["w1", "w2"], endpointGroups: [] });
  const w2 = await moveWave(dataDir, ctx, ["w3"], false);
  assert.equal(w2.status, "moved");
  await assert.rejects(undoWave(dataDir, ctx, w.id), /later waves first/);
  assert.equal((await undoWave(dataDir, ctx, w2.id)).status, "undone");
  assert.equal((await undoWave(dataDir, ctx, w.id)).status, "undone");
  assert.deepEqual(fake.policies.get(ids.policyId).appliesTo, { endpoints: ["w1"], endpointGroups: [] });
  assert.deepEqual(await setPilotEnabled(dataDir, ctx, true), { enabled: true, readBack: "matches" });
  assert.equal(fake.policies.get(ids.policyId).enabled, true);
});

test("a user pilot can't take device waves", async () => {
  const fake = new FakeSophos();
  seedPilot(fake, { users: true });
  fake.endpoints = [device("w2", "windows", "2026.2.2.1.0")];
  const view = await promotionView(dataDir, ctxOf(fake), 25);
  assert.equal(view.mode, "users");
  assert.match(view.problem, /can't hold users and devices together/);
});

test("retire: policies lose the tag first, entries go, and restore puts every one back", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-d3r-"));
  await initState(root, "0.3.0");
  dataDir = path.join(root, "data");
  const fake = new FakeSophos();
  const pol = wcPolicy({ id: randomUUID(), name: "Sales", settings: { "endpoint.web-control.tags.settings": { value: [{ tag: "old", action: "allow" }, { tag: "keep", action: "block" }] } } });
  fake.policies.set(pol.id, pol);
  for (const [url, tags] of [["a.example.com", ["old"]], ["b.example.com", ["old", "keep"]], ["c.example.com", ["keep"]]]) {
    const id = randomUUID();
    fake.localSites.set(id, { id, url, tags, comment: `entry ${url}` });
  }
  const ctx = ctxOf(fake);
  const tool = { name: "web-profiles-assistant", version: "0.3.0" };
  await assert.rejects(retire(dataDir, ctx, ["old"], false, tool), /snapshot/i, "no snapshot yet");
  // A snapshot exists once a readiness check has run.
  const { runReadiness } = await import("../backend/dist/services/readiness.js");
  await runReadiness(dataDir, fake, { id: T, name: "Test tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, tool);
  const preview = await previewRetire(dataDir, ctx, ["old"]);
  assert.deepEqual(preview.steps.map((s) => s.op), ["policy-tags", "delete-entry", "patch-entry"]);
  const order = [];
  const orig = fake.tenantRequest.bind(fake);
  fake.tenantRequest = async (t, p, o = {}) => {
    if ((o.method ?? "GET") !== "GET") order.push(`${o.method} ${p.split("/").slice(-2, -1)[0]}`);
    return orig(t, p, o);
  };
  const rec = await retire(dataDir, ctx, ["old"], true, tool);
  assert.equal(rec.status, "retired", JSON.stringify(rec.steps));
  assert.deepEqual(order, ["PATCH policies", "DELETE local-sites", "PATCH local-sites"]);
  assert.deepEqual(fake.policies.get(pol.id).settings["endpoint.web-control.tags.settings"].value, [{ tag: "keep", action: "block" }]);
  assert.deepEqual([...fake.localSites.values()].map((s) => `${s.url}:${s.tags.join("+")}`).sort(), ["b.example.com:keep", "c.example.com:keep"]);

  order.length = 0;
  const back = await restoreRetire(dataDir, ctx, rec.id);
  assert.equal(back.status, "restored", JSON.stringify(back.steps));
  assert.deepEqual(order, ["POST web-control", "PATCH local-sites", "PATCH policies"], "entries before policies");
  assert.deepEqual([...fake.localSites.values()].map((s) => `${s.url}:${s.tags.join("+")}:${s.comment}`).sort(), ["a.example.com:old:entry a.example.com", "b.example.com:old+keep:entry b.example.com", "c.example.com:keep:entry c.example.com"]);
  assert.deepEqual(fake.policies.get(pol.id).settings["endpoint.web-control.tags.settings"].value, [{ tag: "old", action: "allow" }, { tag: "keep", action: "block" }]);
});

test("the build, waves and Allow treat a server on the computer pilot: refused before any write, or flagged", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-d3s-"));
  await initState(root, "0.3.1");
  dataDir = path.join(root, "data");
  const fake = new FakeSophos();
  const base = wcPolicy({ id: randomUUID(), name: "Base Policy", priority: 0, settings: { "endpoint.web-control.categories.16.action": { value: "block" } } });
  fake.policies.set(base.id, base);
  const srv = device("srv", "windows", "2026.2.2.1.0", { hostname: "DC01", type: "server", os: { platform: "windows", isServer: true } });
  fake.endpoints = [device("w1", "windows", "2026.2.2.1.0"), srv];
  fake.groups = [{ id: "sg", name: "Servers", type: "server" }, { id: "cg", name: "Laptops", type: "computer" }];
  const ctx = ctxOf(fake);
  const { design } = await designFor(dataDir, ctx);
  const profileKey = design.profiles[0].key;
  const one = await dryRun(dataDir, ctx, { profileKey, enabled: false, targets: { endpoints: ["srv"], endpointGroups: [] } });
  assert.ok(one.checks.some((c) => !c.ok && /^DC01 is a server device/.test(c.text)), JSON.stringify(one.checks));
  const grp = await dryRun(dataDir, ctx, { profileKey, enabled: false, targets: { endpoints: [], endpointGroups: ["sg", "cg"] } });
  assert.ok(grp.checks.some((c) => !c.ok && /^Servers is a server device group/.test(c.text)));
  assert.ok(!grp.checks.some((c) => /Laptops/.test(c.text)));
  const fine = await dryRun(dataDir, ctx, { profileKey, enabled: false, targets: { endpoints: ["w1"], endpointGroups: [] } });
  assert.ok(fine.checks.every((c) => c.ok), JSON.stringify(fine.checks));
  const ex = await execute(dataDir, ctx, { profileKey, enabled: false, targets: { endpoints: ["srv"], endpointGroups: [] } }, { name: "t", version: "0.3.1" });
  assert.equal(ex.status, "failed");
  assert.ok(fake.calls.every((c) => c.startsWith("GET ")), "nothing was written");

  const ids = seedPilot(fake);
  const wave = await moveWave(dataDir, ctx, ["srv"], true);
  assert.match(wave.problems.join(" "), /DC01 is a server device/);
  await assert.rejects(moveWave(dataDir, ctx, ["srv"], false), /server/);
  assert.ok(fake.calls.every((c) => c.startsWith("GET ")), "the wave wasn't sent");
  fake.policies.get(ids.policyId).appliesTo = { endpoints: ["w1", "srv"], endpointGroups: [] };
  const plan = await planAllow(dataDir, ctx, "cdn.example.com");
  assert.match(plan.notes.join(" "), /assigned to a server \(DC01\)/);
});

test("narrow Allow refuses a whole top-level domain, a public suffix or a shared platform", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-d3b-"));
  await initState(root, "0.3.7");
  dataDir = path.join(root, "data");
  const fake = new FakeSophos();
  seedPilot(fake);
  const ctx = ctxOf(fake);
  for (const host of ["com", "http://com/", "co.uk", "blogspot.com"]) {
    const plan = await planAllow(dataDir, ctx, host);
    assert.equal(plan.steps.length, 0, host);
    assert.match(plan.problems.join(" "), /a narrow Allow takes one host/, host);
    await assert.rejects(addAllow(dataDir, ctx, host), /narrow Allow takes one host/, host);
  }
  assert.deepEqual((await planAllow(dataDir, ctx, "myblog.blogspot.com")).problems, [], "one blog is one host");
  assert.ok(fake.calls.every((c) => c.startsWith("GET ")), "nothing was written");
});

test("rollback restores Website Management only from a snapshot whose hash still matches", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpa-d3k-"));
  await initState(root, "0.3.7");
  dataDir = path.join(root, "data");
  const fake = new FakeSophos();
  const id = randomUUID();
  fake.localSites.set(id, { id, url: "kept.example.com", tags: ["staff"] });
  const tool = { name: "web-profiles-assistant", version: "0.3.7" };
  const { runReadiness } = await import("../backend/dist/services/readiness.js");
  const r = await runReadiness(dataDir, fake, { id: T, name: "Test tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, tool);
  const snapFile = path.join(dataDir, "snapshots", T, r.snapshot.file);
  const record = (buildId) => {
    const b = { id: buildId, tenantId: T, tenantName: "Test tenant", createdAt: new Date().toISOString(), status: "built", snapshotFile: r.snapshot.file, pilot: { profileKey: "k", name: "p", enabled: false, targets: {} }, steps: [], checks: [] };
    mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
    writeFileSync(path.join(dataDir, "builds", T, `${buildId}.json`), JSON.stringify(b));
  };
  const ctx = ctxOf(fake);

  // Intact: an entry deleted since the snapshot is put back.
  fake.localSites.clear();
  const good = randomUUID();
  record(good);
  const plan = await rollback(dataDir, ctx, good, { dryRun: true });
  assert.deepEqual(plan.restorePlan.map((s) => `${s.op} ${s.url}`), ["create kept.example.com"]);
  assert.equal(plan.restoreRefused, undefined);

  // Edited after it was saved: nothing is restored from it, and the rollback says so.
  const snap = JSON.parse(readFileSync(snapFile, "utf8"));
  snap.objects.websiteManagement.push({ id: "x", url: "*.added-by-hand.example", tags: ["staff"] });
  writeFileSync(snapFile, JSON.stringify(snap));
  const bad = randomUUID();
  record(bad);
  const dry = await rollback(dataDir, ctx, bad, { dryRun: true });
  assert.deepEqual(dry.restorePlan, []);
  assert.match(dry.restoreRefused, /changed after it was saved/);
  const done = await rollback(dataDir, ctx, bad, { dryRun: false });
  assert.equal(done.status, "rollback-partial");
  assert.ok(done.rollback.steps.some((s) => s.kind === "website-management" && s.status === "failed" && /changed after it was saved/.test(s.error)));
  assert.equal(fake.localSites.size, 0, "no entry was created from the edited snapshot");
  assert.ok(fake.calls.every((c) => c.startsWith("GET ")), "nothing was written");
});
