import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import { media, type Media as MediaRow, type MediaStatus, type NewMedia } from './media.schema.js';

export async function insert(tx: Transaction, values: NewMedia): Promise<MediaRow> {
  const [row] = await tx.insert(media).values(values).returning();
  if (!row) {
    throw new Error('Insert into media returned no row');
  }
  return row;
}

export async function findById(tx: Transaction, id: string): Promise<MediaRow | undefined> {
  const [row] = await tx.select().from(media).where(eq(media.id, id)).limit(1);
  return row;
}

export async function findByOwner(tx: Transaction, ownerType: string, ownerId: string): Promise<MediaRow[]> {
  return tx
    .select()
    .from(media)
    .where(and(eq(media.ownerType, ownerType), eq(media.ownerId, ownerId), isNull(media.deletedAt)))
    .orderBy(asc(media.sortOrder));
}

// Ready pictures for many owners at once (the storefront list needs one
// query, not one per product). Ordered cover-first so the first row per
// owner is its cover — or, when none is set, its first picture.
export async function findReadyByOwners(
  tx: Transaction,
  ownerType: string,
  ownerIds: string[],
): Promise<MediaRow[]> {
  if (ownerIds.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(media)
    .where(
      and(
        eq(media.ownerType, ownerType),
        inArray(media.ownerId, ownerIds),
        eq(media.status, 'ready'),
        isNull(media.deletedAt),
      ),
    )
    .orderBy(desc(media.isCover), asc(media.sortOrder), asc(media.createdAt));
}

interface DerivativeUpdate {
  status: MediaStatus;
  keyThumb?: string;
  keyCard?: string;
  keyFull?: string;
  width?: number;
  height?: number;
}

export async function updateStatus(tx: Transaction, id: string, values: DerivativeUpdate): Promise<void> {
  await tx
    .update(media)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(media.id, id));
}

// Unset any existing cover for this owner, then set the new one — the
// partial unique index on is_cover means these two writes must not
// overlap, so this always runs inside the caller's transaction.
export async function setCover(tx: Transaction, ownerType: string, ownerId: string, id: string): Promise<void> {
  await tx
    .update(media)
    .set({ isCover: false, updatedAt: new Date() })
    .where(and(eq(media.ownerType, ownerType), eq(media.ownerId, ownerId), eq(media.isCover, true)));
  await tx.update(media).set({ isCover: true, updatedAt: new Date() }).where(eq(media.id, id));
}

export async function softDelete(tx: Transaction, id: string): Promise<void> {
  await tx.update(media).set({ deletedAt: new Date() }).where(eq(media.id, id));
}

export async function updateFields(tx: Transaction, id: string, values: Partial<NewMedia>): Promise<MediaRow | undefined> {
  const [row] = await tx
    .update(media)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(media.id, id), isNull(media.deletedAt)))
    .returning();
  return row;
}

export async function setSortOrder(tx: Transaction, id: string, sortOrder: number): Promise<void> {
  await tx.update(media).set({ sortOrder, updatedAt: new Date() }).where(eq(media.id, id));
}

// Uploads that were requested but never finished (the client gave up, closed
// the tab, lost signal). Their presigned permission expired 10 minutes in, so
// anything this old will never complete.
export async function findStalePending(tx: Transaction, olderThan: Date): Promise<MediaRow[]> {
  return tx
    .select()
    .from(media)
    .where(and(eq(media.status, 'pending'), isNull(media.deletedAt), lt(media.createdAt, olderThan)));
}
