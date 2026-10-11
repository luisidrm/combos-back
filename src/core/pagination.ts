import { z } from 'zod';
import { ValidationError } from './errors.js';

// Cursor pagination ("keyset"): a page is the next `limit` rows after the last row the client already has, in a fixed
// order. Unlike page numbers, a new order arriving while someone scrolls cannot shift rows into a duplicate or a gap.
//
// A list endpoint takes `?cursor=&limit=` and answers `{ items, nextCursor }`; `nextCursor` is null on the last page.
// The cursor is opaque to clients (base64url of the sort values of the last row).

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export const pageQuerySchema = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

type CursorPart = string | number;

export function encodeCursor(parts: CursorPart[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** The sort values a cursor carries, or a 400 for one that is not ours (never a 500 for a hand-edited cursor). */
export function decodeCursor(cursor: string, expected: number): CursorPart[] {
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === expected && parts.every((p) => typeof p === 'string' || typeof p === 'number')) {
      return parts as CursorPart[];
    }
  } catch {
    // falls through to the error below
  }
  throw new ValidationError('That page cursor is not valid', { reason: 'BAD_CURSOR' });
}

/**
 * Turns `limit + 1` fetched rows into a page: the extra row only tells whether there is a next page, and is not returned.
 * `cursorOf` gives the sort values of a row (the same values and order the query sorts by).
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => CursorPart[]): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}

/** Every row of a paged list, for internal callers that really need all of them (seeds, the sitemap, tests). */
export async function collectAll<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}
