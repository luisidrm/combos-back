import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config/index.js';
import { ForbiddenError, UnauthorizedError } from '../errors.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// Platform-level operations (creating a store) are not tied to any one
// tenant's admin. Guarded by a shared secret in `x-platform-key`, compared in
// constant time. With PLATFORM_API_KEY unset the operation is disabled
// rather than left open.
export function requirePlatformKey(req: Request, _res: Response, next: NextFunction): void {
  const expected = config.platformApiKey;
  if (!expected) {
    next(new ForbiddenError('This operation is disabled'));
    return;
  }

  const provided = req.header('x-platform-key');
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    next(new UnauthorizedError('Missing or invalid platform key'));
    return;
  }
  next();
}
