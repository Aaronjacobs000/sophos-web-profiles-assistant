/**
 * Drop 2 routes: the SophosLabs Intelix credential, the clean-up step, the
 * standalone site list cleaner, the design step, the build with its dry run
 * and rollback, and the diff against a snapshot.
 */

import { Router, type Request, type Response } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { appVersion, contextFor, getState } from "../state.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { jsonOnly } from "../middleware/json-body.js";
import { IntelixClient, INTELIX_REGIONS, type IntelixRegion } from "../domain/intelix.js";
import { intelixClient, intelixView, saveIntelix } from "../services/intelix-config.js";
import { EnvValueError } from "../config/env-file.js";
import { getRun, runStandalone, setDecisions, startTenantCleanup, tenantInputs, withDecisions } from "../services/cleanup-service.js";
import { inputsFromText, resultsCsv, siteListCsv, siteListsFrom, summarise } from "../domain/cleanup.js";
import { catalogFrom, expandPreset, type Catalog } from "../domain/categories.js";
import { PRESET_LABELS, type FilterAction } from "../domain/categories-data.js";
import { ReadOnlyApi } from "../sophos/api/requester.js";
import { getProfileMetadata } from "../sophos/api/web-filters.js";
import { listLocalSites } from "../sophos/api/web-control.js";
import { listPolicies } from "../sophos/api/policies.js";
import { listEndpointGroups, listUserGroups } from "../sophos/api/directory.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import { deviceEligibility } from "../domain/eligibility.js";
import { createLists, lastListsRecord, planLists, undoLists } from "../services/lists-service.js";
import { designFor, diffWithSnapshot, dryRun, execute, getBuild, listBuilds, rollback, type PilotOptions } from "../services/build-service.js";
import { listSnapshots } from "../services/snapshot-store.js";
import { readText, saveFile } from "../services/safe-files.js";
import { maskSecrets } from "../log.js";

export const convertRouter = Router();
convertRouter.use(["/cleanup", "/design", "/build", "/diff", "/pilot-targets"], requireConfigured);

const TOOL = () => ({ name: "web-profiles-assistant", version: appVersion() });
const ACTIONS: FilterAction[] = ["allow", "block", "warn"];

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

// ---------- SophosLabs Intelix credential ----------

convertRouter.get("/intelix", (_req, res) => {
  res.json(intelixView());
});

convertRouter.put("/intelix", jsonOnly, async (req, res) => {
  const b = req.body as { clientId?: string; clientSecret?: string; region?: string };
  if (!b.clientId?.trim()) return fail(res, new Error("A Client ID is required."));
  try {
    await saveIntelix({ clientId: b.clientId.trim(), clientSecret: b.clientSecret?.trim(), region: b.region });
    res.json(intelixView());
  } catch (err) {
    fail(res, err, err instanceof EnvValueError ? 400 : 500);
  }
});

/** Asks Intelix for a token with the given credential, or the saved one. Costs nothing: only lookups are billed. */
convertRouter.post("/intelix/test", jsonOnly, async (req, res) => {
  const b = req.body as { clientId?: string; clientSecret?: string; region?: string };
  try {
    const client = b.clientId && b.clientSecret
      ? new IntelixClient({ clientId: b.clientId.trim(), clientSecret: b.clientSecret.trim(), region: (INTELIX_REGIONS.includes(b.region as IntelixRegion) ? b.region : "au") as IntelixRegion })
      : intelixClient();
    if (!client) return fail(res, new Error("No Intelix credential saved."));
    await client.getToken();
    res.json({ ok: true, message: "Intelix issued a token. Lookups are billed per answer; the token itself is free." });
  } catch (err) {
    fail(res, err);
  }
});

// ---------- catalog ----------

async function catalogForTenant(tenantId: string | null): Promise<Catalog> {
  if (!tenantId) return catalogFrom(null);
  try {
    const ctx = contextFor(tenantId);
    return catalogFrom(await getProfileMetadata(new ReadOnlyApi(ctx.client), ctx.tenantId));
  } catch {
    return catalogFrom(null);
  }
}

