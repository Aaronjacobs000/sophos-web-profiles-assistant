/** The shape the report needs from a readiness run. Pure types. */

import type { Scorecard } from "./scorecard.js";
import type { InventoryTenant } from "./inventory.js";

export interface ReadinessLike {
  tenant: InventoryTenant;
  readAt: string;
  durationMs: number;
  calls: number;
  scorecard: Scorecard;
  snapshot: { file: string; hash: string; bytes: number } | null;
}
