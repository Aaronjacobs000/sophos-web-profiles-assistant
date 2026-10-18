// An in-memory tenant for the service tests (v0.3.20 on), and the records a
// pilot needs on file. It answers like the Sophos client the services use:
// a refusal is an "Sophos API error <status>" error, and a write that gets no
// clear answer is an UnclearWriteError. Placeholder names only.

import { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initState } from "../backend/dist/state.js";
import { UnclearWriteError } from "../backend/dist/sophos/client/sophos-client.js";
import { runReadiness } from "../backend/dist/services/readiness.js";
import { device, wcPolicy } from "./fixtures.mjs";

export const T = "00000000-0000-4000-a000-000000000001";
export const TOOL = { name: "web-profiles-assistant", version: "0.3.20" };
export const UNAVAILABLE = "Sophos API error 503: ServiceUnavailable";
export const UNCLEAR = "Sophos API error 500: InternalServerError";

// Every folder dataDirFor makes goes once the test file's tests are done, so a run leaves nothing in the temp directory.
const made = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

export async function dataDirFor(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `wpa-v0320-${name}-`));
  made.push(dir);
  await initState(dir, TOOL.version);
  return path.join(dir, "data");
}

/**
 * refuse(method, pattern, status, when): matching calls answer with an error, and nothing changes.
 * unclear(method, pattern, when): a matching write is made, then answered 500 (an UnclearWriteError).
 * ignore(method, pattern, when): a matching write is answered 200 but changes nothing.
 * Each holds while when() does (always, by default). Every call is kept in calls.
 */
export class Tenant {
  constructor() {
    this.calls = [];
    this.rules = [];
    this.policies = new Map();
    this.profiles = new Map();
    this.lists = new Map();
    this.localSites = new Map();
    this.endpoints = [];
    this.writes = 0;
  }
  refuse(method, pattern, status = 503, when = () => true) {
    this.rules.push({ kind: "refuse", method, pattern, status, when });
  }
  unclear(method, pattern, when = () => true) {
    this.rules.push({ kind: "unclear", method, pattern, when });
  }
  ignore(method, pattern, when = () => true) {
    this.rules.push({ kind: "ignore", method, pattern, when });
  }
  err(status, msg) {
    return new Error(`Sophos API error ${status}: ${msg ?? (status === 404 ? "NotFound" : status === 503 ? "ServiceUnavailable" : status === 409 ? "Conflict" : "Forbidden")}`);
  }
  async tenantRequest(tenantId, p, o = {}) {
    const m = o.method ?? "GET";
    this.calls.push(`${m} ${p}`);
    const hit = (kind) => this.rules.find((r) => r.kind === kind && r.method === m && r.pattern.test(p) && r.when());
    const refused = hit("refuse");
    if (refused) throw this.err(refused.status);
    if (m !== "GET") this.writes++;
    const ignored = hit("ignore");
    const unclear = hit("unclear");
    const out = ignored ? {} : await this.answer(m, p, o.body, o.params);
    if (unclear) throw new UnclearWriteError(UNCLEAR, m, 500);
    return out;
  }
  async answer(m, p, body, params) {
    let x;
    if (p === "/endpoint/v1/endpoints") return { items: this.endpoints, pages: {} };
    if (p === "/endpoint/v1/policies") {
      if (m === "GET") return { items: [...this.policies.values()].filter((y) => y.type === params?.policyType), pages: { total: 1 } };
      const id = randomUUID();
      this.policies.set(id, { ...structuredClone(body), id, priority: 1 });
      return structuredClone(this.policies.get(id));
    }
    if ((x = /^\/endpoint\/v1\/policies\/([^/]+)$/.exec(p))) {
      const pol = this.policies.get(x[1]);
      if (!pol) throw this.err(404);
      if (m === "GET") return structuredClone(pol);
      if (m === "PATCH") {
        if (body.appliesTo) pol.appliesTo = structuredClone(body.appliesTo);
        if (body.enabled !== undefined) pol.enabled = body.enabled;
        for (const [k, v] of Object.entries(body.settings ?? {})) pol.settings[k] = { value: structuredClone(v.value) };
        return structuredClone(pol);
      }
      if (m === "DELETE") return this.policies.delete(pol.id), {};
    }
    if (p === "/web-filters/v1/profiles") {
      if (m === "GET") return { items: [...this.profiles.values()], pages: { total: 1 } };
      const id = randomUUID();
      this.profiles.set(id, { ...structuredClone(body), id });
      return structuredClone(this.profiles.get(id));
    }
    if ((x = /^\/web-filters\/v1\/profiles\/([^/]+)$/.exec(p))) {
      const prof = this.profiles.get(x[1]);
      if (!prof) throw this.err(404);
      if (m === "GET") return structuredClone(prof);
      if (m === "PUT") return this.profiles.set(prof.id, { ...structuredClone(body), id: prof.id }), structuredClone(this.profiles.get(prof.id));
      if (m === "DELETE") {
        if ([...this.policies.values()].some((pol) => pol.settings?.["endpoint.web-control.web-profile-id"]?.value === prof.id)) throw this.err(409);
        return this.profiles.delete(prof.id), {};
      }
    }
    if (p === "/web-filters/v1/site-lists") {
      if (m === "GET") return { items: [...this.lists.values()].map(({ sites, ...l }) => ({ ...l, numberOfSites: sites.length })), pages: { total: 1 } };
      const id = randomUUID();
      this.lists.set(id, { id, name: body.name, description: body.description, sites: body.sites.map((s) => ({ id: randomUUID(), site: s })) });
      return { id, name: body.name, sites: body.sites };
    }
    if ((x = /^\/web-filters\/v1\/site-lists\/([^/]+)(\/sites)?(?:\/([^/]+))?$/.exec(p))) {
      const list = this.lists.get(x[1]);
      if (!list) throw this.err(404);
      if (!x[2]) {
        if (m === "GET") return { id: list.id, name: list.name, sites: list.sites.map((s) => s.site) };
        if (m === "DELETE") {
          if ([...this.profiles.values()].some((pr) => (pr.siteListActions ?? []).some((a) => a.id === list.id))) throw this.err(409, "Conflict - in use");
          return this.lists.delete(list.id), {};
        }
      } else if (!x[3]) {
        if (m === "GET") return { items: structuredClone(list.sites), pages: { total: 1 } };
        if (m === "POST") {
          const s = { id: randomUUID(), site: body.site.toLowerCase() };
          list.sites.push(s);
          return s;
        }
      } else if (m === "DELETE") {
        if (!list.sites.some((s) => s.id === x[3])) throw this.err(404);
        list.sites = list.sites.filter((s) => s.id !== x[3]);
        return {};
      }
    }
    if (p === "/endpoint/v1/settings/web-control/local-sites") {
      if (m === "GET") return { items: [...this.localSites.values()].map((y) => structuredClone(y)), pages: { total: 1 } };
      const id = randomUUID();
      this.localSites.set(id, { id, ...structuredClone(body) });
      return { id, ...body };
    }
    if ((x = /^\/endpoint\/v1\/settings\/web-control\/local-sites\/([^/]+)$/.exec(p))) {
      const s = this.localSites.get(x[1]);
      if (!s) throw this.err(404);
      if (m === "GET") return structuredClone(s);
      if (m === "PATCH") return Object.assign(s, structuredClone(body)), structuredClone(s);
      if (m === "DELETE") return this.localSites.delete(s.id), {};
    }
    if (m !== "GET") throw new Error(`tenant: no route for ${m} ${p}`);
    return { items: [], pages: { total: 1 } };
  }
}

