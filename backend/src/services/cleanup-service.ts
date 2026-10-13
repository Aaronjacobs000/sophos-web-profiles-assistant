/**
 * Runs the clean-up engine for a tenant (Website Management read over the
 * API, compared with the profile each policy will get) or for the standalone
 * site list cleaner (pasted lines or a CSV, compared with a preset). DNS and
 * SophosLabs Intelix lookups are optional; results and the admin's decisions
 * are kept in data/cleanup/.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { classify, summarise, type CleanupInput, type CleanupResult, type CleanupTarget, type Verdict } from "../domain/cleanup.js";
import { catalogFrom, classicOverrideAction, type Catalog } from "../domain/categories.js";
import { buildDesign } from "../domain/design.js";
import { isBasePolicy, settingValue } from "../domain/inventory.js";
import { parseSite } from "../domain/sites.js";
import { worthALookup, type IntelixClient, type IntelixLookup } from "../domain/intelix.js";
import type { FilterAction } from "../domain/categories-data.js";
import { ReadOnlyApi, type TenantApi } from "../sophos/api/requester.js";
import { listLocalSites, type LocalSite } from "../sophos/api/web-control.js";
import { listPolicies, type Policy } from "../sophos/api/policies.js";
import { getProfileMetadata } from "../sophos/api/web-filters.js";
import { checkDns } from "./dns.js";
import { mapPool } from "./pool.js";
import { readText, saveFile } from "./safe-files.js";
import { log } from "../log.js";

const SECTION = "cleanup";

export interface CleanupRun {
  scope: string;
  tenantId: string | null;
  startedAt: string;
  finishedAt: string | null;
  running: boolean;
  total: number;
  done: number;
  options: { dns: boolean; intelix: boolean; preset?: string; defaultAction?: FilterAction };
  intelixLookups: number;
  intelixError?: string;
  results: CleanupResult[];
  decisions: Record<string, { verdict: Verdict; action?: FilterAction }>;
  error?: string;
}

const runs = new Map<string, CleanupRun>();

function runPath(dataDir: string, scope: string): string {
  if (!/^[a-z0-9-]{3,80}$/i.test(scope)) throw new Error("Bad clean-up scope.");
  return path.join(dataDir, "cleanup", `${scope}.json`);
}

async function persist(dataDir: string, run: CleanupRun): Promise<void> {
  const file = runPath(dataDir, run.scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await saveFile(file, JSON.stringify(run), { section: SECTION, mode: 0o600 });
}

export async function getRun(dataDir: string, scope: string): Promise<CleanupRun | null> {
  const hit = runs.get(scope);
  if (hit) return hit;
  const text = await readText(runPath(dataDir, scope), SECTION).catch(() => null);
  if (!text) return null;
  const run = JSON.parse(text) as CleanupRun;
  run.running = false;
  runs.set(scope, run);
  return run;
}

/** Applies stored decisions to the results. */
export function withDecisions(run: CleanupRun): CleanupResult[] {
  return run.results.map((r) => (run.decisions[r.id] ? { ...r, decided: run.decisions[r.id] } : { ...r, decided: undefined }));
}

export async function setDecisions(dataDir: string, scope: string, decisions: Record<string, { verdict: Verdict; action?: FilterAction } | null>): Promise<CleanupRun> {
  const run = await getRun(dataDir, scope);
  if (!run) throw new Error("Run the clean-up first.");
  for (const [id, d] of Object.entries(decisions)) {
    if (d === null) delete run.decisions[id];
    else if (["covered", "exception", "remove"].includes(d.verdict)) run.decisions[id] = d;
  }
  await persist(dataDir, run);
  return run;
}

/** Classifies inputs with optional DNS and Intelix lookups, caching each host once. */
export async function classifyInputs(
  inputs: CleanupInput[],
  catalog: Catalog,
  opts: { dns: boolean; intelix: IntelixClient | null; onProgress?: (done: number) => void },
): Promise<{ results: CleanupResult[]; lookups: number; intelixError?: string }> {
  const lookups = new Map<string, Promise<{ lookup?: IntelixLookup; error?: string }>>();
  const dnsCache = new Map<string, ReturnType<typeof checkDns>>();
  let intelixError: string | undefined;
  let done = 0;
  const prepared = await mapPool(inputs, 6, async (input) => {
    const site = parseSite(input.raw);
    let dns;
    if (opts.dns && site.value) {
      const key = site.host;
      if (!dnsCache.has(key)) dnsCache.set(key, checkDns(site));
      dns = await dnsCache.get(key)!;
    }
    let lookup: IntelixLookup | undefined;
    let lookupError: string | undefined;
    // Lookups are billed: skip entries no policy acts on (the clean-up removes them anyway), ranges, and private names.
    const actsSomewhere = input.targets.length > 0 || input.categoryId !== undefined;
    if (opts.intelix && actsSomewhere && worthALookup(site) && dns?.status !== "nxdomain" && !intelixError) {
      const q = site.kind === "url" ? site.value : site.host;
      if (!lookups.has(q)) {
        lookups.set(
          q,
          opts.intelix.lookup(q).then(
            (l) => ({ lookup: l }),
            (err: Error) => {
              if ((err as { status?: number }).status === 400 || (err as { status?: number }).status === 401) intelixError = err.message;
              return { error: err.message };
            },
          ),
        );
      }
      const r = await lookups.get(q)!;
      lookup = r.lookup;
      lookupError = r.error;
    } else if (opts.intelix && intelixError) lookupError = intelixError;
    opts.onProgress?.(++done);
    return { input, dns, lookup, lookupError };
  });
  // Classify in input order so "repeats an earlier entry" is stable.
  const seen = new Set<string>();
  const results = prepared.map((p) => classify(p.input, catalog, { dns: p.dns, lookup: p.lookup, lookupError: p.lookupError, seen }));
  return { results, lookups: opts.intelix?.lookups ?? 0, intelixError };
}

