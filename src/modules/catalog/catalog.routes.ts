import { Router } from 'express';
import { requireAuth, requireRole } from '../../core/middleware/auth.middleware.js';
import { resolveTenant } from '../../core/middleware/tenant.middleware.js';
import { validate } from '../../core/middleware/validate.middleware.js';
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
    const { categoryId } = req.query as { categoryId?: string };
    res.json(await catalogService.listPublicProducts(req.tenantId, { categoryId }));
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

catalogRouter.get('/admin/categories', ...adminOnly, async (req, res, next) => {
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

catalogRouter.get('/admin/products', ...adminOnly, validate({ query: adminProductsQuerySchema }), async (req, res, next) => {
  try {
    const { categoryId, active } = req.query as { categoryId?: string; active?: boolean };
    res.json(await catalogService.listProductsForAdmin(req.tenantId, { categoryId, active }));
  } catch (err) {
    next(err);
  }
});

catalogRouter.get('/admin/products/:id', ...adminOnly, validate({ params: idParamSchema }), async (req, res, next) => {
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
  ...adminOnly,
  validate({ params: idParamSchema, body: updateProductSchema }),
  async (req, res, next) => {
    try {
      res.json(await catalogService.updateProduct(req.tenantId, requireParam(req, 'id'), req.body));
    } catch (err) {
      next(err);
    }
  },
);

catalogRouter.post('/products/:id/activate', ...adminOnly, validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    res.json(await catalogService.activateProduct(req.tenantId, requireParam(req, 'id')));
  } catch (err) {
    next(err);
  }
});

catalogRouter.post('/products/:id/deactivate', ...adminOnly, validate({ params: idParamSchema }), async (req, res, next) => {
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
