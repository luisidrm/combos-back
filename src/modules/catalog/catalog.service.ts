import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { withTenant, type Transaction } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { mediaService, type PublicPicture } from '../media/index.js';
import * as catalogRepo from './catalog.repo.js';
import type {
  Category,
  CreateCategoryInput,
  CreateProductInput,
  Product,
  StockStatus,
  UpdateCategoryInput,
  UpdateProductInput,
} from './catalog.schema.js';
import { slugify } from './catalog.slug.js';

// --- shapes handed to callers --------------------------------------------

// What an anonymous storefront visitor may see of a product: no tenant id,
// no draft/deleted internals, and pictures as derivative keys only.
export interface PublicProduct {
  id: string;
  slug: string;
  categoryId: string | null;
  nameEs: string;
  nameEn: string;
  descriptionEs: string | null;
  descriptionEn: string | null;
  priceCents: number;
  unitLabel: string;
  stockStatus: StockStatus;
  maxPerOrder: number | null;
  cover: PublicPicture | null;
}

export interface PublicProductDetail extends PublicProduct {
  pictures: PublicPicture[];
}

export interface PublicCategory {
  id: string;
  nameEs: string;
  nameEn: string;
  icon: string | null;
}

// What cart and orders need to price and snapshot a line. `active` is
// included rather than filtered so the caller can tell "no longer sold"
// from "never existed".
export interface ProductSnapshot {
  id: string;
  slug: string;
  nameEs: string;
  nameEn: string;
  unitLabel: string;
  priceCents: number;
  stockStatus: StockStatus;
  maxPerOrder: number | null;
  active: boolean;
}

// --- helpers --------------------------------------------------------------

// stock_status is a plain varchar in the table; the write path only ever
// stores a member of the union (zod enum), so this narrows on read.
function asStockStatus(value: string): StockStatus {
  if (value === 'available' || value === 'limited' || value === 'out') {
    return value;
  }
  throw new Error(`Unexpected stock_status "${value}" in the database`);
}

function toPublicProduct(row: Product, pictures: PublicPicture[]): PublicProduct {
  return {
    id: row.id,
    slug: row.slug,
    categoryId: row.categoryId,
    nameEs: row.nameEs,
    nameEn: row.nameEn,
    descriptionEs: row.descriptionEs,
    descriptionEn: row.descriptionEn,
    priceCents: row.priceCents,
    unitLabel: row.unitLabel,
    stockStatus: asStockStatus(row.stockStatus),
    maxPerOrder: row.maxPerOrder,
    // Pictures come back cover-first, so the first one is the cover (or,
    // when no cover was chosen, simply the first picture).
    cover: pictures[0] ?? null,
  };
}

// FK checks bypass RLS, so the database alone would accept another
// tenant's category id — this look-up (which RLS does filter) is what
// actually stops a product being filed under a foreign category.
async function assertCategoryExists(tx: Transaction, categoryId: string): Promise<void> {
  if (!(await catalogRepo.findCategoryById(tx, categoryId))) {
    throw new NotFoundError(`No category with id "${categoryId}"`);
  }
}

async function uniqueSlug(tx: Transaction, name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!(await catalogRepo.slugExists(tx, candidate))) {
      return candidate;
    }
  }
  throw new ConflictError(`Could not find a free slug for "${name}"`);
}

// Two admins creating the same-named product at once can both pass the
// slugExists check; the partial unique index then rejects the second.
async function translateSlugCollision<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError('A product with this slug already exists');
    }
    throw err;
  }
}

// --- categories (admin) ---------------------------------------------------

async function listCategoriesForAdmin(tenantId: string): Promise<Category[]> {
  return withTenant(tenantId, (tx) => catalogRepo.listCategories(tx));
}

async function createCategory(tenantId: string, input: CreateCategoryInput): Promise<Category> {
  return withTenant(tenantId, async (tx) =>
    catalogRepo.insertCategory(tx, {
      tenantId,
      nameEs: input.nameEs,
      nameEn: input.nameEn ?? input.nameEs,
      icon: input.icon,
      active: input.active,
      sortOrder: await catalogRepo.nextCategorySortOrder(tx),
    }),
  );
}

