import { Readable } from 'node:stream';
import sharp from 'sharp';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { startTestDatabase, type TestDatabase } from '../../db/testing/test-database.js';
import type { mediaService as mediaServiceType } from './index.js';

// The event bus and object storage are external systems, so they are replaced
// here; the DATABASE is real (real migrations, the restricted app role). What
// these tests pin down is the media module's own behaviour: what it asks
// storage to do, what it records, and how the worker reacts when storage or
// the file misbehaves.

const events = vi.hoisted(() => ({
  emit: vi.fn().mockResolvedValue(undefined),
  handlers: new Map<string, (payload: never, delivery: never) => Promise<void>>(),
  on: vi.fn((name: string, handler: (payload: never, delivery: never) => Promise<void>) => {
    events.handlers.set(name, handler);
  }),
  close: vi.fn(),
}));
vi.mock('../../core/events.js', () => ({ events }));

const storage = vi.hoisted(() => ({
  statObject: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn().mockResolvedValue(undefined),
  removeObjects: vi.fn().mockResolvedValue(undefined),
  bucketExists: vi.fn().mockResolvedValue(true),
  setBucketPolicy: vi.fn().mockResolvedValue(undefined),
  policy: {
    calls: [] as Array<[string, unknown]>,
  },
}));

vi.mock('../../core/minio.js', () => {
  const newPostPolicy = () => {
    const policy = {
      setBucket: (v: unknown) => storage.policy.calls.push(['bucket', v]),
      setKey: (v: unknown) => storage.policy.calls.push(['key', v]),
      setExpires: (v: unknown) => storage.policy.calls.push(['expires', v]),
      setContentType: (v: unknown) => storage.policy.calls.push(['contentType', v]),
      setContentLengthRange: (min: number, max: number) => storage.policy.calls.push(['lengthRange', [min, max]]),
    };
    return policy;
  };
  return {
    minioClient: storage,
    presignClient: {
      newPostPolicy,
      presignedPostPolicy: async () => ({
        postURL: 'https://media.example.test/bucket',
        formData: { key: 'signed-key', policy: 'signed-policy', 'x-amz-signature': 'sig' },
      }),
    },
    MEDIA_BUCKET: 'test-media',
    PUBLIC_PREFIX: 'public/',
    publicUrlFor: (key: string) => `https://cdn.example.test/${key}`,
    ensureMediaBucket: async () => undefined,
  };
});

type WorkerHandler = (payload: { mediaId: string; tenantId: string }, delivery: { attempt: number; maxAttempts: number; isLastAttempt: boolean }) => Promise<void>;

