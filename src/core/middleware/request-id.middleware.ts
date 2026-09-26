import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger.js';
import { runWithRequestId } from '../request-context.js';
import { routeLabel } from './metrics.middleware.js';

// Only accept an id from upstream if it looks like one — it ends up in logs
// and a response header, so an arbitrary value would be log injection.
const ACCEPTABLE_ID = /^[A-Za-z0-9-]{8,64}$/;

// Assigns every request an id (or keeps the proxy's), returns it as
// `x-request-id`, and runs the rest of the request inside it so the logger and
// the event bus pick it up automatically. Also logs one line per finished
// request — by route pattern, never the raw URL, so ids, slugs and query
// strings (which can hold personal data) stay out of the log.
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && ACCEPTABLE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', id);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const route = routeLabel(req) ?? '(unmatched)';
    logger.info(
      {
        method: req.method,
        route,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      },
      'request',
    );
  });

  runWithRequestId(id, () => next());
}
