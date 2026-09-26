import { Router } from 'express';
import { requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { requirePlatformKey } from '../../core/middleware/platform.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { createTenantSchema, updateTenantSchema } from './tenancy.schema.js';
import { tenancyService } from './tenancy.service.js';

export const tenancyRouter = Router();

// Creating a store is a platform operation, not something a store's own
// admin (or the public) may do. Until a platform-admin role exists (M7) it is
// gated by a shared secret from the environment; with none configured it is
// simply off.
tenancyRouter.post('/', requirePlatformKey, validate({ body: createTenantSchema }), async (req, res, next) => {
  try {
    const tenant = await tenancyService.createTenant(req.body);
    res.status(201).json(tenant);
  } catch (err) {
    next(err);
  }
});

// Public: the storefront header — name, tagline, description, logo.
tenancyRouter.get('/current', resolveTenant, async (req, res, next) => {
  try {
    res.json(await tenancyService.getPublicStore(req.tenantId));
  } catch (err) {
    next(err);
  }
});

const adminOnly = [resolveTenant, requireAuth, requireRole('admin')];

tenancyRouter.patch('/current', ...adminOnly, validate({ body: updateTenantSchema }), async (req, res, next) => {
  try {
    res.json(await tenancyService.updateStore(req.tenantId, req.body));
  } catch (err) {
    next(err);
  }
});

tenancyRouter.get('/admin/settings', ...adminOnly, async (req, res, next) => {
  try {
    res.json(await tenancyService.getSettings(req.tenantId));
  } catch (err) {
    next(err);
  }
});
