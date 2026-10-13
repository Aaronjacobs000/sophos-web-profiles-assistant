/**
 * The server's configuration state: which credential mode is in use and the
 * live client stack for it. Rebuilt on startup and after every credential save.
 */

import path from "node:path";
import { applyEnvToProcess, readEnvFile, setEnvValues, writeEnvFile, type EnvFile } from "./config/env-file.js";
import {
  MANAGED_ENV_KEYS,
  envKeys,
  extractCredentials,
  getCredentialMode,
  maskCredentials,
  type CredentialMode,
  type CredentialView,
} from "./config/validate.js";
import {
  createPartnerContext,
  createTenantContext,
  partnerTenantContext,
  type PartnerContext,
  type TenantContext,
  type TenantSummary,
} from "./sophos/tenant-context.js";
import { log } from "./log.js";
import { readOnlyMode } from "./sophos/read-only-guard.js";

export type AppStatus = "unconfigured" | "configured-invalid" | "configured-ok";

export interface AppState {
  repoRoot: string;
  dataDir: string;
  envPath: string;
  envFile: EnvFile;
  status: AppStatus;
  mode: CredentialMode;
  tenant: TenantContext | null;
  partner: PartnerContext | null;
  lastError: string | null;
}

export interface StatusPayload {
  status: AppStatus;
  mode: CredentialMode;
  error: string | null;
  /** Tenant mode: the one tenant. */
  tenant: TenantSummary | null;
  /** Partner mode: who the credential is and how many tenants it reaches. */
  partner: { id: string; idType: string; label: string | null; tenantCount: number } | null;
  version: string;
  /** READ_ONLY=1: every write to Sophos is refused before it's sent. */
  readOnly: boolean;
}

let state: AppState | null = null;
let version = "0.0.0";

export function getState(): AppState {
  if (!state) throw new Error("State not initialised. Call initState() first.");
  return state;
}

/**
 * Where the credentials and data live: .env and data/ in the repo folder, or
 * WPA_ENV_FILE and WPA_DATA_DIR, so a customer's credential and data can be
 * kept apart from the repo.
 */
export function storagePaths(repoRoot: string, env: NodeJS.ProcessEnv = process.env): { envPath: string; dataDir: string } {
  return {
    envPath: env.WPA_ENV_FILE?.trim() ? path.resolve(env.WPA_ENV_FILE.trim()) : path.join(repoRoot, ".env"),
    dataDir: env.WPA_DATA_DIR?.trim() ? path.resolve(env.WPA_DATA_DIR.trim()) : path.join(repoRoot, "data"),
  };
}

/** WPA_TENANTS: tenant ids a partner credential may use. Empty means every tenant it manages. */
export function tenantAllowList(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const ids = (env.WPA_TENANTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

export async function initState(repoRoot: string, appVersion: string): Promise<AppState> {
  version = appVersion;
  const { envPath, dataDir } = storagePaths(repoRoot);
  const envFile = await readEnvFile(envPath);
  applyEnvToProcess(envFile, MANAGED_ENV_KEYS as unknown as string[]);
  state = {
    repoRoot,
    dataDir,
    envPath,
    envFile,
    status: "unconfigured",
    mode: "tenant",
    tenant: null,
    partner: null,
    lastError: null,
  };
  await rebuildContexts();
  return state;
}

export function appVersion(): string {
  return version;
}

/** Re-reads .env and builds the client stack for the configured mode. */
export async function rebuildContexts(): Promise<void> {
  const st = getState();
  st.envFile = await readEnvFile(st.envPath);
  applyEnvToProcess(st.envFile, MANAGED_ENV_KEYS as unknown as string[]);
  st.mode = getCredentialMode(st.envFile);
  st.tenant = null;
  st.partner = null;
  st.lastError = null;

  const creds = extractCredentials(st.envFile, st.mode);
  if (!creds) {
    st.status = "unconfigured";
    log.info(`[state] unconfigured mode=${st.mode}`);
    return;
  }
  try {
    if (st.mode === "partner") {
      st.partner = await createPartnerContext(creds);
      const allow = tenantAllowList();
      if (allow) {
        st.partner.tenants = st.partner.tenants.filter((t) => allow.has(t.id.toLowerCase()));
        log.info(`[state] WPA_TENANTS limits this partner credential to ${st.partner.tenants.length} of ${allow.size} listed tenants`);
      }
      log.info(`[state] configured-ok mode=partner tenants=${st.partner.tenants.length}`);
    } else {
      st.tenant = await createTenantContext(creds);
      log.info(`[state] configured-ok mode=tenant tenant=${st.tenant.tenantId}`);
    }
    st.status = "configured-ok";
  } catch (err) {
    st.status = "configured-invalid";
    st.lastError = err instanceof Error ? err.message : String(err);
    log.warn(`[state] configured-invalid mode=${st.mode}: ${st.lastError}`);
  }
}

/** Saves one credential, switches to its mode, and rebuilds. */
export async function saveCredentials(mode: CredentialMode, update: { clientId?: string; clientSecret?: string; label?: string }): Promise<void> {
  const st = getState();
  const keys = envKeys(mode);
  const current = await readEnvFile(st.envPath);
  const next = setEnvValues(current, {
    CREDENTIAL_MODE: mode,
    [keys.id]: update.clientId,
    [keys.secret]: update.clientSecret,
    [keys.label]: update.label,
  });
  await writeEnvFile(next);
  await rebuildContexts();
}

export function getStatusPayload(): StatusPayload {
  const st = getState();
  return {
    status: st.status,
    mode: st.mode,
    error: st.lastError,
    tenant: st.tenant?.summary ?? null,
    partner: st.partner
      ? {
          id: st.partner.identity.id,
          idType: st.partner.identity.idType,
          label: st.partner.label ?? null,
          tenantCount: st.partner.tenants.length,
        }
      : null,
    version,
    readOnly: readOnlyMode(),
  };
}

export function getCredentialsView(): { mode: CredentialMode; tenant: CredentialView; partner: CredentialView } {
  const st = getState();
  return {
    mode: st.mode,
    tenant: maskCredentials(st.envFile, "tenant"),
    partner: maskCredentials(st.envFile, "partner"),
  };
}

/** The tenants this credential reaches, in name order. */
export function listTenants(): Array<{ id: string; name: string; region: string | null; apiHost: string }> {
  const st = getState();
  if (st.tenant) {
    const s = st.tenant.summary;
    return [{ id: s.tenantId, name: s.displayName, region: s.region, apiHost: s.apiHost }];
  }
  if (st.partner) {
    return st.partner.tenants
      .map((t) => ({ id: t.id, name: t.name, region: t.dataRegion ?? null, apiHost: t.apiHost }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return [];
}

/** The context for one tenant, or an error that says why there isn't one. */
export function contextFor(tenantId: string): TenantContext {
  const st = getState();
  if (st.tenant) {
    if (tenantId !== st.tenant.tenantId && tenantId !== "self") {
      throw new Error(`Tenant ${tenantId} is not the tenant these credentials belong to.`);
    }
    return st.tenant;
  }
  if (st.partner) return partnerTenantContext(st.partner, tenantId);
  throw new Error("No credentials are configured. Complete setup first.");
}
