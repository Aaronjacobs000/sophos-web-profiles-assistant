/**
 * Global scanning exclusions. Web Control does not apply to sites excluded
 * from threat checks (type "web"), so the scorecard lists them.
 */

import type { TenantApi } from "./requester.js";
import { listAllPages } from "./paging.js";

export interface ScanningExclusion {
  id: string;
  type: string;
  value: string;
  scanMode?: string;
  description?: string;
  comment?: string;
}

export const listScanningExclusions = (api: TenantApi, tenantId: string, type?: string) =>
  listAllPages<ScanningExclusion>(api, tenantId, "/endpoint/v1/settings/exclusions/scanning", type ? { type } : {});
