import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../config/logger.js';

const logger = createLogger('api/request');

/**
 * Logs one structured entry per REST request once the response finishes:
 * method, path, status, and duration. The query string is deliberately left
 * out (and request bodies are never logged) so codes and tokens can't leak
 * into logs. 5xx responses log at `error`, 4xx at `warn`, the rest at `info`.
 *
 * Mount it ahead of the body parser so requests rejected there (malformed
 * JSON) are still recorded.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
}
