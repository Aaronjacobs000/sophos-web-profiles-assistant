/**
 * Drop 3 routes: the pilot digest (SIEM collection, import, digest, narrow
 * Allow with undo), promotion waves, and retiring Website Management tags.
 */

import { Router, type Request, type Response } from "express";
import { appVersion, contextFor, getState } from "../state.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { jsonOnly } from "../middleware/json-body.js";
import { maskSecrets } from "../log.js";
import { summarize, WEB_CONTROL_EVENT } from "../domain/digest.js";
import { collect, importEvents, readEvents, setEnabled, storeSummary } from "../services/siem-store.js";
import { activePilot, addAllow, loadPilotRecord, planAllow, readPilotPolicy, undoAllow } from "../services/pilot-service.js";
import { moveWave, promotionView, setPilotEnabled, undoWave } from "../services/promote-service.js";
import { previewRetire, restoreRetire, retire, retireOverview } from "../services/retire-service.js";
import { listBuilds } from "../services/build-service.js";

export const pilotRouter = Router();
pilotRouter.use(["/pilot", "/promote", "/retire"], requireConfigured);

const TOOL = () => ({ name: "web-profiles-assistant", version: appVersion() });

function ctxOr404(req: Request, res: Response) {
  try {
    return contextFor(String(req.params.tenantId));
  } catch (err) {
    res.status(404).json({ error: "unknown_tenant", message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function fail(res: Response, err: unknown, status = 400) {
  res.status(status).json({ error: "failed", message: maskSecrets(err instanceof Error ? err.message : String(err)) });
}

// ---------- pilot: collection and digest ----------

pilotRouter.get("/pilot/:tenantId", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const dataDir = getState().dataDir;
  try {
    const pilot = await activePilot(dataDir, ctx.tenantId);
    // A pilot policy that answers 404 comes with a problem that says it's gone and what to do; any other failed read, with why it wasn't read.
    const { policy, problem, unread } = pilot ? await readPilotPolicy(ctx, pilot) : { policy: null, problem: undefined, unread: undefined };
    // An Allow whose build was rolled back went with it.
    const allows = (await loadPilotRecord(dataDir, ctx.tenantId)).allows;
    const builds = new Map((await listBuilds(dataDir, ctx.tenantId)).map((b) => [b.id, b.status]));
    res.json({ pilot, policy, ...(problem ? { problem } : {}), ...(unread ? { policyUnread: maskSecrets(unread) } : {}), store: await storeSummary(dataDir, ctx.tenantId), allows: allows.map((a) => ({ ...a, buildStatus: builds.get(a.buildId) ?? "unknown" })) });
  } catch (err) {
    fail(res, err, 500);
  }
});

pilotRouter.post("/pilot/:tenantId/collect", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await collect(getState().dataDir, ctx.client, ctx.tenantId));
  } catch (err) {
    fail(res, err, 500);
  }
});

pilotRouter.put("/pilot/:tenantId/schedule", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await setEnabled(getState().dataDir, ctx.tenantId, (req.body as { enabled?: boolean }).enabled === true));
  } catch (err) {
    fail(res, err, 500);
  }
});

pilotRouter.post("/pilot/:tenantId/import", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const b = req.body as { label?: string; data?: unknown };
  try {
    res.json(await importEvents(getState().dataDir, ctx.tenantId, b.data ?? b, String(b.label ?? "import")));
  } catch (err) {
    fail(res, err);
  }
});

