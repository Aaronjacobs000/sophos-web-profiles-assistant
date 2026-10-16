/**
 * Express 4 hands an error to the error handler only when a route throws
 * before it returns. A route that awaits something and then fails returns a
 * rejected promise, which Express leaves unhandled, and on Node 20 and later
 * an unhandled rejection stops the server. Each route catches its own
 * failures; this is the net under them: every handler on a router passes a
 * rejected promise to the error handler, which answers with a JSON error.
 */

import type { NextFunction, Request, Response, Router } from "express";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
interface Layer {
  handle: Handler;
  route?: { stack: Layer[] };
}

function guarded(handle: Handler): Handler {
  // Four arguments make an error handler, which Express calls only with an error: left as it is.
  if (handle.length > 3) return handle;
  return function (req, res, next) {
    let out: unknown;
    try {
      out = handle(req, res, next);
    } catch (err) {
      next(err);
      return undefined;
    }
    if (out && typeof (out as Promise<unknown>).then === "function") (out as Promise<unknown>).then(undefined, next);
    return out;
  };
}

/** Wraps every route and middleware already on the router. Call it once its routes are defined. */
export function catchRouteRejections(router: Router): Router {
  for (const layer of router.stack as unknown as Layer[]) {
    if (layer.route) for (const step of layer.route.stack) step.handle = guarded(step.handle);
    else layer.handle = guarded(layer.handle);
  }
  return router;
}