convertRouter.get("/presets", async (req, res) => {
  const catalog = await catalogForTenant(typeof req.query.tenant === "string" ? req.query.tenant : null);
  res.json({ items: catalog.presets.map((p) => ({ name: p.name, label: PRESET_LABELS[p.name] ?? p.name })) });
});

// ---------- clean-up step (one tenant) ----------

function cleanupView(run: Awaited<ReturnType<typeof getRun>>, prefix: string) {
  if (!run) return { run: null };
  const results = withDecisions(run);
  const { lists, leftOut } = siteListsFrom(results, prefix);
  const { results: _r, ...meta } = run;
  void _r;
  return { run: meta, results, summary: summarise(results), lists: lists.map((l) => ({ name: l.name, action: l.action, sites: l.sites.length })), leftOut: leftOut.length };
}

convertRouter.get("/cleanup/:tenantId", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const run = await getRun(getState().dataDir, ctx.tenantId);
  res.json({ ...cleanupView(run, `${ctx.summary.displayName} cleaned`), lastLists: await lastListsRecord(getState().dataDir, ctx.tenantId), intelix: intelixView().configured });
});

convertRouter.post("/cleanup/:tenantId/run", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const b = req.body as { dns?: boolean; intelix?: boolean };
  try {
    const run = await startTenantCleanup(getState().dataDir, ctx.client, ctx.tenantId, { dns: b.dns !== false, intelix: b.intelix === false ? null : intelixClient() });
    res.status(202).json({ running: run.running, total: run.total });
  } catch (err) {
    fail(res, err, 409);
  }
});

convertRouter.put("/cleanup/:tenantId/decisions", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    const run = await setDecisions(getState().dataDir, ctx.tenantId, (req.body as { decisions?: Record<string, never> }).decisions ?? {});
    res.json(cleanupView(run, `${ctx.summary.displayName} cleaned`));
  } catch (err) {
    fail(res, err);
  }
});

async function sendCsv(res: Response, scope: string, prefix: string, which: string) {
  const run = await getRun(getState().dataDir, scope);
  if (!run) return fail(res, new Error("Run the clean-up first."), 409);
  const results = withDecisions(run);
  if (which === "results") {
    res.setHeader("Content-Disposition", `attachment; filename="cleanup-results.csv"`);
    return res.type("text/csv").send(resultsCsv(results));
  }
  const { lists } = siteListsFrom(results, prefix);
  const list = lists[Number(which)];
  if (!list) return fail(res, new Error("No such list."), 404);
  res.setHeader("Content-Disposition", `attachment; filename="${list.name.replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, "-").toLowerCase()}.csv"`);
  res.type("text/csv").send(siteListCsv(list));
}

convertRouter.get("/cleanup/:tenantId/:which.csv", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  await sendCsv(res, ctx.tenantId, `${ctx.summary.displayName} cleaned`, String(req.params.which));
});

convertRouter.post("/cleanup/:tenantId/lists", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const b = req.body as { dryRun?: boolean; prefix?: string; undo?: boolean };
  const dataDir = getState().dataDir;
  try {
    if (b.undo) return res.json(await undoLists(dataDir, ctx.client, ctx.tenantId));
    const run = await getRun(dataDir, ctx.tenantId);
    if (!run) return fail(res, new Error("Run the clean-up first."), 409);
    const prefix = (b.prefix?.trim() || `${ctx.summary.displayName} cleaned`).slice(0, 80);
    if (b.dryRun !== false) return res.json(await planLists(ctx.client, ctx.tenantId, withDecisions(run), prefix));
    res.json(await createLists(dataDir, ctx.client, ctx.tenantId, ctx.tenantId, withDecisions(run), prefix));
  } catch (err) {
    fail(res, err);
  }
});

// ---------- standalone site list cleaner ----------

convertRouter.get("/cleaner", async (_req, res) => {
  const run = await getRun(getState().dataDir, "cleaner");
  res.json({ ...cleanupView(run, "Cleaned"), intelix: intelixView().configured, lastLists: await lastListsRecord(getState().dataDir, "cleaner") });
});

