/**
 * One readiness run for one tenant: read the inventory, score it, save the
 * rollback snapshot, and keep the result (in memory and in
 * data/results/<tenant id>.json) for the pages and the report.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { readInventory } from "./inventory-reader.js";
import { buildScorecard, type Scorecard } from "../domain/scorecard.js";
import { buildSnapshot } from "../domain/snapshot.js";
import { saveSnapshot } from "./snapshot-store.js";
import { readText, saveFile } from "./safe-files.js";
import { log } from "../log.js";
import type { TenantApi } from "../sophos/api/requester.js";
import type { InventoryTenant } from "../domain/inventory.js";

export interface ReadinessResult {
  tenant: InventoryTenant;
  readAt: string;
  durationMs: number;
  calls: number;
  scorecard: Scorecard;
  snapshot: { file: string; hash: string; bytes: number } | null;
  snapshotError?: string;
}

const SECTION = "readiness";
const cache = new Map<string, ReadinessResult>();
const SAFE_ID = /^[0-9a-f-]{8,64}$/i;

function resultPath(dataDir: string, tenantId: string): string {
  if (!SAFE_ID.test(tenantId)) throw new Error("Not a tenant ID.");
  return path.join(dataDir, "results", `${tenantId}.json`);
}

export async function runReadiness(
  dataDir: string,
  client: TenantApi,
  tenant: InventoryTenant,
  tool: { name: string; version: string },
  opts: { parallel?: number } = {},
): Promise<ReadinessResult> {
  const inventory = await readInventory(client, tenant, { parallel: opts.parallel });
  const scorecard = buildScorecard(inventory);
  const result: ReadinessResult = {
    tenant,
    readAt: inventory.readAt,
    durationMs: inventory.durationMs,
    calls: inventory.calls,
    scorecard,
    snapshot: null,
  };
  if (scorecard.verdict !== "unreadable") {
    try {
      const saved = await saveSnapshot(dataDir, buildSnapshot(inventory, tool));
      result.snapshot = { file: saved.file, hash: saved.hash, bytes: saved.bytes };
    } catch (err) {
      result.snapshotError = err instanceof Error ? err.message : String(err);
      log.emit("error", SECTION, `Couldn't save the snapshot: ${result.snapshotError}`, { tenant: tenant.id });
    }
  }
  cache.set(tenant.id, result);
  try {
    const file = resultPath(dataDir, tenant.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await saveFile(file, JSON.stringify(result), { section: SECTION, mode: 0o600 });
  } catch (err) {
    log.emit("warn", SECTION, `Couldn't keep the result on disk: ${err instanceof Error ? err.message : String(err)}`, { tenant: tenant.id });
  }
  log.emit(
    "info",
    SECTION,
    `${tenant.name}: ${scorecard.verdict}, ${scorecard.counts.fix} fix, ${scorecard.counts.plan} plan, ${inventory.calls} reads in ${(inventory.durationMs / 1000).toFixed(1)} s`,
    { tenant: tenant.id },
  );
  return result;
}

/** The last result for a tenant, from memory or disk; null when it was never checked. */
export async function lastReadiness(dataDir: string, tenantId: string): Promise<ReadinessResult | null> {
  const hit = cache.get(tenantId);
  if (hit) return hit;
  const text = await readText(resultPath(dataDir, tenantId), SECTION).catch(() => null);
  if (!text) return null;
  try {
    const result = JSON.parse(text) as ReadinessResult;
    cache.set(tenantId, result);
    return result;
  } catch {
    return null;
  }
}

/** Drops cached results, for a credential change. */
export function clearReadinessCache(): void {
  cache.clear();
}