/** The clean-up inputs for a tenant: each Website Management entry, with every enabled policy that acts on its tags. */
export function tenantInputs(catalog: Catalog, policies: Policy[], localSites: LocalSite[]): CleanupInput[] {
  const design = buildDesign(catalog, policies, localSites, null, { date: "", existingProfiles: 0, existingSiteLists: 0 });
  const actionsByPolicy = new Map(design.policies.filter((p) => !p.skipped).map((p) => [p.policyId, p.categoryActions ?? {}]));
  const live = policies.filter((p) => p.enabled !== false || isBasePolicy(p)).filter((p) => actionsByPolicy.has(p.id));
  const baseOf = (p: Policy) => policies.find((b) => b.type === p.type && isBasePolicy(b))?.settings;
  return localSites.map((s) => {
    const targets: CleanupTarget[] = [];
    for (const p of live) {
      const tagSettings = settingValue<Array<{ tag: string; action: string }>>(p, "endpoint.web-control.tags.settings") ?? [];
      for (const t of tagSettings) {
        if ((s.tags ?? []).includes(t.tag) && (t.action === "allow" || t.action === "block" || t.action === "warn")) {
          targets.push({ name: p.name, action: t.action, categoryActions: actionsByPolicy.get(p.id)! });
        }
      }
      // A category override applies in every policy, with that policy's action for the category.
      if (s.categoryId !== undefined) {
        const filtering = settingValue<boolean>(p, "endpoint.web-control.web-filtering.enabled") !== false;
        const o = classicOverrideAction(s.categoryId, (p.settings ?? {}) as never, baseOf(p) as never, filtering);
        if (o.action) targets.push({ name: `${p.name} (category override: ${o.label})`, action: o.action, categoryActions: actionsByPolicy.get(p.id)! });
      }
    }
    return { id: s.id, raw: s.url, tags: s.tags ?? [], comment: s.comment, categoryId: s.categoryId, source: "website-management" as const, targets };
  });
}

/** Starts a tenant clean-up in the background. */
export async function startTenantCleanup(
  dataDir: string,
  client: TenantApi,
  tenantId: string,
  opts: { dns: boolean; intelix: IntelixClient | null },
): Promise<CleanupRun> {
  const existing = runs.get(tenantId);
  if (existing?.running) throw new Error("A clean-up is already running for this tenant.");
  const previous = await getRun(dataDir, tenantId).catch(() => null);
  const api = new ReadOnlyApi(client);
  const [localSites, wc, swc, metadata] = await Promise.all([
    listLocalSites(api, tenantId),
    listPolicies(api, tenantId, "web-control"),
    listPolicies(api, tenantId, "server-web-control"),
    getProfileMetadata(api, tenantId).catch(() => null),
  ]);
  const catalog = catalogFrom(metadata);
  const inputs = tenantInputs(catalog, [...wc, ...swc], localSites);
  const run: CleanupRun = {
    scope: tenantId,
    tenantId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    running: true,
    total: inputs.length,
    done: 0,
    options: { dns: opts.dns, intelix: !!opts.intelix },
    intelixLookups: 0,
    results: [],
    decisions: previous?.decisions ?? {},
  };
  runs.set(tenantId, run);
  void (async () => {
    try {
      const out = await classifyInputs(inputs, catalog, { ...opts, onProgress: (d) => (run.done = d) });
      run.results = out.results;
      run.intelixLookups = out.lookups;
      run.intelixError = out.intelixError;
      // Decisions only carry over for entries that still exist.
      const ids = new Set(out.results.map((r) => r.id));
      run.decisions = Object.fromEntries(Object.entries(run.decisions).filter(([id]) => ids.has(id)));
      log.emit("info", SECTION, `Clean-up: ${JSON.stringify(summarise(withDecisions(run)))}`, { tenant: tenantId });
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      log.emit("error", SECTION, `Clean-up failed: ${run.error}`, { tenant: tenantId });
    }
    run.running = false;
    run.finishedAt = new Date().toISOString();
    await persist(dataDir, run).catch(() => {});
  })();
  return run;
}

/** The standalone cleaner: classifies pasted lines or CSV text against a preset. Kept as scope "cleaner". */
export async function runStandalone(
  dataDir: string,
  inputs: CleanupInput[],
  catalog: Catalog,
  opts: { dns: boolean; intelix: IntelixClient | null; preset: string; defaultAction: FilterAction },
): Promise<CleanupRun> {
  const run: CleanupRun = {
    scope: "cleaner",
    tenantId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    running: true,
    total: inputs.length,
    done: 0,
    options: { dns: opts.dns, intelix: !!opts.intelix, preset: opts.preset, defaultAction: opts.defaultAction },
    intelixLookups: 0,
    results: [],
    decisions: {},
  };
  runs.set("cleaner", run);
  const out = await classifyInputs(inputs, catalog, { dns: opts.dns, intelix: opts.intelix, onProgress: (d) => (run.done = d) });
  run.results = out.results;
  run.intelixLookups = out.lookups;
  run.intelixError = out.intelixError;
  run.running = false;
  run.finishedAt = new Date().toISOString();
  await persist(dataDir, run);
  return run;
}