export const ctxOf = (tenant) => ({ tenantId: T, client: tenant, summary: { displayName: "Example Tenant", region: "us01", apiHost: "https://api-us01.central.sophos.com", credentialType: "tenant" } });
const step = (order, kind, name, id) => ({ order, kind, key: kind === "policy" ? "pilot" : kind, name, method: "POST", path: "", summary: "", body: {}, status: "created", id, readBack: "matches" });

/** A built pilot in the tenant and on file: a site list, a profile that uses it, and the pilot policy on w1. */
export function seedPilot(tenant, dataDir) {
  const listId = randomUUID();
  tenant.lists.set(listId, { id: listId, name: "Example Block", sites: [{ id: randomUUID(), site: "blocked.example.com" }] });
  const profileId = randomUUID();
  tenant.profiles.set(profileId, { id: profileId, name: "Example profile", filterByCategory: false, filterBySiteList: true, siteListActions: [{ id: listId, action: "block", priority: 1 }] });
  const policyId = randomUUID();
  tenant.policies.set(policyId, wcPolicy({ id: policyId, name: "WF pilot: Example profile", priority: 1, enabled: false, appliesTo: { endpoints: ["w1"], endpointGroups: [] }, settings: { "endpoint.web-control.web-profile-id": { value: profileId } } }));
  tenant.endpoints = [device("w1", "windows", "2026.2.2.1.0"), device("w2", "windows", "2026.2.2.1.0"), device("w3", "windows", "2026.2.2.1.0")];
  const build = { id: randomUUID(), tenantId: T, tenantName: "Example Tenant", createdAt: new Date().toISOString(), status: "built", pilot: { profileKey: "profile", name: "WF pilot: Example profile", enabled: false, targets: { endpoints: ["w1"] } }, steps: [step(1, "site-list", "Example Block", listId), step(2, "profile", "Example profile", profileId), step(3, "policy", "WF pilot: Example profile", policyId)], checks: [] };
  mkdirSync(path.join(dataDir, "builds", T), { recursive: true });
  writeFileSync(path.join(dataDir, "builds", T, `${build.id}.json`), JSON.stringify(build));
  return { listId, profileId, policyId, build };
}

/** A tenant with a classic policy that uses one tag, two entries with it, and a rollback snapshot. */
export async function retireTenant(dataDir) {
  const tenant = new Tenant();
  const pol = wcPolicy({ id: randomUUID(), name: "Sales", settings: { "endpoint.web-control.tags.settings": { value: [{ tag: "old", action: "allow" }, { tag: "keep", action: "block" }] } } });
  tenant.policies.set(pol.id, pol);
  for (const [url, tags] of [["a.example.com", ["old"]], ["b.example.com", ["old", "keep"]]]) {
    const id = randomUUID();
    tenant.localSites.set(id, { id, url, tags });
  }
  await runReadiness(dataDir, tenant, { id: T, name: "Example Tenant", region: "us01", apiHost: "x", credentialType: "tenant" }, TOOL);
  return { tenant, pol };
}

/** A classic policy with a tag and an entry for it, so the design has a site list, a profile and the pilot. */
export function classicTenant() {
  const tenant = new Tenant();
  const pol = wcPolicy({ id: randomUUID(), name: "Sales", priority: 1, settings: { "endpoint.web-control.tags.settings": { value: [{ tag: "staff", action: "block" }] } } });
  tenant.policies.set(pol.id, pol);
  const id = randomUUID();
  tenant.localSites.set(id, { id, url: "blocked.example.com", tags: ["staff"] });
  tenant.endpoints = [device("w1", "windows", "2026.2.2.1.0")];
  return tenant;
}

/** True from the next write on: calls refused with this hold only once Sophos has accepted a write. */
export const afterWrite = (tenant, from = tenant.writes) => () => tenant.writes > from;
