import { describe, expect, it } from 'vitest';
import { collectAll, decodeCursor, encodeCursor, pageQuerySchema, toPage } from './pagination.js';

describe('cursor pagination helpers', () => {
  it('round-trips the sort values through an opaque cursor', () => {
    const cursor = encodeCursor(['2026-10-04T10:00:00.000Z', 'abc-123']);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, 2)).toEqual(['2026-10-04T10:00:00.000Z', 'abc-123']);
  });

  it('refuses a cursor that is not ours with a 400, however it was damaged', () => {
    for (const bad of ['not-base64-json', encodeCursor(['only-one']), Buffer.from('{"a":1}').toString('base64url'), Buffer.from('[1,{"x":2}]').toString('base64url')]) {
      expect(() => decodeCursor(bad, 2), bad).toThrowError(expect.objectContaining({ httpStatus: 400, details: { reason: 'BAD_CURSOR' } }));
    }
  });

  it('builds a page from limit + 1 rows: the extra row only says there is more', () => {
    const rows = [1, 2, 3, 4];
    const page = toPage(rows, 3, (n) => [n]);
    expect(page.items).toEqual([1, 2, 3]);
    expect(decodeCursor(page.nextCursor as string, 1)).toEqual([3]);
  });

  it('the last page has no cursor, and an empty list is a valid page', () => {
    expect(toPage([1, 2], 3, (n) => [n])).toEqual({ items: [1, 2], nextCursor: null });
    expect(toPage([1, 2, 3], 3, (n) => [n]).nextCursor).toBeNull();
    expect(toPage([], 3, (n: number) => [n])).toEqual({ items: [], nextCursor: null });
  });

  it('reads limit and cursor from a query string, with a default and a ceiling', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(pageQuerySchema.parse({ limit: '50', cursor: 'x' })).toEqual({ limit: 50, cursor: 'x' });
    expect(pageQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('collects every page of a paged list', async () => {
    const all = Array.from({ length: 7 }, (_, i) => i);
    const fetchPage = async (cursor: string | undefined) => {
      const start = cursor ? (decodeCursor(cursor, 1)[0] as number) : 0;
      return toPage(all.slice(start, start + 4), 3, (_n) => [start + 3]);
    };
    expect(await collectAll(fetchPage)).toEqual(all);
  });
});
