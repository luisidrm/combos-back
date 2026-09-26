import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifySession } from 'supertokens-node/recipe/session/framework/express/index.js';
import type { SessionRequest } from 'supertokens-node/framework/express/index.js';
import type { User } from '../../modules/identity/index.js';
import { ForbiddenError } from '../errors.js';

// tenantId and role live in the session's access token claims (CLAUDE.md
// section 7), set at login in core/supertokens.ts. The token alone proves who
// someone WAS at login, not what they are now: an account disabled or demoted
// afterwards would keep working until its token expired. So on every
// authenticated request the caller's `users` row is read again (one indexed
// lookup) and it, not the token, has the last word.

export interface AuthDeps {
  // SuperTokens' verifySession, in its required and optional forms. Injected
  // so the rules below can be tested with a fake session instead of a live
  // SuperTokens core.
  verify: RequestHandler;
  verifyOptional: RequestHandler;
  loadUser: (tenantId: string, supertokensUserId: string) => Promise<User | undefined>;
}

// Why a session isn't good for this request, or undefined if it is.
type Rejection = { message: string; reason: string } | undefined;

async function checkSession(req: Request, deps: AuthDeps): Promise<{ user?: User; rejection?: Rejection }> {
  const session = (req as SessionRequest).session;
  if (!session) {
    return { rejection: { message: 'No session', reason: 'NO_SESSION' } };
  }

  const payload = session.getAccessTokenPayload() as { tenantId?: string; role?: string } | undefined;

  // SuperTokens users are global, so without this a session (and its `admin`
  // role) from one store would be accepted against another store's
  // x-tenant-slug.
  if (!payload?.tenantId || payload.tenantId !== req.tenantId) {
    return { rejection: { message: 'This session does not belong to this store', reason: 'WRONG_STORE' } };
  }

  const user = await deps.loadUser(req.tenantId, session.getUserId());
  if (!user) {
    return { rejection: { message: 'No account for this session in this store', reason: 'NO_ACCOUNT' } };
  }
  if (user.deletedAt) {
    return { rejection: { message: 'This account has been disabled', reason: 'ACCOUNT_DISABLED' } };
  }
  if (payload.role !== user.role) {
    return { rejection: { message: 'Your permissions changed; please log in again', reason: 'SESSION_STALE' } };
  }
  return { user };
}

export function createAuthMiddleware(deps: AuthDeps) {
  // Must run after resolveTenant.
  async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    await deps.verify(req, res, async (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      try {
        const { user, rejection } = await checkSession(req, deps);
        if (!user) {
          next(new ForbiddenError(rejection?.message ?? 'Not allowed', { reason: rejection?.reason }));
          return;
        }
        req.authUser = user;
        next();
      } catch (checkError) {
        next(checkError);
      }
    });
  }

  // For routes that work for guests and logged-in buyers alike (the cart). A
  // valid session for THIS store is used; anything else — no cookie, an
  // expired one, a session from a different store (the same browser can be
  // logged in at two stores), a disabled account — is simply treated as a
  // guest rather than rejected, since browsing must not break over a stale
  // cookie.
  async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    await deps.verifyOptional(req, res, async (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      try {
        if ((req as SessionRequest).session) {
          const { user } = await checkSession(req, deps);
          if (user) {
            req.authUser = user;
          } else {
            (req as SessionRequest).session = undefined;
          }
        }
        next();
      } catch (checkError) {
        next(checkError);
      }
    });
  }

  return { requireAuth, optionalAuth };
}

export const { requireAuth, optionalAuth } = createAuthMiddleware({
  verify: verifySession(),
  verifyOptional: verifySession({ sessionRequired: false }),
  // Loaded at call time, not imported at the top of this file: the identity
  // module's own routes import THIS file, and a static import back would make
  // a cycle in which a route file can see `requireAuth` still undefined,
  // depending on which module happens to load first.
  loadUser: async (tenantId, supertokensUserId) => {
    const { identityService } = await import('../../modules/identity/index.js');
    return identityService.findBySupertokensUserId(tenantId, supertokensUserId);
  },
});

export function requireRole(...allowedRoles: readonly string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // requireAuth has already made authUser current; the token is only a fallback.
    const role =
      req.authUser?.role ?? ((req as SessionRequest).session?.getAccessTokenPayload() as { role?: string } | undefined)?.role;

    if (!role || !allowedRoles.includes(role)) {
      next(new ForbiddenError('Insufficient role for this action'));
      return;
    }

    next();
  };
}
