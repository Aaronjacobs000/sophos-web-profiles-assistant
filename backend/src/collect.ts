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
  const tenants = arg ? [arg] : await enabledTenants(state.dataDir);
  if (!tenants.length) {
    console.log("No tenant has collection turned on. Turn it on in the pilot step, or name a tenant id.");
    return 0;
  }
  let failed = 0;
  for (const t of tenants) {
    try {
      const ctx = contextFor(t);
      const run = await collect(state.dataDir, ctx.client, ctx.tenantId);
      console.log(`${ctx.summary.displayName} (${ctx.tenantId}): ${run.ok ? `${run.added} new web events of ${run.web}, ${run.pages} pages` : `failed: ${run.error}`}${run.gap ? `. ${run.gap}` : ""}`);
      if (!run.ok) failed++;
    } catch (err) {
      failed++;
      console.error(`${t}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
