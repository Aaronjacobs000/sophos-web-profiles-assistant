/**
 * The readiness check for one tenant, its rollback snapshots, and the
 * customer report. Everything here only reads the tenant.
 */

import { Router, type Request, type Response } from "express";
import { appVersion, contextFor, getState, listTenants } from "../state.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { jsonOnly } from "../middleware/json-body.js";
import { lastReadiness, runReadiness } from "../services/readiness.js";
import { listSnapshots, loadSnapshot, slug } from "../services/snapshot-store.js";
import { renderReport } from "../domain/report.js";
import { htmlToPdf, NoBrowserError } from "../services/pdf.js";
import type { InventoryTenant } from "../domain/inventory.js";

export const readinessRouter = Router();
readinessRouter.use(["/tenants", "/readiness", "/snapshots", "/report"], requireConfigured);

const TOOL = () => ({ name: "web-profiles-assistant", version: appVersion() });
const running = new Map<string, Promise<unknown>>();

function tenantFor(req: Request, res: Response): { ctx: ReturnType<typeof contextFor>; tenant: InventoryTenant } | null {
  try {
    const ctx = contextFor(String(req.params.tenantId));
    const s = ctx.summary;
    return {
      ctx,
      tenant: { id: s.tenantId, name: s.displayName, region: s.region, apiHost: s.apiHost, credentialType: s.credentialType },
    };
  } catch (err) {
    res.status(404).json({ error: "unknown_tenant", message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

readinessRouter.get("/tenants", (_req, res) => {
  res.json({ items: listTenants() });
});

readinessRouter.get("/readiness/:tenantId", async (req, res) => {
  const t = tenantFor(req, res);
  if (!t) return;
  const result = await lastReadiness(getState().dataDir, t.tenant.id);
  res.json({ tenant: t.tenant, result, running: running.has(t.tenant.id) });
});

/** Runs the check now. Answers when it finishes (seconds for most tenants). */
readinessRouter.post("/readiness/:tenantId/run", jsonOnly, async (req, res) => {
  const t = tenantFor(req, res);
  if (!t) return;
  const id = t.tenant.id;
  let job = running.get(id);
  if (!job) {
    job = runReadiness(getState().dataDir, t.ctx.client, t.tenant, TOOL(), { parallel: 3 }).finally(() => running.delete(id));
    running.set(id, job);
  }
  try {
    res.json({ tenant: t.tenant, result: await job });
  } catch (err) {
    res.status(502).json({ error: "read_failed", message: err instanceof Error ? err.message : String(err) });
  }
});

readinessRouter.get("/snapshots/:tenantId", async (req, res) => {
  const t = tenantFor(req, res);
  if (!t) return;
  res.json({ items: await listSnapshots(getState().dataDir, t.tenant.id) });
});

readinessRouter.get("/snapshots/:tenantId/:file", async (req, res) => {
  const t = tenantFor(req, res);
  if (!t) return;
  try {
    const loaded = await loadSnapshot(getState().dataDir, t.tenant.id, String(req.params.file));
    res.setHeader("X-Snapshot-Intact", loaded.intact ? "yes" : "no");
    res.setHeader("Content-Disposition", `attachment; filename="${String(req.params.file)}"`);
    res.type("application/json").send(JSON.stringify(loaded.snapshot, null, 2));
  } catch (err) {
    res.status(404).json({ error: "not_found", message: err instanceof Error ? err.message : String(err) });
  }
});

async function reportHtml(req: Request, res: Response): Promise<{ html: string; name: string } | null> {
  const t = tenantFor(req, res);
  if (!t) return null;
  const result = await lastReadiness(getState().dataDir, t.tenant.id);
  if (!result) {
    res.status(409).json({ error: "not_checked", message: "Run the readiness check for this tenant first." });
    return null;
  }
  const tz = typeof req.query.tz === "string" && /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(req.query.tz) ? req.query.tz : undefined;
  let html: string;
  try {
    html = renderReport(result, { generatedAt: new Date().toISOString(), toolVersion: appVersion(), timeZone: tz });
  } catch {
    html = renderReport(result, { generatedAt: new Date().toISOString(), toolVersion: appVersion() });
  }
  const day = result.readAt.slice(0, 10).replace(/-/g, "");
  return { html, name: `web-filtering-readiness_${slug(t.tenant.name)}_${day}` };
}

readinessRouter.get("/report/:tenantId.html", async (req, res) => {
  const r = await reportHtml(req, res);
  if (!r) return;
  if (req.query.download === "1") res.setHeader("Content-Disposition", `attachment; filename="${r.name}.html"`);
  res.type("text/html").send(r.html);
});

readinessRouter.get("/report/:tenantId.pdf", async (req, res) => {
  const r = await reportHtml(req, res);
  if (!r) return;
  try {
    const pdf = await htmlToPdf(r.html);
    res.setHeader("Content-Disposition", `attachment; filename="${r.name}.pdf"`);
    res.type("application/pdf").send(pdf);
  } catch (err) {
    res.status(err instanceof NoBrowserError ? 501 : 500).json({ error: "pdf_failed", message: err instanceof Error ? err.message : String(err) });
  }
});