async function updateCategory(tenantId: string, id: string, input: UpdateCategoryInput): Promise<Category> {
  return withTenant(tenantId, async (tx) => {
    const updated = await catalogRepo.updateCategory(tx, id, input);
    if (!updated) {
      throw new NotFoundError(`No category with id "${id}"`);
    }
    return updated;
  });
}

async function deleteCategory(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    if (!(await catalogRepo.softDeleteCategory(tx, id))) {
      throw new NotFoundError(`No category with id "${id}"`);
    }
    await catalogRepo.clearCategoryFromProducts(tx, id);
  });
}

// The i-th id gets sort_order i. Every id must exist — a stale list (one
// admin reordering a category another just deleted) fails whole rather
// than half-applying.
async function reorderCategories(tenantId: string, ids: string[]): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    for (const [index, id] of ids.entries()) {
      if (!(await catalogRepo.setCategorySortOrder(tx, id, index))) {
        throw new ValidationError(`No category with id "${id}"`);
      }
    }
  });
}

// --- products (admin) -----------------------------------------------------

async function listProductsForAdmin(
  tenantId: string,
  filter: { categoryId?: string; active?: boolean },
): Promise<Product[]> {
  return withTenant(tenantId, (tx) => catalogRepo.listProducts(tx, filter));
}

async function getProductForAdmin(tenantId: string, id: string): Promise<Product> {
  return withTenant(tenantId, async (tx) => {
    const product = await catalogRepo.findProductById(tx, id);
    if (!product) {
      throw new NotFoundError(`No product with id "${id}"`);
    }
    return product;
  });
}

async function createProduct(tenantId: string, input: CreateProductInput): Promise<Product> {
  return translateSlugCollision(() =>
    withTenant(tenantId, async (tx) => {
      if (input.categoryId) {
        await assertCategoryExists(tx, input.categoryId);
      }

      let slug: string;
      if (input.slug) {
        if (await catalogRepo.slugExists(tx, input.slug)) {
          throw new ConflictError(`A product with slug "${input.slug}" already exists`);
        }
        slug = input.slug;
      } else {
        slug = await uniqueSlug(tx, input.nameEs);
      }

      return catalogRepo.insertProduct(tx, {
        tenantId,
        slug,
        categoryId: input.categoryId,
        nameEs: input.nameEs,
        nameEn: input.nameEn ?? input.nameEs,
        descriptionEs: input.descriptionEs,
        descriptionEn: input.descriptionEn,
        priceCents: input.priceCents,
        unitLabel: input.unitLabel,
        stockStatus: input.stockStatus,
        maxPerOrder: input.maxPerOrder,
        sortOrder: await catalogRepo.nextProductSortOrder(tx),
        // Always a draft: see activateProduct.
        active: false,
      });
    }),
  );
}

async function updateProduct(tenantId: string, id: string, input: UpdateProductInput): Promise<Product> {
  return translateSlugCollision(() =>
    withTenant(tenantId, async (tx) => {
      const existing = await catalogRepo.findProductById(tx, id);
      if (!existing) {
        throw new NotFoundError(`No product with id "${id}"`);
      }
      if (input.categoryId) {
        await assertCategoryExists(tx, input.categoryId);
      }
      if (input.slug && input.slug !== existing.slug && (await catalogRepo.slugExists(tx, input.slug, id))) {
        throw new ConflictError(`A product with slug "${input.slug}" already exists`);
      }

      // Undefined fields are skipped by the UPDATE; null clears a nullable
      // column. An empty patch is a no-op, not an error.
      const updated = await catalogRepo.updateProduct(tx, id, input);
      return updated ?? existing;
    }),
  );
}

// The gate CLAUDE.md section 5 asks for: a product can only go live with at
// least one `ready` picture, since the storefront is image-led. Checked
// here rather than in the route so no future caller can skip it.
async function activateProduct(tenantId: string, id: string): Promise<Product> {
  const product = await getProductForAdmin(tenantId, id);
  if (product.active) {
    return product;
  }

  if (!(await mediaService.hasReadyPicture(tenantId, 'product', id))) {
    throw new ConflictError(
      'Add at least one picture and wait for it to finish processing before activating this product',
      { reason: 'NO_READY_PICTURE' },
    );
  }

  return setActive(tenantId, id, true);
}

