/**
 * Builds the Sophos client stack for one credential.
 *
 *   "tenant"  a tenant-scoped credential reaches one tenant, its own.
 *   "partner" a partner or organization credential reaches every tenant it
 *             manages; a tenant is picked per request.
 *
 * Adapted from the Sophos Fusion Tenant Migration Tool, which held two sides
 * (source and destination). This tool looks at one tenant at a time.
 */

import { TokenManager } from "./auth/token-manager.js";
import { TenantResolver, type CallerIdentity, type TenantInfo } from "./client/tenant-resolver.js";
import { SophosClient } from "./client/sophos-client.js";

export interface Credential {
  clientId: string;
  clientSecret: string;
  label?: string;
}

export interface TenantSummary {
  tenantId: string;
  /** The tenant's name from the partner tenant list, or null for a tenant credential (whoami has no name). */
  tenantName: string | null;
  /** The name the admin gave the credential, if any. */
  userLabel: string | null;
  /** What to call the tenant on screen. */
  displayName: string;
  apiHost: string;
  region: string | null;
  credentialType: "tenant" | "partner" | "organization";
}

/** One tenant, ready to read. */
export interface TenantContext {
  client: SophosClient;
  tenantId: string;
  summary: TenantSummary;
}

export interface PartnerContext {
  client: SophosClient;
  identity: CallerIdentity;
  tenants: TenantInfo[];
  label?: string;
}

/** Validates a tenant credential with whoami and resolves its regional host. */
export async function createTenantContext(creds: Credential): Promise<TenantContext> {
  const tm = new TokenManager(creds.clientId, creds.clientSecret);
  const tr = new TenantResolver(tm);
  const identity = await tr.init();
  if (identity.idType !== "tenant") {
    throw new Error(
      `These credentials are ${identity.idType} credentials, not tenant credentials. Choose "Partner or organization" instead.`,
    );
  }
  const apiHost = identity.apiHosts.dataRegion ?? "";
  const userLabel = creds.label?.trim() || null;
  return {
    client: new SophosClient(tm, tr),
    tenantId: identity.id,
    summary: {
      tenantId: identity.id,
      tenantName: null,
      userLabel,
      displayName: userLabel ?? `Tenant ${identity.id.slice(0, 8)}`,
      apiHost,
      region: parseRegion(apiHost),
      credentialType: "tenant",
    },
  };
}

/** Validates a partner or organization credential and loads its tenant list. */
export async function createPartnerContext(creds: Credential): Promise<PartnerContext> {
  const tm = new TokenManager(creds.clientId, creds.clientSecret);
  const tr = new TenantResolver(tm);
  const identity = await tr.init();
  if (identity.idType !== "partner" && identity.idType !== "organization") {
    throw new Error(
      `These credentials are ${identity.idType} credentials. Partner mode needs partner or organization credentials; choose "One tenant" instead.`,
    );
  }
  const tenants = await tr.loadTenants();
  return { client: new SophosClient(tm, tr), identity, tenants, label: creds.label?.trim() || undefined };
}

/** One tenant of a partner or organization credential. */
export function partnerTenantContext(pctx: PartnerContext, tenantId: string): TenantContext {
  const info = pctx.tenants.find((t) => t.id === tenantId);
  if (!info) throw new Error(`Tenant ${tenantId} is not one this credential manages.`);
  return {
    client: pctx.client,
    tenantId,
    summary: {
      tenantId,
      tenantName: info.name,
      userLabel: null,
      displayName: info.name || `Tenant ${tenantId.slice(0, 8)}`,
      apiHost: info.apiHost,
      region: parseRegion(info.apiHost) ?? info.dataRegion ?? null,
      credentialType: pctx.identity.idType === "organization" ? "organization" : "partner",
    },
  };
}

export function parseRegion(apiHost: string): string | null {
  const match = apiHost.match(/api-([a-z0-9]+)\.central\.sophos\.com/i);
  return match ? match[1]!.toLowerCase() : null;
}
