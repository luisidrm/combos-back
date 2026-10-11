import { and, asc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import {
  categories,
  products,
  type Category,
  type NewCategory,
  type NewProduct,
  type Product,
} from './catalog.schema.js';

// All SQL for the catalog module's tables lives here — nothing else touches
// them. Every function takes `tx: Transaction` as its first argument;
// repos never open connections (CLAUDE.md section 5). Reads skip
// soft-deleted rows; orders snapshot what they need, so nothing here has to
// serve a deleted row.

// --- categories -----------------------------------------------------------

export async function insertCategory(tx: Transaction, values: NewCategory): Promise<Category> {
  const [row] = await tx.insert(categories).values(values).returning();
  if (!row) {
    throw new Error('Insert into categories returned no row');
  }
  return row;
}

export async function findCategoryById(tx: Transaction, id: string): Promise<Category | undefined> {
  const [row] = await tx
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
    .limit(1);
  return row;
}

export async function listCategories(tx: Transaction, filter: { active?: boolean } = {}): Promise<Category[]> {
  const conditions = [isNull(categories.deletedAt)];
  if (filter.active !== undefined) {
    conditions.push(eq(categories.active, filter.active));
  }
  return tx
    .select()
    .from(categories)
    .where(and(...conditions))
    .orderBy(asc(categories.sortOrder), asc(categories.createdAt));
}

export async function nextCategorySortOrder(tx: Transaction): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${categories.sortOrder}), -1) + 1` })
    .from(categories)
    .where(isNull(categories.deletedAt));
  return row?.next ?? 0;
}

export async function updateCategory(
  tx: Transaction,
  id: string,
  values: Partial<NewCategory>,
): Promise<Category | undefined> {
  const [row] = await tx
    .update(categories)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
    .returning();
  return row;
}

export async function softDeleteCategory(tx: Transaction, id: string): Promise<boolean> {
  const rows = await tx
    .update(categories)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
    .returning({ id: categories.id });
  return rows.length > 0;
}

// How many (not deleted) products still sit in a category: a category with products cannot be deleted.
export async function countProductsInCategory(tx: Transaction, categoryId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(and(eq(products.categoryId, categoryId), isNull(products.deletedAt)));
  return row?.n ?? 0;
}

export async function setCategorySortOrder(tx: Transaction, id: string, sortOrder: number): Promise<boolean> {
  const rows = await tx
    .update(categories)
    .set({ sortOrder, updatedAt: new Date() })
    .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
    .returning({ id: categories.id });
  return rows.length > 0;
}

// --- products -------------------------------------------------------------

export async function insertProduct(tx: Transaction, values: NewProduct): Promise<Product> {
  const [row] = await tx.insert(products).values(values).returning();
  if (!row) {
    throw new Error('Insert into products returned no row');
  }
  return row;
}

export async function findProductById(tx: Transaction, id: string): Promise<Product | undefined> {
  const [row] = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .limit(1);
  return row;
}

export async function findProductBySlug(tx: Transaction, slug: string): Promise<Product | undefined> {
  const [row] = await tx
    .select()
    .from(products)
    .where(and(eq(products.slug, slug), isNull(products.deletedAt)))
    .limit(1);
  return row;
}

export async function findProductsByIds(tx: Transaction, ids: string[]): Promise<Product[]> {
  if (ids.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(products)
    .where(and(inArray(products.id, ids), isNull(products.deletedAt)));
}

// `excludeId` lets an update keep its own slug without colliding with itself.
export async function slugExists(tx: Transaction, slug: string, excludeId?: string): Promise<boolean> {
  const conditions = [eq(products.slug, slug), isNull(products.deletedAt)];
  if (excludeId) {
    conditions.push(ne(products.id, excludeId));
  }
  const [row] = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(...conditions))
    .limit(1);
  return row !== undefined;
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

// Products in the owner's order (sort_order, then id to break ties), one page at a time: `after` is the
// [sort_order, id] of the last product already shown.
export async function pageProducts(
  tx: Transaction,
  filter: { categoryId?: string; active?: boolean; q?: string },
  page: { limit: number; after?: [number, string] },
): Promise<Product[]> {
  const conditions = [isNull(products.deletedAt)];
  if (filter.categoryId) {
    conditions.push(eq(products.categoryId, filter.categoryId));
  }
  if (filter.active !== undefined) {
    conditions.push(eq(products.active, filter.active));
  }
  if (filter.q) {
    const pattern = likePattern(filter.q);
    const match = or(ilike(products.nameEs, pattern), ilike(products.nameEn, pattern), ilike(products.slug, pattern));
    if (match) conditions.push(match);
  }
  if (page.after) {
    conditions.push(sql`(${products.sortOrder}, ${products.id}) > (${page.after[0]}::int, ${page.after[1]}::uuid)`);
  }
  return tx
    .select()
    .from(products)
    .where(and(...conditions))
    .orderBy(asc(products.sortOrder), asc(products.id))
    .limit(page.limit);
}

export async function nextProductSortOrder(tx: Transaction): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${products.sortOrder}), -1) + 1` })
    .from(products)
    .where(isNull(products.deletedAt));
  return row?.next ?? 0;
}

export async function updateProduct(
  tx: Transaction,
  id: string,
  values: Partial<NewProduct>,
): Promise<Product | undefined> {
  const [row] = await tx
    .update(products)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .returning();
  return row;
}

// Also forces `active` off, so a deleted row can never be left "active".
export async function softDeleteProduct(tx: Transaction, id: string): Promise<boolean> {
  const rows = await tx
    .update(products)
    .set({ deletedAt: new Date(), active: false, updatedAt: new Date() })
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .returning({ id: products.id });
  return rows.length > 0;
}

export async function setProductSortOrder(tx: Transaction, id: string, sortOrder: number): Promise<boolean> {
  const rows = await tx
    .update(products)
    .set({ sortOrder, updatedAt: new Date() })
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .returning({ id: products.id });
  return rows.length > 0;
}

// Numbers for the owner's product screen, counted by the database (the screen only holds a page of the list).
export async function summarizeProducts(tx: Transaction): Promise<{ total: number; live: number; lowStock: number }> {
  const [row] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      live: sql<number>`count(*) filter (where ${products.active})::int`,
      lowStock: sql<number>`count(*) filter (where ${products.stockStatus} <> 'available')::int`,
    })
    .from(products)
    .where(isNull(products.deletedAt));
  return { total: row?.total ?? 0, live: row?.live ?? 0, lowStock: row?.lowStock ?? 0 };
}
