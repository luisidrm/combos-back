import { Router } from 'express';
import { requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { isSessionEmailVerified } from '../../core/middleware/verified-email.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { currentUser, requireParam } from '../../core/request.js';
import { inviteMemberSchema, memberIdParamSchema, updateMeSchema, updateMemberSchema } from './identity.schema.js';
import { identityService } from './identity.service.js';

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
      locale: user.locale,
      // False for a buyer who has no phone yet (a new Google account): the web app then asks for it before an order.
      profileComplete: identityService.isProfileComplete(user),
      emailVerified: await isSessionEmailVerified(req),
    });
  } catch (err) {
    next(err);
  }
});

// The person's own details: the language their emails come in (the site's language is chosen in the URL; this is what we
// write to them), and the name and phone we keep for them.
identityRouter.patch('/me', resolveTenant, requireAuth, validate({ body: updateMeSchema }), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const updated = await identityService.updateProfile(req.tenantId, user.id, req.body);
    res.json({ locale: updated.locale, fullName: updated.fullName, phone: updated.phone, profileComplete: identityService.isProfileComplete(updated) });
  } catch (err) {
    next(err);
  }
});

// --- the team: admin, staff and couriers (admin only) -----------------------------------

const adminOnly = [resolveTenant, requireAuth, requireRole('admin')];

// Everyone who works for the store, disabled accounts included (so they can be turned back on).
identityRouter.get('/team', ...adminOnly, async (req, res, next) => {
  try {
    res.json(await identityService.listTeam(req.tenantId));
  } catch (err) {
    next(err);
  }
});

// Adds a person. Without a password they are emailed a link to choose their own.
identityRouter.post('/team', ...adminOnly, validate({ body: inviteMemberSchema }), async (req, res, next) => {
  try {
    res.status(201).json(await identityService.inviteMember(req.tenantId, req.body));
  } catch (err) {
    next(err);
  }
});

// Change a role or turn an account on or off. Not your own, and never the last admin.
identityRouter.patch('/team/:id', ...adminOnly, validate({ params: memberIdParamSchema, body: updateMemberSchema }), async (req, res, next) => {
  try {
    const actor = await currentUser(req);
    res.json(await identityService.updateMember(req.tenantId, actor.id, requireParam(req, 'id'), req.body));
  } catch (err) {
    next(err);
  }
});

// Sends the "choose your password" link again.
identityRouter.post('/team/:id/invite', ...adminOnly, validate({ params: memberIdParamSchema }), async (req, res, next) => {
  try {
    await identityService.resendInvite(req.tenantId, requireParam(req, 'id'));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
