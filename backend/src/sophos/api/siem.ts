/**
 * SIEM integration API (/siem/v1, regional host), read only. Events go back
 * about 24 hours: a from_date older than about 25 hours gets a 400 (retested
 * 13/10/2026). Pages are chained by next_cursor.
 */

import type { TenantApi } from "./requester.js";
import type { SiemEvent } from "../../domain/digest.js";

export interface SiemPage {
  items?: SiemEvent[];
  has_more?: boolean;
  next_cursor?: string;
}

export const EVENTS_PATH = "/siem/v1/events";

export function getEvents(api: TenantApi, tenantId: string, q: { cursor?: string; fromDate?: number; limit?: number }): Promise<SiemPage> {
  const params: Record<string, string> = { limit: String(q.limit ?? 1000) };
  if (q.cursor) params.cursor = q.cursor;
  else if (q.fromDate) params.from_date = String(q.fromDate);
  return api.tenantRequest<SiemPage>(tenantId, EVENTS_PATH, { params });
}
