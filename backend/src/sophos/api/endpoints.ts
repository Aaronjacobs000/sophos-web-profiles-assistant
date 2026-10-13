/**
 * /endpoint/v1/endpoints, read only, walking the key-based pagination. Only
 * the fields eligibility needs are requested.
 */

import type { TenantApi } from "./requester.js";
import type { DeviceLike } from "../../domain/eligibility.js";

const FIELDS = "hostname,type,os,assignedProducts,lastSeenAt,group,associatedPerson";

interface EndpointPage {
  items?: DeviceLike[];
  pages?: { nextKey?: string };
}

export async function listAllEndpoints(api: TenantApi, tenantId: string): Promise<DeviceLike[]> {
  const all: DeviceLike[] = [];
  let pageFromKey: string | undefined;
  do {
    const params: Record<string, string> = { pageSize: "500", fields: FIELDS };
    if (pageFromKey) params.pageFromKey = pageFromKey;
    const page = await api.tenantRequest<EndpointPage>(tenantId, "/endpoint/v1/endpoints", { params });
    all.push(...(page.items ?? []));
    pageFromKey = page.pages?.nextKey;
  } while (pageFromKey);
  return all;
}