pilotRouter.get("/pilot/:tenantId/digest", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const dataDir = getState().dataDir;
  const days = Number(req.query.days ?? 7);
  const since = days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : undefined;
  try {
    const events = await readEvents(dataDir, ctx.tenantId, since?.slice(0, 10));
    let list = events;
    let pilotDevices: string[] | null = null;
    // Set when the pilot policy couldn't be read (not a 404): its devices are unknown, so nothing is counted rather than counting none.
    let pilotUnread: string | undefined;
    if (req.query.pilotOnly === "1") {
      const pilot = await activePilot(dataDir, ctx.tenantId);
      // A pilot policy that answers 404 is gone, so no device is on it.
      const read = pilot ? await readPilotPolicy(ctx, pilot) : null;
      pilotUnread = read?.unread;
      pilotDevices = pilotUnread ? null : read?.policy?.endpoints ?? [];
      const set = new Set(pilotDevices ?? []);
      list = events.filter((e) => e.endpoint_id && set.has(e.endpoint_id));
    }
    const digest = summarize(list, since);
    res.json({
      days,
      since: since ?? null,
      pilotOnly: req.query.pilotOnly === "1",
      pilotDevices: pilotDevices?.length ?? null,
      ...(pilotUnread ? { pilotUnread: maskSecrets(pilotUnread) } : {}),
      imported: list.filter((e) => e._imported && e.type === WEB_CONTROL_EVENT && (!since || String(e.created_at ?? "") >= since)).length,
      otherWebEvents: list.filter((e) => e.type !== WEB_CONTROL_EVENT).length,
      ...digest,
    });
  } catch (err) {
    fail(res, err, 500);
  }
});

pilotRouter.post("/pilot/:tenantId/allow", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const b = req.body as { host?: string; dryRun?: boolean };
  if (!b.host?.trim()) return fail(res, new Error("Which host?"));
  try {
    const dataDir = getState().dataDir;
    if (b.dryRun !== false) return res.json({ dryRun: true, plan: await planAllow(dataDir, ctx, b.host.trim()) });
    res.json({ dryRun: false, ...(await addAllow(dataDir, ctx, b.host.trim())) });
  } catch (err) {
    fail(res, err);
  }
});

pilotRouter.post("/pilot/:tenantId/allow/:id/undo", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await undoAllow(getState().dataDir, ctx, String(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

// ---------- promotion waves ----------

pilotRouter.get("/promote/:tenantId", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  // No waveSize: the view picks about ten waves' worth.
  const asked = Number(req.query.waveSize);
  const size = Number.isFinite(asked) && asked >= 1 ? Math.min(500, Math.floor(asked)) : null;
  try {
    const view = await promotionView(getState().dataDir, ctx, size);
    res.json(view.policyUnread ? { ...view, policyUnread: maskSecrets(view.policyUnread) } : view);
  } catch (err) {
    fail(res, err, 500);
  }
});

pilotRouter.post("/promote/:tenantId/wave", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const b = req.body as { devices?: string[]; dryRun?: boolean };
  try {
    res.json(await moveWave(getState().dataDir, ctx, Array.isArray(b.devices) ? b.devices.map(String) : [], b.dryRun !== false));
  } catch (err) {
    fail(res, err);
  }
});

pilotRouter.post("/promote/:tenantId/wave/:id/undo", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await undoWave(getState().dataDir, ctx, String(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});

pilotRouter.post("/promote/:tenantId/enabled", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await setPilotEnabled(getState().dataDir, ctx, (req.body as { enabled?: boolean }).enabled === true));
  } catch (err) {
    fail(res, err);
  }
});

// ---------- retiring Website Management tags ----------

pilotRouter.get("/retire/:tenantId", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await retireOverview(getState().dataDir, ctx));
  } catch (err) {
    fail(res, err, 500);
  }
});

pilotRouter.post("/retire/:tenantId/plan", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const tags = (req.body as { tags?: string[] }).tags;
  try {
    res.json(await previewRetire(getState().dataDir, ctx, Array.isArray(tags) ? tags.map(String) : []));
  } catch (err) {
    fail(res, err);
  }
});

pilotRouter.post("/retire/:tenantId/execute", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const b = req.body as { tags?: string[]; confirm?: boolean };
  try {
    res.json(await retire(getState().dataDir, ctx, Array.isArray(b.tags) ? b.tags.map(String) : [], b.confirm === true, TOOL()));
  } catch (err) {
    fail(res, err);
  }
});

pilotRouter.post("/retire/:tenantId/:id/restore", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await restoreRetire(getState().dataDir, ctx, String(req.params.id)));
  } catch (err) {
    fail(res, err);
  }
});
