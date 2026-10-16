/**
 * Collects SIEM web events for the pilot digest without the web server, for
 * a scheduler (cron, launchd, Windows Task Scheduler). Run daily or more
 * often, because the SIEM API keeps about 24 hours.
 *
 *   npm run collect              every tenant with collection turned on
 *   npm run collect -- <tenant>  one tenant, by id (turned on or not)
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { contextFor, initState, storagePaths } from "./state.js";
import { installFetchGuard, readOnlyMode } from "./sophos/read-only-guard.js";
import { collect, enabledTenants } from "./services/siem-store.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
dotenv.config({ path: storagePaths(REPO_ROOT).envPath, quiet: true });
if (readOnlyMode()) installFetchGuard();

async function main(): Promise<number> {
  const state = await initState(REPO_ROOT, VERSION);
  if (state.status !== "configured-ok") {
    console.error(`Not collecting: the credential is ${state.status === "unconfigured" ? "not set" : "not working"}. ${state.lastError ?? ""}`.trim());
    return 1;
  }
  const arg = process.argv[2];
  // A tenant whose saved collection setting can't be read is reported, and the others are still collected.
  const { enabled, unread } = arg ? { enabled: [arg], unread: [] } : await enabledTenants(state.dataDir);
  if (!enabled.length && !unread.length) {
    console.log("No tenant has collection turned on. Turn it on in the pilot step, or name a tenant id.");
    return 0;
  }
  for (const u of unread) notCollected(u.tenantId, "its saved collection setting couldn't be read", u.error);
  let failed = unread.length;
  for (const t of enabled) {
    let ctx: ReturnType<typeof contextFor>;
    try {
      ctx = contextFor(t);
    } catch (err) {
      failed++;
      notCollected(t, "the credential doesn't reach this tenant", err);
      continue;
    }
    try {
      const run = await collect(state.dataDir, ctx.client, ctx.tenantId);
      if (run.ok) console.log(`${named(t)}: ${run.added} new web events of ${run.web}, ${run.pages} pages${run.gap ? `. ${run.gap}` : ""}`);
      else {
        failed++;
        notCollected(t, "collecting its events failed", run.error);
      }
    } catch (err) {
      failed++;
      notCollected(t, "its collection record on this computer couldn't be read or saved", err);
    }
  }
  return failed ? 1 : 0;
}

/** A tenant by name and id, or by id when the credential doesn't reach it. */
function named(tenantId: string): string {
  try {
    return `${contextFor(tenantId).summary.displayName} (${tenantId})`;
  } catch {
    return tenantId;
  }
}

/** Which tenant wasn't collected and why, in plain words, with what failed on a Detail line under it. */
function notCollected(tenantId: string, why: string, detail: unknown): void {
  const text = (detail instanceof Error ? detail.message : String(detail ?? "")).trim();
  console.error(`${named(tenantId)}: not collected, because ${why}.${text ? `\n  Detail: ${/[.!?]$/.test(text) ? text : `${text}.`}` : ""}`);
}

main().then((code) => process.exit(code), (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
