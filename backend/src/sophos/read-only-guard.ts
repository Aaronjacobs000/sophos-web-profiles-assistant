/**
 * Read-only mode. With READ_ONLY=1 (in the environment or the .env file) the
 * tool refuses every request to a Sophos host that isn't a GET or HEAD,
 * before it leaves the computer. The two token endpoints are the only
 * exceptions: Sophos ID, which every API call needs, and SophosLabs Intelix,
 * which isn't a tenant. Use it to look at a customer's tenant without any
 * chance of changing it.
 *
 * It works at two levels: the Sophos client checks each request, and
 * installFetchGuard() wraps the process's fetch, so a request that doesn't go
 * through the client is refused too.
 */

export const TOKEN_ENDPOINTS = ["https://id.sophos.com/api/v2/oauth2/token", "https://api.labs.sophos.com/oauth2/token"];

export class ReadOnlyModeError extends Error {
  constructor(method: string, url: string) {
    let where = url;
    try {
      const u = new URL(url);
      where = `${u.hostname}${u.pathname}`;
    } catch {
      // keep the raw text
    }
    super(`Read-only mode (READ_ONLY=1) refused ${method} ${where} before it was sent.`);
    this.name = "ReadOnlyModeError";
  }
}

export function readOnlyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.READ_ONLY ?? "").trim());
}

/** Throws when read-only mode is on and this request would change something at Sophos. */
export function guardRequest(url: string, method: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!readOnlyMode(env)) return;
  const m = String(method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ReadOnlyModeError(m, url);
  }
  if (!/(^|\.)sophos\.com$/i.test(u.hostname)) return;
  if (TOKEN_ENDPOINTS.includes(`${u.origin}${u.pathname}`)) return;
  throw new ReadOnlyModeError(m, url);
}

type FetchFn = typeof fetch;
const GUARDED = Symbol.for("web-profiles-assistant.read-only-guard");

/** Wraps the global fetch so every request is checked. Safe to call twice. */
export function installFetchGuard(target: { fetch: FetchFn } = globalThis as unknown as { fetch: FetchFn }): void {
  const current = target.fetch as FetchFn & { [GUARDED]?: true };
  if (current[GUARDED]) return;
  const inner = current;
  const guarded = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
    try {
      guardRequest(url, method);
    } catch (err) {
      // Like fetch itself, fail with a rejected promise.
      return Promise.reject(err);
    }
    return inner(input, init);
  }) as FetchFn & { [GUARDED]?: true };
  guarded[GUARDED] = true;
  target.fetch = guarded;
}
