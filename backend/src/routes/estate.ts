/** Partner mode: the estate view and its background scan. */

import { Router } from "express";
import { appVersion, getState } from "../state.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { jsonOnly } from "../middleware/json-body.js";
import { getEstate, startEstateScan } from "../services/estate.js";
import { estateConcurrency } from "../config/validate.js";

export const estateRouter = Router();
estateRouter.use("/estate", requireConfigured);

function partnerOr409(res: import("express").Response) {
  const p = getState().partner;
  if (!p) res.status(409).json({ error: "not_partner", message: "The estate view needs a partner or organization credential." });
  return p;
}

estateRouter.get("/estate", async (_req, res) => {
  const p = partnerOr409(res);
  if (!p) return;
  res.json(await getEstate(getState().dataDir, p));
});

/** POST /api/estate/scan { tenantIds?: string[] } */
estateRouter.post("/estate/scan", jsonOnly, async (req, res) => {
  const p = partnerOr409(res);
  if (!p) return;
  const ids = Array.isArray(req.body?.tenantIds) ? (req.body.tenantIds as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
  try {
    const run = await startEstateScan(getState().dataDir, p, { name: "web-profiles-assistant", version: appVersion() }, estateConcurrency(), ids);
    res.status(202).json(run);
  } catch (err) {
    res.status(409).json({ error: "busy", message: err instanceof Error ? err.message : String(err) });
  }
});
