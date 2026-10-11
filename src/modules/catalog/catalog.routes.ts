import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '../../core/errors.js';
import { requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
import type { PageQuery } from '../../core/pagination.js';
import { requireParam } from '../../core/request.js';
import {
  adminProductsQuerySchema,
  createCategorySchema,
  createProductSchema,
  idParamSchema,
  publicProductsQuerySchema,
  reorderSchema,
  slugParamSchema,
  updateCategorySchema,
  updateProductSchema,
} from './catalog.schema.js';
import { catalogService } from './catalog.service.js';

export const catalogRouter = Router();

// --- storefront: public, tenant only --------------------------------------

catalogRouter.get('/categories', resolveTenant, async (req, res, next) => {
  try {
    res.json(await catalogService.listPublicCategories(req.tenantId));
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/products', resolveTenant, validate({ query: publicProductsQuerySchema }), async (req, res, next) => {
  try {
    const { categoryId, q, cursor, limit } = req.query as unknown as { categoryId?: string; q?: string } & PageQuery;
    res.json(await catalogService.pagePublicProducts(req.tenantId, { categoryId, q }, { cursor, limit }));
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/products/:slug', resolveTenant, validate({ params: slugParamSchema }), async (req, res, next) => {
  try {
    res.json(await catalogService.getPublicProductBySlug(req.tenantId, requireParam(req, 'slug')));
  } catch (err) {
    next(err);
  }
});

// --- admin ----------------------------------------------------------------

const adminOnly = [resolveTenant, requireAuth, requireRole('admin')];
// The packer (staff) may look at the product list and flip availability, nothing else.
const staffOrAdmin = [resolveTenant, requireAuth, requireRole('admin', 'staff')];

// Staff can change a product's stock status and nothing else — not its price, name, category or
// limits. Checked on the validated body, so no field can slip past by being added later.
export function staffMayOnlyChangeStock(req: Request, _res: Response, next: NextFunction): void {
  if (req.authUser?.role === 'staff') {
    const forbidden = Object.keys(req.body as Record<string, unknown>).filter((key) => key !== 'stockStatus');
    if (forbidden.length > 0) {
      next(new ForbiddenError('Staff can only change the stock status of a product', { reason: 'STAFF_FIELDS', fields: forbidden }));
      return;
    }
  }
  next();
}

catalogRouter.get('/admin/categories', ...staffOrAdmin, async (req, res, next) => {
  try {
    res.json(await catalogService.listCategoriesForAdmin(req.tenantId));
  } catch (err) {
    next(err);
  }
});

catalogRouter.post('/categories', ...adminOnly, validate({ body: createCategorySchema }), async (req, res, next) => {
  try {
    res.status(201).json(await catalogService.createCategory(req.tenantId, req.body));
  } catch (err) {
    next(err);
  }
});

// Declared before '/categories/:id' so "order" is never read as an id.
catalogRouter.put('/categories/order', ...adminOnly, validate({ body: reorderSchema }), async (req, res, next) => {
  try {
    await catalogService.reorderCategories(req.tenantId, req.body.ids);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

catalogRouter.patch(
  '/categories/:id',
  ...adminOnly,
  validate({ params: idParamSchema, body: updateCategorySchema }),
  async (req, res, next) => {
    try {
      res.json(await catalogService.updateCategory(req.tenantId, requireParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

catalogRouter.delete('/categories/:id', ...adminOnly, validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    await catalogService.deleteCategory(req.tenantId, requireParam(req, 'id'));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Declared before /admin/products/:id so "summary" is never read as an id.
catalogRouter.get('/admin/products-summary', ...staffOrAdmin, async (req, res, next) => {
  try {
    res.json(await catalogService.summarizeProductsForAdmin(req.tenantId));
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/admin/products', ...staffOrAdmin, validate({ query: adminProductsQuerySchema }), async (req, res, next) => {
  try {
    const { categoryId, active, q, cursor, limit } = req.query as unknown as { categoryId?: string; active?: boolean; q?: string } & PageQuery;
    res.json(await catalogService.pageProductsForAdmin(req.tenantId, { categoryId, active, q }, { cursor, limit }));
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/admin/products/:id', ...staffOrAdmin, validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    res.json(await catalogService.getProductForAdmin(req.tenantId, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

catalogRouter.post('/products', ...adminOnly, validate({ body: createProductSchema }), async (req, res, next) => {
  try {
    res.status(201).json(await catalogService.createProduct(req.tenantId, req.body));
  } catch (err) {
    next(err);
  }
});

catalogRouter.put('/products/order', ...adminOnly, validate({ body: reorderSchema }), async (req, res, next) => {
  try {
    await catalogService.reorderProducts(req.tenantId, req.body.ids);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

catalogRouter.patch(
  '/products/:id',
  ...staffOrAdmin,
  validate({ params: idParamSchema, body: updateProductSchema }),
  staffMayOnlyChangeStock,
  async (req, res, next) => {
    try {
      res.json(await catalogService.updateProduct(req.tenantId, requireParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

catalogRouter.post('/products/:id/activate', ...staffOrAdmin, validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    res.json(await catalogService.activateProduct(req.tenantId, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

catalogRouter.post('/products/:id/deactivate', ...staffOrAdmin, validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    res.json(await catalogService.deactivateProduct(req.tenantId, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

catalogRouter.delete('/products/:id', ...adminOnly, validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    await catalogService.deleteProduct(req.tenantId, requireParam(req, 'id'));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
