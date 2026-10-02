import { Router } from 'express';
import { requireAuth } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { isSessionEmailVerified } from '../../core/middleware/verified-email.middleware.js';
import { currentUser } from '../../core/request.js';

export const identityRouter = Router();

// requireAuth has just re-read the caller's users row (and rejected a
// disabled or demoted one), so this returns current data, not a token's.
identityRouter.get('/me', resolveTenant, requireAuth, async (req, res, next) => {
  try {
    const user = await currentUser(req);
    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      phone: user.phone,
      emailVerified: await isSessionEmailVerified(req),
    });
  } catch (err) {
    next(err);
  }
});
