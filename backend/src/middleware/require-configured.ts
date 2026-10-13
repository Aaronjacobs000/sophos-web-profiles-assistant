/**
 * Guards routes that need a working credential. The pages treat a 409 with
 * {error:"unconfigured"} as the signal to open the setup wizard.
 */

import type { Request, Response, NextFunction } from "express";
import { getState } from "../state.js";

export function requireConfigured(_req: Request, res: Response, next: NextFunction): void {
  const state = getState();
  if (state.status === "unconfigured") {
    res.status(409).json({ error: "unconfigured" });
    return;
  }
  if (state.status === "configured-invalid") {
    res.status(503).json({ error: "configured-invalid", message: state.lastError });
    return;
  }
  next();
}
