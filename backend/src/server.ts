import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";

import { initState } from "./state.js";
import { log } from "./log.js";
import { errorHandler } from "./middleware/error-handler.js";
import { localHostOnly, noFraming, ownPagesOnly } from "./middleware/local-host.js";
import { allowedClientsOnly } from "./middleware/client-ip.js";
import { addressUrl, listenErrorMessage, networkSettings, type NetworkSettings } from "./config/network.js";
import { auditWarnings } from "./services/audit-log.js";
import { statusRouter } from "./routes/status.js";
import { credentialsRouter } from "./routes/credentials.js";
import { readinessRouter } from "./routes/readiness.js";
import { estateRouter } from "./routes/estate.js";
import { logsRouter } from "./routes/logs.js";
import { convertRouter } from "./routes/convert.js";
import { pilotRouter } from "./routes/pilot.js";
import { siemCollectHours } from "./config/validate.js";
import { startCollector } from "./services/siem-store.js";
import { contextFor, storagePaths } from "./state.js";
import { installFetchGuard, readOnlyMode } from "./sophos/read-only-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root is two levels up from backend/dist/ at runtime.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VERSION = (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
export const DEFAULT_PORT = 3110;

// A missing .env is fine: the server starts unconfigured and the setup wizard takes over.
// WPA_ENV_FILE keeps a credential outside the repo folder.
dotenv.config({ path: storagePaths(REPO_ROOT).envPath, quiet: true });
// READ_ONLY=1: refuse every write to Sophos before it leaves this computer.
if (readOnlyMode()) installFetchGuard();

function readNetworkSettings(): NetworkSettings {
  try {
    return networkSettings();
  } catch (err) {
    log.error(`Not starting: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function logNetwork(network: NetworkSettings, port: number): void {
  if (!network.beyondLoopback) {
    if (network.allowList) log.info("ALLOWED_IPS has no effect while HOST is a loopback address: only this computer can connect.");
    return;
  }
  const names = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  log.info(`host names accepted: 127.0.0.1, localhost, [::1], this computer's IP addresses${names.length ? `, ${names.join(", ")}` : ""}`);
  if (network.allowList) {
    log.info(`clients allowed: this computer, ${network.allowList.entries.join(", ")} (ALLOWED_IPS)`);
  } else {
    log.warn(
      `WARNING: listening beyond this computer with no ALLOWED_IPS. Anyone who can reach port ${port} can use the tool, ` +
        "and the Sophos credentials it holds. Set ALLOWED_IPS to the addresses or subnets that may use it.",
    );
  }
}

async function main() {
  const network = readNetworkSettings();
  const state = await initState(REPO_ROOT, VERSION);
  // The pilot digest's SIEM collection, for tenants that turned it on.
  startCollector(state.dataDir, siemCollectHours(), contextFor);

  const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
  const HOST = network.host;

  const app = express();
  app.disable("x-powered-by");
  // On every answer, refusals included: no other site may frame the tool.
  app.use(noFraming);
  // First, so a client outside ALLOWED_IPS gets nothing at all.
  app.use(allowedClientsOnly(network.allowList));
  // Next, so a page on another site that reaches the tool by DNS rebinding gets nothing.
  app.use(localHostOnly);
  // And the API answers only the tool's own pages.
  app.use("/api", ownPagesOnly);
  app.use(express.json({ limit: "3mb" }));
  app.use(auditWarnings);

  app.use("/api", statusRouter);
  app.use("/api", credentialsRouter);
  app.use("/api", logsRouter);
  app.use("/api", estateRouter);
  app.use("/api", readinessRouter);
  app.use("/api", convertRouter);
  app.use("/api", pilotRouter);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const FRONTEND_DIR = path.join(REPO_ROOT, "frontend");
  app.use(express.static(FRONTEND_DIR, { index: "index.html" }));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });

  app.use(errorHandler);

  const stop = (err: unknown): never => {
    log.error(`Not starting: ${listenErrorMessage(err, HOST, PORT)}`);
    process.exit(1);
  };
  try {
    app
      .listen(PORT, HOST, () => {
        log.info(`Web Profiles Assistant ${VERSION} listening on ${addressUrl(HOST, PORT)} (repo: ${REPO_ROOT}, data: ${state.dataDir})`);
        if (readOnlyMode()) log.info("Read-only mode: every write to Sophos is refused before it is sent (READ_ONLY=1).");
        logNetwork(network, PORT);
      })
      .on("error", stop);
  } catch (err) {
    stop(err);
  }
}

main().catch((err) => {
  log.error("fatal startup error", err);
  process.exit(1);
});
