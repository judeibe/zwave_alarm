import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async Express handler so a rejected promise reaches the error
 * middleware via `next(err)`. Confirmed via a standalone repro against this
 * project's installed express@5.2.1 that a throw inside an `async` handler
 * is *not* auto-forwarded — the process crashes with an uncaught exception
 * instead of the error middleware ever running — so every async route
 * handler in this codebase (panel-routes.ts's arm/disarm) must go through
 * this rather than relying on Express 5's documented-but-not-actually-firing
 * async error forwarding.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
