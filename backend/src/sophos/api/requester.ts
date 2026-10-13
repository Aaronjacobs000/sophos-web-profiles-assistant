/**
 * The one method the API wrappers need, so they work with the vendored
 * SophosClient, the read-only wrapper below, or a fake in the tests.
 */

import type { RequestOptions } from "../client/sophos-client.js";

export interface TenantApi {
  tenantRequest<T>(tenantId: string, path: string, options?: RequestOptions): Promise<T>;
}

/** Thrown when something tries to send a write through a read-only client. */
export class ReadOnlyViolation extends Error {
  constructor(method: string, path: string) {
    super(`Refused ${method} ${path}: this run only reads the tenant.`);
    this.name = "ReadOnlyViolation";
  }
}

/**
 * Sends GET requests only and counts them. Drop 1 never changes a tenant, and
 * this makes that a property of the code rather than a promise: any write
 * throws before it reaches Sophos.
 */
export class ReadOnlyApi implements TenantApi {
  calls = 0;

  constructor(private readonly inner: TenantApi) {}

  async tenantRequest<T>(tenantId: string, path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    if (method !== "GET") throw new ReadOnlyViolation(method, path);
    this.calls++;
    return this.inner.tenantRequest<T>(tenantId, path, options);
  }
}

/** The HTTP status in a Sophos client error message, when there is one. */
export function errorStatus(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const match = /Sophos API error \(?(\d{3})\)?/.exec(message);
  return match ? Number(match[1]) : undefined;
}
