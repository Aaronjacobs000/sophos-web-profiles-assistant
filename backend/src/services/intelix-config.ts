/**
 * The optional SophosLabs Intelix credential: INTELIX_CLIENT_ID,
 * INTELIX_CLIENT_SECRET and INTELIX_REGION (au, de or us) in .env. Without it
 * the clean-up step still runs DNS checks and takes decisions by hand.
 */

import { getEnvValue, readEnvFile, setEnvValues, writeEnvFile } from "../config/env-file.js";
import { maskSecret } from "../config/validate.js";
import { IntelixClient, INTELIX_REGIONS, type IntelixRegion } from "../domain/intelix.js";
import { getState } from "../state.js";
import { registerSecret } from "../log.js";

export interface IntelixSettings {
  clientId: string;
  clientSecret: string;
  region: IntelixRegion;
}

export function intelixSettings(): IntelixSettings | null {
  const env = getState().envFile;
  const clientId = getEnvValue(env, "INTELIX_CLIENT_ID")?.trim() ?? "";
  const clientSecret = getEnvValue(env, "INTELIX_CLIENT_SECRET")?.trim() ?? "";
  const region = (getEnvValue(env, "INTELIX_REGION")?.trim() || "au") as IntelixRegion;
  if (!clientId || !clientSecret) return null;
  registerSecret(clientSecret);
  return { clientId, clientSecret, region: INTELIX_REGIONS.includes(region) ? region : "au" };
}

export function intelixView(): { configured: boolean; clientId: string; clientSecretMasked: string; region: IntelixRegion } {
  const s = intelixSettings();
  return s
    ? { configured: true, clientId: s.clientId, clientSecretMasked: maskSecret(s.clientSecret), region: s.region }
    : { configured: false, clientId: "", clientSecretMasked: "", region: "au" };
}

export function intelixClient(): IntelixClient | null {
  const s = intelixSettings();
  return s ? new IntelixClient(s) : null;
}

export async function saveIntelix(update: { clientId?: string; clientSecret?: string; region?: string }): Promise<void> {
  const st = getState();
  const current = await readEnvFile(st.envPath);
  const region = update.region && INTELIX_REGIONS.includes(update.region as IntelixRegion) ? update.region : undefined;
  const next = setEnvValues(current, {
    INTELIX_CLIENT_ID: update.clientId,
    INTELIX_CLIENT_SECRET: update.clientSecret || undefined,
    INTELIX_REGION: region,
  });
  await writeEnvFile(next);
  st.envFile = await readEnvFile(st.envPath);
}