describe('media module', () => {
  let database: TestDatabase;
  let adminSql: postgres.Sql;
  let media: typeof mediaServiceType;
  let handle: WorkerHandler;

  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();

  const middleOfRetries = { attempt: 2, maxAttempts: 5, isLastAttempt: false };
  const lastAttempt = { attempt: 5, maxAttempts: 5, isLastAttempt: true };

  async function statusOf(mediaId: string): Promise<string | undefined> {
    const [row] = await adminSql<{ status: string }[]>`select status from media where id = ${mediaId}`;
    return row?.status;
  }

  async function insertRow(tenantId: string, ownerId: string, overrides: { status?: string; createdAt?: Date; isCover?: boolean } = {}) {
    const id = crypto.randomUUID();
    const key = `${tenantId}/product/${ownerId}/${id}.jpg`;
    await adminSql`
      INSERT INTO media (id, tenant_id, owner_type, owner_id, key_original, status, is_cover, created_at)
      VALUES (${id}, ${tenantId}, 'product', ${ownerId}, ${key}, ${overrides.status ?? 'pending'},
              ${overrides.isCover ?? false}, ${overrides.createdAt ?? new Date()})`;
    return { id, key };
  }

  async function png(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 90, b: 40 } } }).png().toBuffer();
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    adminSql = database.adminSql;
    media = (await import('./index.js')).mediaService;
    (await import('./index.js')).registerMediaWorker();
    handle = events.handlers.get('media.uploaded') as unknown as WorkerHandler;
  });

  afterAll(async () => {
    await database?.stop();
  });

  beforeEach(() => {
    events.emit.mockClear();
    storage.statObject.mockReset();
    storage.getObject.mockReset();
    storage.putObject.mockClear();
    storage.removeObjects.mockClear().mockResolvedValue(undefined);
    storage.policy.calls.length = 0;
  });

  describe('asking to upload', () => {
    it('signs a POST limited to one content type and a size ceiling, and records a pending row', async () => {
      const ownerId = crypto.randomUUID();
      const permission = await media.requestUpload({ tenantId: tenantA, ownerType: 'product', ownerId, contentType: 'image/png' });

      expect(permission).toMatchObject({
        method: 'POST',
        url: 'https://media.example.test/bucket',
        maxBytes: 10 * 1024 * 1024,
        expiresInSeconds: 600,
      });
      expect(permission.fields).toHaveProperty('x-amz-signature');

      const asked = Object.fromEntries(storage.policy.calls);
      expect(asked.contentType).toBe('image/png');
      expect(asked.lengthRange).toEqual([1, 10 * 1024 * 1024]);

      const [row] = await adminSql<{ status: string; key_original: string }[]>`select status, key_original from media where id = ${permission.mediaId}`;
      expect(row?.status).toBe('pending');
      expect(asked.key).toBe(row?.key_original);
    });

    it('builds the storage key from ids alone — the client never chooses any part of it', async () => {
      const ownerId = crypto.randomUUID();
      const { mediaId } = await media.requestUpload({ tenantId: tenantA, ownerType: 'product', ownerId, contentType: 'image/jpeg' });
      const key = Object.fromEntries(storage.policy.calls).key as string;
      expect(key).toBe(`${tenantA}/product/${ownerId}/${mediaId}.jpg`);
      // The originals live outside the public prefix.
      expect(key.startsWith('public/')).toBe(false);
    });
  });

  describe('confirming', () => {
    it('refuses, without queueing anything, when nothing was uploaded', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      storage.statObject.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 'NotFound' }));

      const refused = await media.confirmUpload(tenantA, id).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(ConflictError);
      expect((refused as ConflictError).details).toEqual({ reason: 'FILE_NOT_UPLOADED' });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('does not swallow a storage outage as "not uploaded"', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      storage.statObject.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
      await expect(media.confirmUpload(tenantA, id)).rejects.toThrow('boom');
    });

    it('queues processing when the file is there', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      storage.statObject.mockResolvedValue({ size: 123 });
      const view = await media.confirmUpload(tenantA, id);
      expect(view.status).toBe('pending');
      expect(events.emit).toHaveBeenCalledWith('media.uploaded', { mediaId: id, tenantId: tenantA });
    });

    it('is a no-op for a picture that is already ready', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID(), { status: 'ready' });
      const view = await media.confirmUpload(tenantA, id);
      expect(view.status).toBe('ready');
      expect(events.emit).not.toHaveBeenCalled();
      expect(storage.statObject).not.toHaveBeenCalled();
    });

    it('gives a failed picture another attempt', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID(), { status: 'failed' });
      storage.statObject.mockResolvedValue({ size: 1 });
      await media.confirmUpload(tenantA, id);
      expect(await statusOf(id)).toBe('pending');
      expect(events.emit).toHaveBeenCalledOnce();
    });

    it("cannot confirm another store's upload", async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      await expect(media.confirmUpload(tenantB, id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('the worker', () => {
    async function pendingWithFile(bytes: Buffer) {
      const ownerId = crypto.randomUUID();
      const { id } = await insertRow(tenantA, ownerId);
      storage.getObject.mockResolvedValue(Readable.from([bytes]));
      return { id, ownerId };
    }

    it('makes three WebP sizes under the public prefix, cacheable forever, and marks the picture ready', async () => {
      const { id, ownerId } = await pendingWithFile(await png(2400, 1800));
      await handle({ mediaId: id, tenantId: tenantA }, middleOfRetries);

      const puts = storage.putObject.mock.calls;
      expect(puts.map((call) => call[1])).toEqual([
        `public/${tenantA}/product/${ownerId}/${id}.thumb.webp`,
        `public/${tenantA}/product/${ownerId}/${id}.card.webp`,
        `public/${tenantA}/product/${ownerId}/${id}.full.webp`,
      ]);
      for (const call of puts) {
        expect(call[3]).toMatchObject({ 'Content-Type': 'image/webp', 'Cache-Control': expect.stringContaining('immutable') });
      }

      const widths = await Promise.all(puts.map(async (call) => (await sharp(call[2] as Buffer).metadata()).width));
      expect(widths).toEqual([300, 800, 1600]);

      const [row] = await adminSql<{ status: string; width: number; height: number; key_card: string }[]>`
        select status, width, height, key_card from media where id = ${id}`;
      expect(row).toMatchObject({ status: 'ready', width: 2400, height: 1800 });
      expect(row?.key_card.startsWith('public/')).toBe(true);
    });

    it('never enlarges a small picture', async () => {
      const { id } = await pendingWithFile(await png(500, 400));
      await handle({ mediaId: id, tenantId: tenantA }, middleOfRetries);
      const widths = await Promise.all(storage.putObject.mock.calls.map(async (call) => (await sharp(call[2] as Buffer).metadata()).width));
      expect(widths).toEqual([300, 500, 500]);
    });

    it('applies the photo orientation, and records the upright size', async () => {
      // A phone photo: 200x100 pixels stored sideways, flagged "rotate 90°".
      const sideways = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#88aa22' } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer();
      const { id } = await pendingWithFile(sideways);
      await handle({ mediaId: id, tenantId: tenantA }, middleOfRetries);

      const [row] = await adminSql<{ width: number; height: number }[]>`select width, height from media where id = ${id}`;
      expect(row).toMatchObject({ width: 100, height: 200 });
      const full = await sharp(storage.putObject.mock.calls[2]?.[2] as Buffer).metadata();
      expect([full.width, full.height]).toEqual([100, 200]);
    });

    it('drops location data: nothing public carries the original EXIF', async () => {
      const withGps = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#123456' } })
        .jpeg()
        .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '23/1 7/1 0/1' } })
        .toBuffer();
      expect((await sharp(withGps).metadata()).exif).toBeDefined();

      const { id } = await pendingWithFile(withGps);
      await handle({ mediaId: id, tenantId: tenantA }, middleOfRetries);
      for (const call of storage.putObject.mock.calls) {
        expect((await sharp(call[2] as Buffer).metadata()).exif).toBeUndefined();
      }
    });

    it('marks a file that is not an image as failed, once, without retrying', async () => {
      const { id } = await pendingWithFile(Buffer.from('<html>this is not a picture</html>'));
      // Resolves (does not throw): a retry could never fix these bytes.
      await expect(handle({ mediaId: id, tenantId: tenantA }, middleOfRetries)).resolves.toBeUndefined();
      expect(await statusOf(id)).toBe('failed');
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('marks a file missing from storage as failed, without retrying', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      storage.getObject.mockRejectedValue(Object.assign(new Error('gone'), { code: 'NoSuchKey' }));
      await expect(handle({ mediaId: id, tenantId: tenantA }, middleOfRetries)).resolves.toBeUndefined();
      expect(await statusOf(id)).toBe('failed');
    });

    it('rethrows a storage outage so the bus retries, leaving the picture pending', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      storage.getObject.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
      await expect(handle({ mediaId: id, tenantId: tenantA }, middleOfRetries)).rejects.toThrow('connection reset');
      expect(await statusOf(id)).toBe('pending');
    });

    it('marks it failed only when the last attempt is exhausted', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      storage.getObject.mockRejectedValue(Object.assign(new Error('still down'), { code: 'ECONNRESET' }));
      await expect(handle({ mediaId: id, tenantId: tenantA }, lastAttempt)).rejects.toThrow('still down');
      expect(await statusOf(id)).toBe('failed');
    });

    it('retries when uploading the derivatives fails, not just when reading the original', async () => {
      const { id } = await pendingWithFile(await png(900, 600));
      storage.putObject.mockRejectedValueOnce(Object.assign(new Error('write failed'), { code: 'ECONNRESET' }));
      await expect(handle({ mediaId: id, tenantId: tenantA }, middleOfRetries)).rejects.toThrow('write failed');
      expect(await statusOf(id)).toBe('pending');
    });

    it('does nothing for a picture that was deleted, or is already ready', async () => {
      const deleted = await insertRow(tenantA, crypto.randomUUID());
      await adminSql`update media set deleted_at = now() where id = ${deleted.id}`;
      const ready = await insertRow(tenantA, crypto.randomUUID(), { status: 'ready' });

      await handle({ mediaId: deleted.id, tenantId: tenantA }, middleOfRetries);
      await handle({ mediaId: ready.id, tenantId: tenantA }, middleOfRetries);
      expect(storage.getObject).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it("cannot process another store's picture", async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      await handle({ mediaId: id, tenantId: tenantB }, middleOfRetries);
      expect(storage.getObject).not.toHaveBeenCalled();
      expect(await statusOf(id)).toBe('pending');
    });
  });

  describe('reading', () => {
    it('shows the public only ready pictures, as URLs, cover first', async () => {
      const ownerId = crypto.randomUUID();
      const notCover = await insertRow(tenantA, ownerId, { status: 'ready' });
      const cover = await insertRow(tenantA, ownerId, { status: 'ready', isCover: true });
      await insertRow(tenantA, ownerId, { status: 'pending' });
      await insertRow(tenantA, ownerId, { status: 'failed' });
      for (const row of [notCover, cover]) {
        await adminSql`update media set key_thumb = ${`public/${row.id}.thumb.webp`}, key_card = ${`public/${row.id}.card.webp`}, key_full = ${`public/${row.id}.full.webp`} where id = ${row.id}`;
      }

      const pictures = (await media.getPublicPictures(tenantA, 'product', [ownerId])).get(ownerId) ?? [];
      expect(pictures.map((p) => p.id)).toEqual([cover.id, notCover.id]);
      expect(pictures[0]?.cardUrl).toBe(`https://cdn.example.test/public/${cover.id}.card.webp`);
      expect(JSON.stringify(pictures)).not.toContain('key_original');
    });

    it('shows the owner every picture in every state, with URLs only when they exist', async () => {
      const ownerId = crypto.randomUUID();
      await insertRow(tenantA, ownerId, { status: 'pending' });
      await insertRow(tenantA, ownerId, { status: 'failed' });
      const views = await media.listForManagement(tenantA, 'product', ownerId);
      expect(views.map((v) => v.status).sort()).toEqual(['failed', 'pending']);
      expect(views.every((v) => v.thumbUrl === null && v.cardUrl === null)).toBe(true);
      expect(JSON.stringify(views)).not.toMatch(/key_original|keyOriginal|tenantId/);
    });

    it("shows another store nothing", async () => {
      const ownerId = crypto.randomUUID();
      await insertRow(tenantA, ownerId, { status: 'ready' });
      expect(await media.listForManagement(tenantB, 'product', ownerId)).toEqual([]);
      expect((await media.getPublicPictures(tenantB, 'product', [ownerId])).size).toBe(0);
    });
  });

  describe('editing', () => {
    it('sets alt text, and clears it with null', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID(), { status: 'ready' });
      const set = await media.updateMedia(tenantA, id, { altTextEs: 'Pollo ahumado', altTextEn: 'Smoked chicken' });
      expect(set).toMatchObject({ altTextEs: 'Pollo ahumado', altTextEn: 'Smoked chicken' });
      const cleared = await media.updateMedia(tenantA, id, { altTextEn: null });
      expect(cleared).toMatchObject({ altTextEs: 'Pollo ahumado', altTextEn: null });
    });

    it("cannot edit another store's picture", async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      await expect(media.updateMedia(tenantB, id, { altTextEs: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('reorders an owner’s pictures, and refuses a picture that is not theirs', async () => {
      const ownerId = crypto.randomUUID();
      const a = await insertRow(tenantA, ownerId);
      const b = await insertRow(tenantA, ownerId);
      const c = await insertRow(tenantA, ownerId);

      const reordered = await media.reorder(tenantA, { ownerType: 'product', ownerId, ids: [c.id, a.id, b.id] });
      expect(reordered.map((v) => v.id)).toEqual([c.id, a.id, b.id]);

      const stranger = await insertRow(tenantA, crypto.randomUUID());
      await expect(media.reorder(tenantA, { ownerType: 'product', ownerId, ids: [a.id, stranger.id] })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect((await media.listForManagement(tenantA, 'product', ownerId)).map((v) => v.id)).toEqual([c.id, a.id, b.id]);
    });

    it('lets only a ready picture be the cover', async () => {
      const ownerId = crypto.randomUUID();
      const pending = await insertRow(tenantA, ownerId, { status: 'pending' });
      const ready = await insertRow(tenantA, ownerId, { status: 'ready' });
      await expect(media.setCover(tenantA, 'product', ownerId, pending.id)).rejects.toBeInstanceOf(ValidationError);
      await media.setCover(tenantA, 'product', ownerId, ready.id);
      expect((await media.getView(tenantA, ready.id)).isCover).toBe(true);
    });
  });

  describe('deleting and tidying up', () => {
    it('soft-deletes, tells the bus, and removes the files from storage', async () => {
      const ownerId = crypto.randomUUID();
      const { id, key } = await insertRow(tenantA, ownerId, { status: 'ready' });
      await adminSql`update media set key_thumb = 'public/t', key_card = 'public/c', key_full = 'public/f' where id = ${id}`;

      await media.deleteMedia(tenantA, id);

      expect(events.emit).toHaveBeenCalledWith('media.deleted', { mediaId: id, tenantId: tenantA, ownerType: 'product', ownerId });
      expect(storage.removeObjects).toHaveBeenCalledWith('test-media', [key, 'public/t', 'public/c', 'public/f']);
      await expect(media.getById(tenantA, id)).rejects.toBeInstanceOf(NotFoundError);
      const [row] = await adminSql<{ deleted_at: Date | null }[]>`select deleted_at from media where id = ${id}`;
      expect(row?.deleted_at).not.toBeNull();
    });

    it('still deletes when storage cleanup fails — an orphan file is not worth a failed request', async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID(), { status: 'ready' });
      storage.removeObjects.mockRejectedValue(new Error('storage is down'));
      await expect(media.deleteMedia(tenantA, id)).resolves.toBeUndefined();
      await expect(media.getById(tenantA, id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("cannot delete another store's picture", async () => {
      const { id } = await insertRow(tenantA, crypto.randomUUID());
      await expect(media.deleteMedia(tenantB, id)).rejects.toBeInstanceOf(NotFoundError);
      expect(storage.removeObjects).not.toHaveBeenCalled();
    });

    it('sweeps uploads abandoned for over a day, leaving fresh, ready and failed ones alone', async () => {
      const ownerId = crypto.randomUUID();
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const abandoned = await insertRow(tenantA, ownerId, { status: 'pending', createdAt: twoDaysAgo });
      const fresh = await insertRow(tenantA, ownerId, { status: 'pending' });
      const oldButReady = await insertRow(tenantA, ownerId, { status: 'ready', createdAt: twoDaysAgo });
      const oldButFailed = await insertRow(tenantA, ownerId, { status: 'failed', createdAt: twoDaysAgo });
      const otherStore = await insertRow(tenantB, ownerId, { status: 'pending', createdAt: twoDaysAgo });

      expect(await media.sweepStalePending(tenantA)).toBe(1);
      expect(storage.removeObjects).toHaveBeenCalledWith('test-media', [abandoned.key]);

      const alive = async (id: string) => {
        const [row] = await adminSql<{ deleted_at: Date | null }[]>`select deleted_at from media where id = ${id}`;
        return row?.deleted_at === null;
      };
      expect(await alive(abandoned.id)).toBe(false);
      expect(await alive(fresh.id)).toBe(true);
      expect(await alive(oldButReady.id)).toBe(true);
      expect(await alive(oldButFailed.id)).toBe(true);
      // The sweep for one store never touches another's.
      expect(await alive(otherStore.id)).toBe(true);
    });
  });
});
