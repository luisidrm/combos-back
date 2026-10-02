import { Router, type Request } from 'express';
import { ForbiddenError, ValidationError } from '../../core/errors.js';
import { requireAuth } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import { currentUser, requireParam } from '../../core/request.js';
import {
  mediaIdParamSchema,
  ownerRefSchema,
  publicListQuerySchema,
  reorderMediaSchema,
  requestUploadSchema,
  updateMediaSchema,
  type MediaOwnerType,
} from './media.schema.js';
import { mediaService } from './media.service.js';

export const mediaRouter = Router();

// Who may touch (upload, read the management view of, edit, delete) a
// picture, by what it belongs to:
// - product: admin only.
// - tenant: admin only (the store's own logo). The owner id must be the
//   store itself.
// - delivery: admin, staff or courier (whoever hands the box over).
// - user: only that user (compared by our internal users.id).
// - payment_proof: store staff or admin, or the buyer of that order (the owner id is the order id).
// requireAuth has already re-read the caller from the database, so the role
// here is current, not the one in an old token. RLS confines everything to
// the caller's own store; this decides whether their role/identity permits
// touching THIS owner.
async function authorizeOwnerAccess(req: Request, ownerType: MediaOwnerType, ownerId: string): Promise<void> {
  const caller = await currentUser(req);

  if (ownerType === 'product' && caller.role !== 'admin') {
    throw new ForbiddenError('Only an admin can manage pictures of a product');
  }
  if (ownerType === 'tenant') {
    if (caller.role !== 'admin') {
      throw new ForbiddenError('Only an admin can change the store logo');
    }
    if (ownerId !== req.tenantId) {
      throw new ValidationError("A store's logo belongs to the store itself: ownerId must be the store id");
    }
  }
  if (ownerType === 'delivery' && caller.role === 'buyer') {
    throw new ForbiddenError('Only store staff or a courier can manage a delivery photo');
  }
  if (ownerType === 'user' && caller.id !== ownerId) {
    throw new ForbiddenError('You can only manage your own profile picture');
  }
  if (ownerType === 'payment_proof') {
    if (caller.role === 'courier') {
      throw new ForbiddenError('A courier cannot see payment proofs');
    }
    if (caller.role === 'buyer') {
      // A buyer may only touch the screenshots of their own order (404 otherwise). Loaded at call
      // time: orders already depends on media's service, so a static import would make a cycle.
      const { ordersService } = await import('../orders/index.js');
      await ordersService.getOrderForBuyer(req.tenantId, caller.id, ownerId);
    }
  }
}

// --- upload flow ----------------------------------------------------------

// Step 1: ask permission. Returns a form-POST target for the browser.
mediaRouter.post('/upload-url', resolveTenant, requireAuth, validate({ body: requestUploadSchema }), async (req, res, next) => {
  try {
    const { ownerType, ownerId, contentType } = req.body;
    await authorizeOwnerAccess(req, ownerType, ownerId);
    const permission = await mediaService.requestUpload({ tenantId: req.tenantId, ownerType, ownerId, contentType });
    res.status(201).json(permission);
  } catch (err) {
    next(err);
  }
});

// Step 2 (after the browser has POSTed the file to MinIO): process it.
mediaRouter.post('/:id/confirm', resolveTenant, requireAuth, validate({ params: mediaIdParamSchema }), async (req, res, next) => {
  try {
    const mediaId = requireParam(req, 'id');
    const row = await mediaService.getById(req.tenantId, mediaId);
    await authorizeOwnerAccess(req, row.ownerType as MediaOwnerType, row.ownerId);
    res.json(await mediaService.confirmUpload(req.tenantId, mediaId));
  } catch (err) {
    next(err);
  }
});

// --- managing pictures ----------------------------------------------------

// Declared before '/:id' routes so "order" and "manage" are never read as ids.
mediaRouter.put('/order', resolveTenant, requireAuth, validate({ body: reorderMediaSchema }), async (req, res, next) => {
  try {
    await authorizeOwnerAccess(req, req.body.ownerType, req.body.ownerId);
    res.json(await mediaService.reorder(req.tenantId, req.body));
  } catch (err) {
    next(err);
  }
});

// Every picture of an owner in every state (pending, ready, failed): what an
// upload screen polls to show progress.
mediaRouter.get('/manage', resolveTenant, requireAuth, validate({ query: ownerRefSchema }), async (req, res, next) => {
  try {
    const { ownerType, ownerId } = req.query as unknown as { ownerType: MediaOwnerType; ownerId: string };
    await authorizeOwnerAccess(req, ownerType, ownerId);
    res.json(await mediaService.listForManagement(req.tenantId, ownerType, ownerId));
  } catch (err) {
    next(err);
  }
});

mediaRouter.get('/:id', resolveTenant, requireAuth, validate({ params: mediaIdParamSchema }), async (req, res, next) => {
  try {
    const mediaId = requireParam(req, 'id');
    const row = await mediaService.getById(req.tenantId, mediaId);
    await authorizeOwnerAccess(req, row.ownerType as MediaOwnerType, row.ownerId);
    res.json(await mediaService.getView(req.tenantId, mediaId));
  } catch (err) {
    next(err);
  }
});

mediaRouter.patch(
  '/:id',
  resolveTenant,
  requireAuth,
  validate({ params: mediaIdParamSchema, body: updateMediaSchema }),
  async (req, res, next) => {
    try {
      const mediaId = requireParam(req, 'id');
      const row = await mediaService.getById(req.tenantId, mediaId);
      await authorizeOwnerAccess(req, row.ownerType as MediaOwnerType, row.ownerId);
      res.json(await mediaService.updateMedia(req.tenantId, mediaId, req.body));
    } catch (err) {
      next(err);
    }
  },
);

mediaRouter.post(
  '/:id/cover',
  resolveTenant,
  requireAuth,
  validate({ params: mediaIdParamSchema, body: ownerRefSchema }),
  async (req, res, next) => {
    try {
      const mediaId = requireParam(req, 'id');
      const { ownerType, ownerId } = req.body;
      await authorizeOwnerAccess(req, ownerType, ownerId);
      await mediaService.setCover(req.tenantId, ownerType, ownerId, mediaId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

mediaRouter.delete('/:id', resolveTenant, requireAuth, validate({ params: mediaIdParamSchema }), async (req, res, next) => {
  try {
    const mediaId = requireParam(req, 'id');
    const row = await mediaService.getById(req.tenantId, mediaId);
    await authorizeOwnerAccess(req, row.ownerType as MediaOwnerType, row.ownerId);
    await mediaService.deleteMedia(req.tenantId, mediaId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// --- public ---------------------------------------------------------------

// The storefront's read: only pictures meant to be public (a product's, the
// store logo), only ones that are ready, as loadable URLs. Profile photos and
// delivery proof are private and are not reachable here.
mediaRouter.get('/', resolveTenant, validate({ query: publicListQuerySchema }), async (req, res, next) => {
  try {
    const { ownerType, ownerId } = req.query as unknown as { ownerType: MediaOwnerType; ownerId: string };
    const pictures = await mediaService.getPublicPictures(req.tenantId, ownerType, [ownerId]);
    res.json(pictures.get(ownerId) ?? []);
  } catch (err) {
    next(err);
  }
});
