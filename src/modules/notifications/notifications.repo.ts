// All SQL for the notifications module's tables lives here — nothing else touches
// them. Every function takes `tx: Transaction` as its first argument;
// repos never open connections (CLAUDE.md section 5).
import { and, desc, eq, getTableColumns, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Transaction } from '../../db/client.js';
import { notifications, type NewNotification, type Notification } from './notifications.schema.js';

export async function insertMany(tx: Transaction, rows: NewNotification[]): Promise<void> {
  if (rows.length === 0) return;
  // A repeat of the same announcement (a retried job) inserts nothing.
  await tx.insert(notifications).values(rows).onConflictDoNothing();
}

// Microsecond-precision text of created_at, so a cursor does not lose the digits a JS Date would drop.
const cursorAt = sql<string>`to_char(${notifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export type NotificationRow = Notification & { cursorAt: string };

export async function pageForUser(
  tx: Transaction,
  userId: string,
  page: { limit: number; after?: [string, string]; unreadOnly?: boolean },
): Promise<NotificationRow[]> {
  return tx
    .select({ ...getTableColumns(notifications), cursorAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        page.unreadOnly ? isNull(notifications.readAt) : undefined,
        page.after ? sql`(${notifications.createdAt}, ${notifications.id}) < (${page.after[0]}::timestamptz, ${page.after[1]}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(page.limit);
}

export async function countUnread(tx: Transaction, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

// Only ever the caller's own rows: the user id is part of the condition, so another person's ids change nothing.
export async function markRead(tx: Transaction, userId: string, ids: string[] | 'all'): Promise<void> {
  await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ids === 'all' ? undefined : inArray(notifications.id, ids)));
}

// Old rows go: a feed is for what is recent.
export async function deleteOlderThan(tx: Transaction, cutoff: Date): Promise<number> {
  const rows = await tx.delete(notifications).where(lt(notifications.createdAt, cutoff)).returning({ id: notifications.id });
  return rows.length;
}
