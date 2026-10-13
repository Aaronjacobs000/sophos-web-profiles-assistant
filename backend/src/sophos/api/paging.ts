/**
 * Page-number pagination for list endpoints that return { items, pages }.
 * Asks for pageTotal on the first page so every page is fetched.
 */

import type { TenantApi } from "./requester.js";

export async function listAllPages<T>(
  api: TenantApi,
  tenantId: string,
  path: string,
  params: Record<string, string> = {},
  pageSize = 100,
  headers?: Record<string, string>,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await api.tenantRequest<{ items?: T[]; pages?: { total?: number } }>(tenantId, path, {
      params: { ...params, page: String(page), pageSize: String(pageSize), ...(page === 1 ? { pageTotal: "true" } : {}) },
      ...(headers ? { headers } : {}),
    });
    items.push(...(res.items ?? []));
    if (page === 1) totalPages = res.pages?.total ?? 1;
    page++;
  } while (page <= totalPages);
  return items;
}