async function deactivateProduct(tenantId: string, id: string): Promise<Product> {
  return setActive(tenantId, id, false);
}

async function setActive(tenantId: string, id: string, active: boolean): Promise<Product> {
  return withTenant(tenantId, async (tx) => {
    const updated = await catalogRepo.updateProduct(tx, id, { active });
    if (!updated) {
      throw new NotFoundError(`No product with id "${id}"`);
    }
    return updated;
  });
}

async function deleteProduct(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    if (!(await catalogRepo.softDeleteProduct(tx, id))) {
      throw new NotFoundError(`No product with id "${id}"`);
    }
  });
}

async function reorderProducts(tenantId: string, ids: string[]): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    for (const [index, id] of ids.entries()) {
      if (!(await catalogRepo.setProductSortOrder(tx, id, index))) {
        throw new ValidationError(`No product with id "${id}"`);
      }
    }
  });
}

// Called from the media.deleted subscriber (catalog.worker.ts): deleting a
// product's last ready picture must not leave it live without one.
async function deactivateIfNoReadyPicture(tenantId: string, productId: string): Promise<void> {
  const product = await withTenant(tenantId, (tx) => catalogRepo.findProductById(tx, productId));
  if (!product?.active) {
    return;
  }
  if (await mediaService.hasReadyPicture(tenantId, 'product', productId)) {
    return;
  }
  await setActive(tenantId, productId, false);
  logger.info({ productId }, 'Product deactivated: its last ready picture was removed');
}

// --- storefront (public, no auth) -----------------------------------------

async function listPublicCategories(tenantId: string): Promise<PublicCategory[]> {
  const rows = await withTenant(tenantId, (tx) => catalogRepo.listCategories(tx, { active: true }));
  return rows.map(({ id, nameEs, nameEn, icon }) => ({ id, nameEs, nameEn, icon }));
}

async function listPublicProducts(tenantId: string, filter: { categoryId?: string }): Promise<PublicProduct[]> {
  const rows = await withTenant(tenantId, (tx) => catalogRepo.listProducts(tx, { ...filter, active: true }));
  const pictures = await mediaService.getPublicPictures(
    tenantId,
    'product',
    rows.map((row) => row.id),
  );
  return rows.map((row) => toPublicProduct(row, pictures.get(row.id) ?? []));
}

async function getPublicProductBySlug(tenantId: string, slug: string): Promise<PublicProductDetail> {
  const row = await withTenant(tenantId, (tx) => catalogRepo.findProductBySlug(tx, slug));
  if (!row?.active) {
    // A draft is indistinguishable from a product that doesn't exist.
    throw new NotFoundError(`No product with slug "${slug}"`);
  }
  const pictures = (await mediaService.getPublicPictures(tenantId, 'product', [row.id])).get(row.id) ?? [];
  return { ...toPublicProduct(row, pictures), pictures };
}

// --- for other modules (cart, orders) -------------------------------------

async function getProductSnapshots(tenantId: string, ids: string[]): Promise<ProductSnapshot[]> {
  const rows = await withTenant(tenantId, (tx) => catalogRepo.findProductsByIds(tx, ids));
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    nameEs: row.nameEs,
    nameEn: row.nameEn,
    unitLabel: row.unitLabel,
    priceCents: row.priceCents,
    stockStatus: asStockStatus(row.stockStatus),
    maxPerOrder: row.maxPerOrder,
    active: row.active,
  }));
}

// The only public surface other modules may import (via index.ts).
export const catalogService = {
  listCategoriesForAdmin,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  listProductsForAdmin,
  getProductForAdmin,
  createProduct,
  updateProduct,
  activateProduct,
  deactivateProduct,
  deleteProduct,
  reorderProducts,
  deactivateIfNoReadyPicture,
  listPublicCategories,
  listPublicProducts,
  getPublicProductBySlug,
  getProductSnapshots,
};
