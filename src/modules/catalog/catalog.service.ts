import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { collectAll, decodeCursor, toPage, type Page, type PageQuery } from '../../core/pagination.js';
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

// Every product must have a category, so one that still has products cannot be deleted: move or delete those
// products first (the admin screen says how many).
async function deleteCategory(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    if (!(await catalogRepo.findCategoryById(tx, id))) {
      throw new NotFoundError(`No category with id "${id}"`);
    }
    const inUse = await catalogRepo.countProductsInCategory(tx, id);
    if (inUse > 0) {
      throw new ConflictError('This category still has products', { reason: 'CATEGORY_IN_USE', productCount: inUse });
    }
    if (!(await catalogRepo.softDeleteCategory(tx, id))) {
      throw new NotFoundError(`No category with id "${id}"`);
    }
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

// A product row as the admin sees it, plus its cover: the first ready picture (the chosen cover first), so the
// list can show a thumbnail. A draft has one too, as soon as a picture has finished processing.
export type AdminProduct = Product & { cover: PublicPicture | null };

async function withCovers(tenantId: string, rows: Product[]): Promise<AdminProduct[]> {
  const pictures = await mediaService.getPublicPictures(
    tenantId,
    'product',
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, cover: pictures.get(row.id)?.[0] ?? null }));
}

// A cursor says where the last page ended: [sort_order, product id]. Both go straight into SQL casts, so a hand-edited
// cursor must be a 400, never a database error.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function productCursor(cursor: string | undefined): [number, string] | undefined {
  if (!cursor) return undefined;
  const [order, id] = decodeCursor(cursor, 2);
  if (typeof order !== 'number' || !Number.isInteger(order) || typeof id !== 'string' || !UUID.test(id)) {
    throw new ValidationError('That page cursor is not valid', { reason: 'BAD_CURSOR' });
  }
  return [order, id];
}
const productCursorOf = (row: Product): Array<string | number> => [row.sortOrder, row.id];

// One page of the owner's product list (drafts included), each with its cover. `q` searches name and slug.
async function pageProductsForAdmin(
  tenantId: string,
  filter: { categoryId?: string; active?: boolean; q?: string },
  page: PageQuery,
): Promise<Page<AdminProduct>> {
  const after = productCursor(page.cursor);
  const rows = await withTenant(tenantId, (tx) => catalogRepo.pageProducts(tx, filter, { limit: page.limit + 1, after }));
  const result = toPage(rows, page.limit, productCursorOf);
  return { items: await withCovers(tenantId, result.items), nextCursor: result.nextCursor };
}

// How many products there are, how many are live, how many are low or out of stock: the screen's badges.
async function summarizeProductsForAdmin(tenantId: string): Promise<{ total: number; live: number; lowStock: number }> {
  return withTenant(tenantId, (tx) => catalogRepo.summarizeProducts(tx));
}

// Every product (internal callers and tests; the API serves pages).
async function listProductsForAdmin(tenantId: string, filter: { categoryId?: string; active?: boolean }): Promise<AdminProduct[]> {
  return collectAll((cursor) => pageProductsForAdmin(tenantId, filter, { limit: 100, cursor }));
}

async function getProductForAdmin(tenantId: string, id: string): Promise<AdminProduct> {
  const product = await withTenant(tenantId, async (tx) => {
    const found = await catalogRepo.findProductById(tx, id);
    if (!found) {
      throw new NotFoundError(`No product with id "${id}"`);
    }
    return found;
  });
  return (await withCovers(tenantId, [product]))[0] as AdminProduct;
}

async function createProduct(tenantId: string, input: CreateProductInput): Promise<Product> {
  return translateSlugCollision(() =>
    withTenant(tenantId, async (tx) => {
      await assertCategoryExists(tx, input.categoryId);

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
      } else if (existing.categoryId === null && Object.keys(input).some((key) => key !== 'stockStatus')) {
        // A product that predates the rule keeps working (a stock flip needs no category), but any other edit
        // has to give it one.
        throw new ValidationError('Choose a category for this product', { reason: 'CATEGORY_REQUIRED' });
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

  if (product.categoryId === null) {
    throw new ConflictError('Choose a category for this product before making it visible', { reason: 'CATEGORY_REQUIRED' });
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

// One page of the shop window: live products only, in the owner's order.
async function pagePublicProducts(tenantId: string, filter: { categoryId?: string; q?: string }, page: PageQuery): Promise<Page<PublicProduct>> {
  const after = productCursor(page.cursor);
  const rows = await withTenant(tenantId, (tx) => catalogRepo.pageProducts(tx, { ...filter, active: true }, { limit: page.limit + 1, after }));
  const result = toPage(rows, page.limit, productCursorOf);
  const pictures = await mediaService.getPublicPictures(
    tenantId,
    'product',
    result.items.map((row) => row.id),
  );
  return { items: result.items.map((row) => toPublicProduct(row, pictures.get(row.id) ?? [])), nextCursor: result.nextCursor };
}

// Every live product (internal callers and tests; the API serves pages).
async function listPublicProducts(tenantId: string, filter: { categoryId?: string }): Promise<PublicProduct[]> {
  return collectAll((cursor) => pagePublicProducts(tenantId, filter, { limit: 100, cursor }));
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
  pageProductsForAdmin,
  summarizeProductsForAdmin,
  pagePublicProducts,
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
