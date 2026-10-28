/**
 * Unified JSON error response for uncaught route errors.
 */

import type { Request, Response, NextFunction } from "express";
import { log, maskSecrets } from "../log.js";

/** The error code for each status a request the server couldn't read gets. */
const CLIENT_CODES: Record<number, string> = { 400: "bad_request", 413: "payload_too_large", 415: "unsupported_media_type" };
/** A plain message for each body-parser error type. Its own message can quote the body, so it is never sent or logged. */
const CLIENT_MESSAGES: Record<string, string> = {
  "entity.parse.failed": "The request body isn't valid JSON.",
  "entity.too.large": "The request body is too large.",
  "charset.unsupported": "Send JSON in UTF-8.",
  "encoding.unsupported": "The request body's content encoding isn't supported.",
};

/** The 4xx status body-parser (or http-errors) set on an error the request caused, or undefined for any other error. */
function clientError(err: unknown): { status: number; type?: string } | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown; expose?: unknown };
  const status = e.status ?? e.statusCode;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 499) return undefined;
  const type = typeof e.type === "string" ? e.type : undefined;
  return type || e.expose === true ? { status, type } : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const client = clientError(err);
  if (client) {
    log.warn(`[${req.method} ${req.path}] ${client.status} ${client.type ?? "unreadable request"}`);
    if (res.headersSent) return;
    const message = (client.type && CLIENT_MESSAGES[client.type]) || "The request body couldn't be read.";
    res.status(client.status).json({ error: CLIENT_CODES[client.status] ?? "bad_request", message });
    return;
  }
  const message = maskSecrets(err instanceof Error ? err.message : String(err));
  log.error(`[${req.method} ${req.path}] ${message}`);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error", message });
}
