/**
 * /endpoint/v1/policies, read only. The list call returns each policy with
 * its full settings, priority, enabled flag and appliesTo.
 */

import type { TenantApi } from "./requester.js";
import { listAllPages } from "./paging.js";

export const WEB_POLICY_TYPES = ["web-control", "server-web-control"] as const;
export const THREAT_POLICY_TYPES = ["threat-protection", "server-threat-protection"] as const;
export type PolicyType = (typeof WEB_POLICY_TYPES)[number] | (typeof THREAT_POLICY_TYPES)[number];

export interface Setting<T = unknown> {
  value: T;
  recommendedValue?: T;
}

export interface Policy {
  id: string;
  name: string;
  type: string;
  enabled?: boolean;
  priority?: number;
  lockedByManagingAccount?: boolean;
  appliesTo?: {
    users?: string[];
    userGroups?: string[];
    endpoints?: string[];
    endpointGroups?: string[];
  };
  settings?: Record<string, Setting>;
  createdAt?: string;
  updatedAt?: string;
}

export const listPolicies = (api: TenantApi, tenantId: string, policyType: PolicyType) =>
  listAllPages<Policy>(api, tenantId, "/endpoint/v1/policies", { policyType }, 200);

// ---------- writes (drop 2 and 3). Each is sent once; callers read back and audit. ----------

export const getPolicy = (api: TenantApi, tenantId: string, id: string) =>
  api.tenantRequest<Policy>(tenantId, `/endpoint/v1/policies/${encodeURIComponent(id)}`);

export const createPolicy = (api: TenantApi, tenantId: string, body: Record<string, unknown>) =>
  api.tenantRequest<Policy>(tenantId, "/endpoint/v1/policies", { method: "POST", body });

export const patchPolicy = (api: TenantApi, tenantId: string, id: string, body: Record<string, unknown>) =>
  api.tenantRequest<Policy>(tenantId, `/endpoint/v1/policies/${encodeURIComponent(id)}`, { method: "PATCH", body });

export const deletePolicy = (api: TenantApi, tenantId: string, id: string) =>
  api.tenantRequest<{ deleted?: boolean }>(tenantId, `/endpoint/v1/policies/${encodeURIComponent(id)}`, { method: "DELETE" });
