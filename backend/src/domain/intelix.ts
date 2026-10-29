/**
 * SophosLabs Intelix URL Category Lookup client, built from the published
 * docs (https://api.labs.sophos.com/doc/, URL lookup v1.6.x):
 *
 *   token   POST https://api.labs.sophos.com/oauth2/token, Basic auth with the
 *           client id and secret, body grant_type=client_credentials; the token
 *           lasts 3600 s. The auth endpoint is the same for every region.
 *   lookup  GET https://{de|us|au}.api.labs.sophos.com/lookup/urls/v1/{url},
 *           the URL percent-encoded, Authorization: <token> (no "Bearer").
 *           Billed per 200. 5,000 requests a minute.
 *
 * It uses fetch and nothing else, so it runs in the server and in the static
 * site list cleaner page. Tested live on 13/10/2026: the token call, lookups
 * in all three regions (a credential isn't tied to one), the field mapping,
 * and a refused credential.
 *
 * Pure: no Node or browser imports; fetch is injected or global.
 */

import { INTELIX_TO_PROFILE, INTELIX_SECURITY_CATEGORIES } from "./categories-data.js";

export type IntelixRegion = "au" | "de" | "us";
export const INTELIX_REGIONS: IntelixRegion[] = ["au", "de", "us"];
export const INTELIX_AUTH_URL = "https://api.labs.sophos.com/oauth2/token";

export interface IntelixConfig {
  clientId: string;
  clientSecret: string;
  region: IntelixRegion;
  fetchImpl?: typeof fetch;
  /** Waits between retries; tests shorten them. */
  sleep?: (ms: number) => Promise<void>;
}

export interface IntelixLookup {
  url: string;
  productivityCategory?: string;
  productivityScore?: number;
  securityCategory?: string;
  securityScore?: number;
  riskLevel?: string;
  /** The profile category the productivity category maps to. */
  profileCategory?: string;
  /** True when securityCategory names a threat (anything but SEC_UNCATEGORIZED). */
  securityRisk: boolean;
  requestId?: string;
}

export class IntelixError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IntelixError";
  }
}

/**
 * Intelix calls go out with redirect: "manual", and a redirect is refused
 * instead of followed: following it sends the request again, with the
 * credential or the token, to another address. In a browser a redirect not
 * followed reads as type "opaqueredirect" with status 0; in Node it keeps its
 * 3xx status.
 */
function refuseRedirect(res: Response): void {
  if (res.type !== "opaqueredirect" && (res.status < 300 || res.status > 399)) return;
  throw new IntelixError(
    `Intelix answered with a redirect${res.status ? ` (${res.status})` : ""}. Redirects are never followed, so nothing was sent there.`,
    res.status || undefined,
  );
}

function base64(text: string): string {
  if (typeof btoa === "function") return btoa(text);
  throw new Error("No base64 encoder available.");
}

/**
 * True when SophosLabs files a site under a threat: phishing, malware, spam
 * or a potentially unwanted application. SEC_UNCATEGORIZED and
 * SEC_TRUSTED_UPDATE_SITE (seen live for sophos.com, 13/10/2026) aren't.
 */
export function isSecurityRisk(securityCategory: string | undefined): boolean {
  if (!securityCategory || securityCategory === "SEC_UNCATEGORIZED" || securityCategory.startsWith("SEC_TRUSTED")) return false;
  return INTELIX_SECURITY_CATEGORIES.includes(securityCategory) || /^SEC_(ILLEGAL|MALWARE|SPAM|PUA)_/.test(securityCategory);
}

/** Addresses the docs say always come back uncategorized, so a lookup would only cost money. */
export function notWorthLookingUp(host: string): boolean {
  if (!host.includes(".")) return true;
  if (/\.(local|localhost|localdomain|internal|lan|corp|home|intranet)$/i.test(host)) return true;
  const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return false;
}

/**
 * Whether a parsed entry is worth a paid lookup: one site or address with a
 * public name. A range (CIDR), a whole top-level domain and private or
 * internal names aren't.
 */
export function worthALookup(site: { kind: string; host: string; value: string }): boolean {
  if (!site.value || !site.host) return false;
  if (site.kind === "cidr4" || site.kind === "cidr6" || site.kind === "tld" || site.kind === "invalid") return false;
  return !notWorthLookingUp(site.host);
}

export class IntelixClient {
  private token: string | null = null;
  private expiresAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  lookups = 0;

  constructor(private readonly config: IntelixConfig) {
    if (!INTELIX_REGIONS.includes(config.region)) throw new IntelixError(`Unknown Intelix region "${config.region}". Use au, de or us.`);
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** A valid token, fetched again 60 s before it runs out. */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const res = await this.fetchImpl(INTELIX_AUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64(`${this.config.clientId}:${this.config.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      redirect: "manual",
    });
    refuseRedirect(res);
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      throw new IntelixError(`Intelix refused the credential (${res.status}${body.error ? `: ${body.error}` : ""}).`, res.status);
    }
    this.token = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  /** Looks up one URL or host. Retries a 401 once with a new token, and 429 or 5xx up to three times. */
  async lookup(url: string): Promise<IntelixLookup> {
    const endpoint = `https://${this.config.region}.api.labs.sophos.com/lookup/urls/v1/${encodeURIComponent(url)}`;
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await this.getToken();
      const res = await this.fetchImpl(endpoint, { headers: { Authorization: token }, redirect: "manual" });
      refuseRedirect(res);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.token = null;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 3) throw new IntelixError(`Intelix answered ${res.status} after retries.`, res.status);
        await this.sleep(res.status === 429 ? 2000 * (attempt + 1) : 1000 * (attempt + 1));
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new IntelixError(`Intelix answered ${res.status}${body.error ? `: ${String(body.error)}` : ""}.`, res.status);
      this.lookups++;
      const productivityCategory = typeof body.productivityCategory === "string" ? body.productivityCategory : undefined;
      const securityCategory = typeof body.securityCategory === "string" ? body.securityCategory : undefined;
      return {
        url,
        productivityCategory,
        productivityScore: typeof body.productivityScore === "number" ? body.productivityScore : undefined,
        securityCategory,
        securityScore: typeof body.securityScore === "number" ? body.securityScore : undefined,
        riskLevel: typeof body.riskLevel === "string" ? body.riskLevel : undefined,
        profileCategory: productivityCategory ? INTELIX_TO_PROFILE[productivityCategory] : undefined,
        securityRisk: isSecurityRisk(securityCategory),
        requestId: typeof body.requestId === "string" ? body.requestId : undefined,
      };
    }
    throw new IntelixError("Intelix lookup failed.");
  }
}