/** POST /api/cleaner/classify { text?, tenantId?, defaultAction, preset, dns, intelix } */
convertRouter.post("/cleaner/classify", jsonOnly, async (req, res) => {
  const b = req.body as { text?: string; tenantId?: string; defaultAction?: string; preset?: string; dns?: boolean; intelix?: boolean };
  const action = (ACTIONS.includes(b.defaultAction as FilterAction) ? b.defaultAction : "block") as FilterAction;
  try {
    const catalog = await catalogForTenant(b.tenantId ?? null);
    const preset = b.preset && catalog.presets.some((p) => p.name === b.preset) ? b.preset : "keep-it-clean";
    const categoryActions = expandPreset(catalog, preset);
    let inputs;
    if (b.tenantId) {
      if (getState().status !== "configured-ok") return fail(res, new Error("Connect a tenant first."), 409);
      const ctx = contextFor(b.tenantId);
      const api = new ReadOnlyApi(ctx.client);
      const [sites, wc, swc] = await Promise.all([listLocalSites(api, ctx.tenantId), listPolicies(api, ctx.tenantId, "web-control"), listPolicies(api, ctx.tenantId, "server-web-control")]);
      inputs = tenantInputs(catalog, [...wc, ...swc], sites).map((i) => ({ ...i, targets: i.targets.map((t) => ({ ...t, categoryActions })) }));
    } else {
      if (!b.text?.trim()) return fail(res, new Error("Paste some sites or choose a CSV."));
      if (b.text.length > 2_000_000) return fail(res, new Error("That's more than 2 MB of text."));
      inputs = inputsFromText(b.text, action, categoryActions);
    }
    if (inputs.length > 20000) return fail(res, new Error(`${inputs.length} entries is more than this page handles at once (20,000).`));
    const run = await runStandalone(getState().dataDir, inputs, catalog, { dns: b.dns !== false, intelix: b.intelix === false ? null : intelixClient(), preset, defaultAction: action });
    res.json(cleanupView(run, "Cleaned"));
  } catch (err) {
    fail(res, err);
  }
});

convertRouter.put("/cleaner/decisions", jsonOnly, async (req, res) => {
  try {
    const run = await setDecisions(getState().dataDir, "cleaner", (req.body as { decisions?: Record<string, never> }).decisions ?? {});
    res.json(cleanupView(run, "Cleaned"));
  } catch (err) {
    fail(res, err);
  }
});

convertRouter.get("/cleaner/:which.csv", async (req, res) => {
  await sendCsv(res, "cleaner", "Cleaned", String(req.params.which));
});

convertRouter.post("/cleaner/lists", jsonOnly, async (req, res) => {
  const b = req.body as { tenantId?: string; dryRun?: boolean; prefix?: string; undo?: boolean };
  if (getState().status !== "configured-ok") return fail(res, new Error("Connect a tenant to create site lists."), 409);
  try {
    const dataDir = getState().dataDir;
    if (b.undo) {
      const rec = await lastListsRecord(dataDir, "cleaner");
      if (!rec) return fail(res, new Error("Nothing to undo."));
      return res.json(await undoLists(dataDir, contextFor(rec.tenantId).client, "cleaner"));
    }
    const ctx = contextFor(String(b.tenantId ?? "self"));
    const run = await getRun(dataDir, "cleaner");
    if (!run) return fail(res, new Error("Classify a list first."), 409);
    const prefix = (b.prefix?.trim() || "Cleaned").slice(0, 80);
    if (b.dryRun !== false) return res.json(await planLists(ctx.client, ctx.tenantId, withDecisions(run), prefix));
    res.json(await createLists(dataDir, ctx.client, ctx.tenantId, "cleaner", withDecisions(run), prefix));
  } catch (err) {
    fail(res, err);
  }
});

// ---------- design ----------

function choicesPath(tenantId: string): string {
  return path.join(getState().dataDir, "design", `${tenantId}.json`);
}

async function genAiChoices(tenantId: string): Promise<Record<string, FilterAction>> {
  const text = await readText(choicesPath(tenantId), "design").catch(() => null);
  return text ? (JSON.parse(text) as { genAi: Record<string, FilterAction> }).genAi ?? {} : {};
}

convertRouter.get("/design/:tenantId", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    const genAi = await genAiChoices(ctx.tenantId);
    const { design } = await designFor(getState().dataDir, ctx, genAi);
    res.json({ design, genAi });
  } catch (err) {
    fail(res, err, 502);
  }
});

