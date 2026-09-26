import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config/index.js';
import { NotFoundError, UnauthorizedError } from '../errors.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// /metrics lists every route and its traffic — useful to an operator, and
// reconnaissance for anyone else. With METRICS_TOKEN set it needs
// `Authorization: Bearer <token>`. Without one it stays open in development
// and is switched off in production, rather than silently public.
export function metricsGuard(req: Request, _res: Response, next: NextFunction): void {
  const token = config.metricsToken;
  if (!token) {
    next(config.isProduction ? new NotFoundError('Not found') : undefined);
    return;
  }

  const header = req.header('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!provided || !timingSafeEqual(digest(provided), digest(token))) {
    next(new UnauthorizedError('Missing or invalid metrics token'));
    return;
  }
  next();
}

// The label a request is counted under. The matched route pattern
// ("/catalog/products/:slug"), never the raw URL: a raw path makes every
// distinct slug — and every random URL a scanner tries — its own permanent
// time series, which grows without bound. Unmatched requests share one label.
export function metricsRoute(req: Request): string {
  return routeLabel(req) ?? 'unmatched';
}

// "/catalog/products/:slug": the router's mount point plus the route pattern.
// Express resets `req.baseUrl` once the request leaves a router, and by the
// time a response has finished it is empty — so the mount point is recorded
// in res.locals when the router is entered (see `mount` in app.ts) instead.
export function routeLabel(req: Request): string | undefined {
  if (!req.route?.path) return undefined;
  const mountPath = (req.res?.locals as { mountPath?: string } | undefined)?.mountPath ?? req.baseUrl;
  // A route registered under several paths at once (the login rate limiter)
  // has an array as its pattern; the request matched exactly one of them, so
  // that is the honest label — and still a fixed, small set.
  const pattern = Array.isArray(req.route.path) ? req.path : req.route.path;
  return `${mountPath}${pattern}`;
}
