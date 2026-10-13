/**
 * Endpoint groups, user groups and users: enough to tell whether a policy is
 * assigned to something that no longer exists or has no members.
 */

import type { TenantApi } from "./requester.js";
import { listAllPages } from "./paging.js";

export interface EndpointGroup {
  id: string;
  name: string;
  type?: string;
  description?: string;
  endpoints?: { total?: number; itemsCount?: number };
}

export interface UserGroup {
  id: string;
  name: string;
  description?: string;
  source?: { type?: string };
  users?: { total?: number; itemsCount?: number };
  groups?: { total?: number; itemsCount?: number };
}

export interface User {
  id: string;
  name?: string;
  email?: string;
}

export const listEndpointGroups = (api: TenantApi, tenantId: string) =>
  listAllPages<EndpointGroup>(api, tenantId, "/endpoint/v1/endpoint-groups", {}, 1000);

export const listUserGroups = (api: TenantApi, tenantId: string) =>
  listAllPages<UserGroup>(api, tenantId, "/common/v1/directory/user-groups", {}, 100);

/** Looks up users by ID, 50 at a time. An ID missing from the answer is a user that no longer exists. */
export async function findUsers(api: TenantApi, tenantId: string, ids: string[]): Promise<User[]> {
  const found: User[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    found.push(
      ...(await listAllPages<User>(api, tenantId, "/common/v1/directory/users", { ids: chunk.join(","), fields: "id,name,email" }, 100)),
    );
  }
  return found;
}