convertRouter.put("/design/:tenantId", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  const genAi = Object.fromEntries(
    Object.entries((req.body as { genAi?: Record<string, string> }).genAi ?? {}).filter(([, v]) => ACTIONS.includes(v as FilterAction)),
  ) as Record<string, FilterAction>;
  const file = choicesPath(ctx.tenantId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await saveFile(file, JSON.stringify({ genAi }), { section: "design", mode: 0o600 });
  const { design } = await designFor(getState().dataDir, ctx, genAi);
  res.json({ design, genAi });
});

/** Who the pilot can go to: user groups, device groups, and devices with their eligibility. */
convertRouter.get("/pilot-targets/:tenantId", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    const api = new ReadOnlyApi(ctx.client);
    const [userGroups, endpointGroups, endpoints] = await Promise.all([
      listUserGroups(api, ctx.tenantId),
      listEndpointGroups(api, ctx.tenantId),
      listAllEndpoints(api, ctx.tenantId),
    ]);
    res.json({
      userGroups: userGroups.map((g) => ({ id: g.id, name: g.name, members: g.users?.total ?? null })),
      endpointGroups: endpointGroups.map((g) => ({ id: g.id, name: g.name, type: g.type, members: g.endpoints?.total ?? null })),
      endpoints: endpoints
        .map((d) => ({ ...deviceEligibility(d), person: (d as { associatedPerson?: { name?: string } }).associatedPerson?.name ?? null }))
        .filter((d) => d.platform !== "linux")
        .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.hostname.localeCompare(b.hostname)),
    });
  } catch (err) {
    fail(res, err, 502);
  }
});

// ---------- build, rollback, diff ----------

function pilotFrom(body: unknown): PilotOptions {
  const b = (body ?? {}) as Partial<PilotOptions> & { targets?: Record<string, unknown> };
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)) : []);
  return {
    profileKey: String(b.profileKey ?? ""),
    name: typeof b.name === "string" ? b.name : undefined,
    enabled: b.enabled !== false,
    targets: { users: ids(b.targets?.users), userGroups: ids(b.targets?.userGroups), endpoints: ids(b.targets?.endpoints), endpointGroups: ids(b.targets?.endpointGroups) },
  };
}

convertRouter.get("/build/:tenantId", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  res.json({ items: await listBuilds(getState().dataDir, ctx.tenantId) });
});

convertRouter.get("/build/:tenantId/:buildId", async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await getBuild(getState().dataDir, ctx.tenantId, String(req.params.buildId)));
  } catch (err) {
    fail(res, err, 404);
  }
});

convertRouter.post("/build/:tenantId/dry-run", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await dryRun(getState().dataDir, ctx, pilotFrom(req.body)));
  } catch (err) {
    fail(res, err);
  }
});

const building = new Set<string>();
convertRouter.post("/build/:tenantId/execute", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  if (building.has(ctx.tenantId)) return fail(res, new Error("A build is already running for this tenant."), 409);
  building.add(ctx.tenantId);
  try {
    res.json(await execute(getState().dataDir, ctx, pilotFrom(req.body), TOOL()));
  } catch (err) {
    fail(res, err, 502);
  } finally {
    building.delete(ctx.tenantId);
  }
});

convertRouter.post("/build/:tenantId/:buildId/rollback", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    res.json(await rollback(getState().dataDir, ctx, String(req.params.buildId), { dryRun: (req.body as { dryRun?: boolean }).dryRun !== false }));
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/diff/:tenantId { snapshotFile? } compares the tenant now with a snapshot (the latest when none is named). */
convertRouter.post("/diff/:tenantId", jsonOnly, async (req, res) => {
  const ctx = ctxOr404(req, res);
  if (!ctx) return;
  try {
    let file = (req.body as { snapshotFile?: string }).snapshotFile;
    if (!file) file = (await listSnapshots(getState().dataDir, ctx.tenantId))[0]?.file;
    if (!file) return fail(res, new Error("No snapshot for this tenant yet."), 409);
    res.json(await diffWithSnapshot(getState().dataDir, ctx, file, TOOL()));
  } catch (err) {
    fail(res, err, 502);
  }
});
