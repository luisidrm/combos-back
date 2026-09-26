import { Router } from 'express';
import { requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { requireParam } from '../../core/request.js';
import { createDeliveryZoneSchema, idParamSchema, updateDeliveryZoneSchema } from './geo.schema.js';
import { geoService } from './geo.service.js';

export const geoRouter = Router();

// Cuba's provinces and municipalities are the same for every store and
// change roughly never, so these need no tenant header and can be cached.
const REFERENCE_DATA_CACHE = 'public, max-age=86400';

geoRouter.get('/provinces', async (_req, res, next) => {
  try {
    res.set('Cache-Control', REFERENCE_DATA_CACHE).json(await geoService.listProvinces());
  } catch (err) {
    next(err);
  }
});

geoRouter.get('/provinces/:id/municipalities', validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    res.set('Cache-Control', REFERENCE_DATA_CACHE).json(await geoService.listMunicipalities(requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

// Public: the storefront shows where this store delivers and at what fee.
geoRouter.get('/delivery-zones', resolveTenant, async (req, res, next) => {
  try {
    res.json(await geoService.listPublicZones(req.tenantId));
  } catch (err) {
    next(err);
  }
});

const adminOnly = [resolveTenant, requireAuth, requireRole('admin')];

geoRouter.get('/admin/delivery-zones', ...adminOnly, async (req, res, next) => {
  try {
    res.json(await geoService.listZonesForAdmin(req.tenantId));
  } catch (err) {
    next(err);
  }
});

geoRouter.post('/delivery-zones', ...adminOnly, validate({ body: createDeliveryZoneSchema }), async (req, res, next) => {
  try {
    res.status(201).json(await geoService.createZone(req.tenantId, req.body));
  } catch (err) {
    next(err);
  }
});

geoRouter.patch(
  '/delivery-zones/:id',
  ...adminOnly,
  validate({ params: idParamSchema, body: updateDeliveryZoneSchema }),
  async (req, res, next) => {
    try {
      res.json(await geoService.updateZone(req.tenantId, requireParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);
