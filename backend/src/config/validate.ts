/**
 * The .env credential shape and masking helpers. Two credential modes:
 *   "tenant"  one tenant-scoped credential: a customer checking its own tenant.
 *   "partner" one partner or organization credential: an estate of tenants.
 *
 * An optional SophosLabs Intelix credential (INTELIX_*) feeds the clean-up
 * step's category lookups.
 */

import type { EnvFile } from "./env-file.js";
import { getEnvValue } from "./env-file.js";

export type CredentialMode = "tenant" | "partner";

export const MANAGED_ENV_KEYS = [
  "PORT",
  "CREDENTIAL_MODE",
  "SOPHOS_TENANT_CLIENT_ID",
  "SOPHOS_TENANT_CLIENT_SECRET",
  "SOPHOS_TENANT_LABEL",
  "SOPHOS_PARTNER_CLIENT_ID",
  "SOPHOS_PARTNER_CLIENT_SECRET",
  "SOPHOS_PARTNER_LABEL",
  "ESTATE_CONCURRENCY",
  "CHROME_PATH",
  "INTELIX_CLIENT_ID",
  "INTELIX_CLIENT_SECRET",
  "INTELIX_REGION",
  "SIEM_COLLECT_HOURS",
] as const;

export function getCredentialMode(file: EnvFile): CredentialMode {
  return getEnvValue(file, "CREDENTIAL_MODE")?.trim() === "partner" ? "partner" : "tenant";
}

export interface StoredCredential {
  clientId: string;
  clientSecret: string;
  label: string;
}

export interface CredentialView {
  clientId: string;
  clientSecretMasked: string;
  label: string;
  configured: boolean;
}

const PREFIX: Record<CredentialMode, string> = {
  tenant: "SOPHOS_TENANT_",
  partner: "SOPHOS_PARTNER_",
};

export function envKeys(mode: CredentialMode): { id: string; secret: string; label: string } {
  const p = PREFIX[mode];
  return { id: `${p}CLIENT_ID`, secret: `${p}CLIENT_SECRET`, label: `${p}LABEL` };
}

export function extractCredentials(file: EnvFile, mode: CredentialMode): StoredCredential | null {
  const keys = envKeys(mode);
  const clientId = getEnvValue(file, keys.id)?.trim() ?? "";
  const clientSecret = getEnvValue(file, keys.secret)?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, label: getEnvValue(file, keys.label)?.trim() ?? "" };
}

export function maskCredentials(file: EnvFile, mode: CredentialMode): CredentialView {
  const creds = extractCredentials(file, mode);
  if (!creds) return { clientId: "", clientSecretMasked: "", label: "", configured: false };
  return {
    clientId: creds.clientId,
    clientSecretMasked: maskSecret(creds.clientSecret),
    label: creds.label,
    configured: true,
  };
}

export function maskSecret(secret: string | undefined): string {
  if (!secret) return "";
  if (secret.length <= 4) return "••••";
  return "••••••••" + secret.slice(-4);
}

/** Tenants read at once in an estate scan: ESTATE_CONCURRENCY, 1 to 8, default 4. */
/** Hours between SIEM collections while the server runs: 6 by default, 0 turns the timer off, at most 23 so no day is missed. */
export function siemCollectHours(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.SIEM_COLLECT_HOURS ?? "");
  if (!Number.isFinite(n)) return 6;
  return n <= 0 ? 0 : Math.min(23, Math.max(1, n));
}

export function estateConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.ESTATE_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(n)) return 4;
  return Math.min(8, Math.max(1, n));
}
