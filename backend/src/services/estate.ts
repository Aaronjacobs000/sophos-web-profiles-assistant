/**
 * Partner mode: the readiness check for every tenant a partner or
 * organization credential reaches, a few tenants at a time, in the
 * background. The page polls GET /api/estate for progress. Each tenant gets
 * the same full scorecard and snapshot as a single-tenant run, and the rows
 * are kept in data/estate/<partner id>.json so the view survives a restart.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { runReadiness, type ReadinessResult } from "./readiness.js";
import { mapPool } from "./pool.js";
import { readText, saveFile } from "./safe-files.js";
import { log } from "../log.js";
import type { PartnerContext } from "../sophos/tenant-context.js";
import { parseRegion } from "../sophos/tenant-context.js";

export type RowStatus = "queued" | "reading" | "done" | "error";

export interface EstateRow {
  tenantId: string;
  name: string;
  region: string | null;
  status: RowStatus;
  verdict?: "ready" | "fixes" | "unreadable";
  fix?: number;
  plan?: number;
  eligible?: number;
  inScope?: number;
  percent?: number;
  wmEntries?: number | null;
  webPolicies?: number;
  profiles?: number | null;
  decryption?: "on" | "off" | "partial" | null;
  unread?: number;
  readAt?: string;
  durationMs?: number;
  calls?: number;
  error?: string;
  snapshot?: string | null;
}

export interface EstateRun {
  partnerId: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  concurrency: number;
  running: boolean;
  total: number;
  done: number;
  calls: number;
  rows: EstateRow[];
}

const SECTION = "estate";
let current: EstateRun | null = null;

function estatePath(dataDir: string, partnerId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(partnerId)) throw new Error("Not a partner ID.");
  return path.join(dataDir, "estate", `${partnerId}.json`);
}

export function rowFrom(base: Pick<EstateRow, "tenantId" | "name" | "region">, r: ReadinessResult): EstateRow {
  const s = r.scorecard;
  const live = s.facts.decryption.filter((d) => d.enabled && d.decryption !== null);
  const on = live.filter((d) => d.decryption).length;
  return {
    ...base,
    status: "done",
    verdict: s.verdict,
    fix: s.counts.fix,
    plan: s.counts.plan,
    eligible: s.facts.eligibility?.eligible,
    inScope: s.facts.eligibility?.inScope,
    percent: s.facts.eligibility?.percent,
    wmEntries: s.facts.websiteManagement?.entries ?? null,
    webPolicies: s.facts.policies.length,
    profiles: s.facts.profiles?.count ?? null,
    decryption: live.length === 0 ? null : on === live.length ? "on" : on === 0 ? "off" : "partial",
    unread: s.unread.length,
    readAt: r.readAt,
    durationMs: r.durationMs,
    calls: r.calls,
    snapshot: r.snapshot?.file ?? null,
  };
}

async function persist(dataDir: string, run: EstateRun): Promise<void> {
  try {
    const file = estatePath(dataDir, run.partnerId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await saveFile(file, JSON.stringify(run), { section: SECTION, mode: 0o600 });
  } catch (err) {
    log.emit("warn", SECTION, `Couldn't keep the estate view on disk: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The current or last estate run for this partner, with tenants added or dropped since shown as queued. */
export async function getEstate(dataDir: string, pctx: PartnerContext): Promise<EstateRun> {
  if (!current || current.partnerId !== pctx.identity.id) {
    const text = await readText(estatePath(dataDir, pctx.identity.id), SECTION).catch(() => null);
    current = text ? (JSON.parse(text) as EstateRun) : null;
  }
  const known = new Map((current?.rows ?? []).map((r) => [r.tenantId, r]));
  const rows = pctx.tenants
    .map((t) => known.get(t.id) ?? { tenantId: t.id, name: t.name, region: parseRegion(t.apiHost) ?? t.dataRegion ?? null, status: "queued" as RowStatus })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!current) {
    current = {
      partnerId: pctx.identity.id,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      concurrency: 0,
      running: false,
      total: rows.length,
      done: 0,
      calls: 0,
      rows,
    };
  } else if (!current.running) {
    current.rows = rows;
    current.total = rows.length;
  }
  return current;
}

/**
 * Starts a scan of the given tenants (all when none are named) and returns at
 * once. Refuses while one is running.
 */
export async function startEstateScan(
  dataDir: string,
  pctx: PartnerContext,
  tool: { name: string; version: string },
  concurrency: number,
  tenantIds?: string[],
): Promise<EstateRun> {
  const run = await getEstate(dataDir, pctx);
  if (run.running) throw new Error("An estate scan is already running.");
  const wanted = new Set(tenantIds?.length ? tenantIds : run.rows.map((r) => r.tenantId));
  const targets = run.rows.filter((r) => wanted.has(r.tenantId));
  for (const r of targets) {
    r.status = "queued";
    delete r.error;
  }
  Object.assign(run, {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    concurrency,
    running: true,
    total: targets.length,
    done: 0,
    calls: 0,
  });
  const started = Date.now();
  log.emit("info", SECTION, `Estate scan started: ${targets.length} tenants, ${concurrency} at a time.`);

  void (async () => {
    await mapPool(targets, concurrency, async (row) => {
      row.status = "reading";
      const info = pctx.tenants.find((t) => t.id === row.tenantId);
      try {
        if (!info) throw new Error("This credential no longer reaches the tenant.");
        const result = await runReadiness(
          dataDir,
          pctx.client,
          { id: info.id, name: info.name, region: row.region, apiHost: info.apiHost, credentialType: pctx.identity.idType === "organization" ? "organization" : "partner" },
          tool,
          { parallel: 2 },
        );
        Object.assign(row, rowFrom(row, result));
        run.calls += result.calls;
      } catch (err) {
        row.status = "error";
        row.error = err instanceof Error ? err.message : String(err);
        log.emit("warn", SECTION, `${row.name}: ${row.error}`, { tenant: row.tenantId });
      }
      run.done++;
      if (run.done % 10 === 0) await persist(dataDir, run);
    });
    run.running = false;
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
    await persist(dataDir, run);
    const errors = run.rows.filter((r) => r.status === "error").length;
    const unreadable = run.rows.filter((r) => r.verdict === "unreadable").length;
    log.emit(
      "info",
      SECTION,
      `Estate scan finished: ${run.done} tenants in ${(run.durationMs / 1000).toFixed(0)} s, ${run.calls} reads, ${unreadable} unreadable, ${errors} errors.`,
    );
  })();
  return run;
}

export function resetEstate(): void {
  current = null;
}
