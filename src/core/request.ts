import type { Request } from 'express';
import type { SessionRequest } from 'supertokens-node/framework/express/index.js';
import { UnauthorizedError, ValidationError } from './errors.js';
import type { User } from '../modules/identity/index.js';

// Express 5's route-param typing allows undefined (or string[]) for a
// segment that, at runtime, is always a single string once the route has
// matched — this narrows it without a bare non-null assertion.
export function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (!value || Array.isArray(value)) {
    throw new ValidationError(`Missing required route parameter "${name}"`);
  }
  return value;
}

// The signed-in caller as our own `users` row. SuperTokens only knows its
// own id; every module stores our internal users.id, so routes that act "as
// the buyer" translate once here. Only call after requireAuth (or after
// optionalAuth, when a guest is possible — see currentUserOrUndefined).
export async function currentUser(req: Request): Promise<User> {
  // requireAuth / optionalAuth already loaded this fresh on the request.
  if (req.authUser) {
    return req.authUser;
  }
  const session = (req as SessionRequest).session;
  if (!session) {
    throw new UnauthorizedError('No session on request');
  }
  // Loaded at call time to avoid an import cycle with the identity module.
  const { identityService } = await import('../modules/identity/index.js');
  return identityService.getBySupertokensUserId(req.tenantId, session.getUserId());
}

// For optionalAuth routes: undefined means "a guest".
export async function currentUserOrUndefined(req: Request): Promise<User | undefined> {
  return req.authUser;
}
