import type { NextFunction, Request, Response } from 'express';
import type { SessionRequest } from 'supertokens-node/framework/express/index.js';
import EmailVerification from 'supertokens-node/recipe/emailverification';
import { ForbiddenError } from '../errors.js';

// Whether the signed-in person has confirmed their email. Asked of SuperTokens
// each time (not read from the access token), for the same reason requireAuth
// re-reads the users row: a token only says what was true at login, and a buyer
// who confirms their email mid-session should not have to sign in again.
// Must run after requireAuth.
export async function isSessionEmailVerified(req: Request): Promise<boolean> {
  const session = (req as SessionRequest).session;
  if (!session || !req.authUser) {
    return false;
  }
  return EmailVerification.isEmailVerified(session.getRecipeUserId(), req.authUser.email);
}

// Gate for actions that need a confirmed address (placing an order). The
// machine-readable `details.reason` lets the UI show "confirm your email"
// instead of a generic error.
export async function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (await isSessionEmailVerified(req)) {
      next();
      return;
    }
    next(new ForbiddenError('Confirm your email address to continue', { reason: 'EMAIL_NOT_VERIFIED' }));
  } catch (err) {
    next(err);
  }
}
