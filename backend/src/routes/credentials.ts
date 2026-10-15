/**
 * Viewing, testing and saving the one credential the tool uses: a tenant
 * credential (a customer) or a partner or organization credential (an
 * estate). Secrets are only ever returned masked.
 */

import { Router } from "express";
import { getCredentialsView, getStatusPayload, saveCredentials } from "../state.js";
import { createPartnerContext, createTenantContext } from "../sophos/tenant-context.js";
import { jsonBody } from "../middleware/json-body.js";
import { clearReadinessCache } from "../services/readiness.js";
import { resetEstate } from "../services/estate.js";
import { log, maskSecrets } from "../log.js";
import { EnvValueError } from "../config/env-file.js";

export const credentialsRouter = Router();

credentialsRouter.get("/credentials", (_req, res) => {
  res.json(getCredentialsView());
});

/** "Sophos auth failed (401): {json}" as "Sophos refused the credential (401): Client ID is invalid." */
export function friendlyAuthError(message: string): string {
  const m = /^Sophos auth failed \((\d+)\): (.*)$/s.exec(message);
  if (!m) return message;
  let detail = m[2]!.trim();
  try {
    const body = JSON.parse(detail) as { message?: string; error?: string; errorCode?: string };
    detail = body.message ?? body.error ?? body.errorCode ?? detail;
  } catch {
    // Not JSON: keep the text.
  }
  return `Sophos refused the credential (${m[1]}): ${detail.replace(/\.?$/, ".")}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}

/** PUT /api/credentials { mode: "tenant" | "partner", clientId, clientSecret?, label? } */
credentialsRouter.put("/credentials", jsonBody, async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const mode = body.mode === "partner" ? "partner" : "tenant";
  const clientId = str(body.clientId);
  const clientSecret = str(body.clientSecret);
  if (!clientId) {
    res.status(400).json({ error: "bad_request", message: "A Client ID is required." });
    return;
  }
  try {
    // An empty secret keeps the saved one, so the label can change without retyping it.
    await saveCredentials(mode, { clientId, clientSecret: clientSecret || undefined, label: str(body.label) ?? "" });
    clearReadinessCache();
    resetEstate();
  } catch (err) {
    if (err instanceof EnvValueError) {
      res.status(400).json({ error: "bad_request", message: maskSecrets(err.message) });
      return;
    }
    log.error("[credentials:PUT] save failed", err);
    res.status(500).json({ error: "save_failed", message: maskSecrets(err instanceof Error ? err.message : String(err)) });
    return;
  }
  res.json({ ok: true, status: getStatusPayload() });
});

/** POST /api/credentials/test: checks a credential without saving it. */
credentialsRouter.post("/credentials/test", jsonBody, async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const mode = body.mode === "partner" ? "partner" : "tenant";
  const clientId = str(body.clientId);
  const clientSecret = str(body.clientSecret);
  if (!clientId || !clientSecret) {
    res.status(400).json({ error: "bad_request", message: "Client ID and Client Secret are both required." });
    return;
  }
  try {
    if (mode === "partner") {
      const p = await createPartnerContext({ clientId, clientSecret });
      res.json({ ok: true, idType: p.identity.idType, tenantCount: p.tenants.length });
    } else {
      const t = await createTenantContext({ clientId, clientSecret, label: str(body.label) });
      res.json({ ok: true, idType: "tenant", tenant: t.summary });
    }
  } catch (err) {
    const message = friendlyAuthError(maskSecrets(err instanceof Error ? err.message : String(err)));
    log.warn(`[credentials:test] ${message}`);
    res.status(400).json({ ok: false, error: "auth_failed", message });
  }
});
