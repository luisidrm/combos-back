import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { events, type DeliveryInfo } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import { ensureMediaBucket, MEDIA_BUCKET, minioClient, PUBLIC_PREFIX } from '../../core/minio.js';
import { withTenant } from '../../db/client.js';
import * as mediaRepo from './media.repo.js';
import type { Media } from './media.schema.js';

interface MediaUploadedPayload extends Record<string, unknown> {
  mediaId: string;
  tenantId: string;
}

// CLAUDE.md §11: thumb 300px, card 800px, full 1600px, all re-encoded WebP.
const DERIVATIVE_WIDTHS = {
  thumb: 300,
  card: 800,
  full: 1600,
} as const;

type DerivativeName = keyof typeof DERIVATIVE_WIDTHS;

// A derivative's name never changes once written (its key contains the media
// id), so browsers and Cloudflare may cache it forever.
const DERIVATIVE_HEADERS = {
  'Content-Type': 'image/webp',
  'Cache-Control': 'public, max-age=31536000, immutable',
};

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Public path of a derivative. Under PUBLIC_PREFIX so storage serves it
// anonymously; the original is not.
function derivativeKey(row: Media, name: DerivativeName): string {
  return `${PUBLIC_PREFIX}${row.tenantId}/${row.ownerType}/${row.ownerId}/${row.id}.${name}.webp`;
}

interface Processed {
  buffers: Record<DerivativeName, Buffer>;
  width: number | undefined;
  height: number | undefined;
}

// Decoding and resizing. An error thrown from HERE means the bytes are not a
// usable image (corrupt, truncated, not an image at all), which no retry can
// fix — unlike a storage or database error, which usually can be.
async function processImage(original: Buffer): Promise<Processed> {
  const metadata = await sharp(original).metadata();

  const buffers = {} as Record<DerivativeName, Buffer>;
  for (const [name, width] of Object.entries(DERIVATIVE_WIDTHS) as Array<[DerivativeName, number]>) {
    // rotate() applies the EXIF orientation (a phone photo taken upright is
    // often stored sideways with a flag), and re-encoding to WebP drops the
    // metadata, so location data in the original never reaches a public file.
    buffers[name] = await sharp(original).rotate().resize({ width, withoutEnlargement: true }).webp().toBuffer();
  }

  // Orientations 5-8 are the sideways ones: stored width and height are swapped.
  const sideways = (metadata.orientation ?? 1) >= 5;
  return {
    buffers,
    width: sideways ? metadata.height : metadata.width,
    height: sideways ? metadata.width : metadata.height,
  };
}

function isMissingObject(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'NoSuchKey' || code === 'NotFound';
}

async function markFailed(tenantId: string, mediaId: string): Promise<void> {
  await withTenant(tenantId, (tx) => mediaRepo.updateStatus(tx, mediaId, { status: 'failed' }));
}

async function handleMediaUploaded({ mediaId, tenantId }: MediaUploadedPayload, delivery: DeliveryInfo): Promise<void> {
  await ensureMediaBucket();

  const row = await withTenant(tenantId, (tx) => mediaRepo.findById(tx, mediaId));
  // Deleted before the worker got to it, or already processed by an earlier
  // (duplicate) confirm — nothing left to do.
  if (!row || row.deletedAt || row.status === 'ready') {
    return;
  }

  let original: Buffer;
  try {
    original = await streamToBuffer(await minioClient.getObject(MEDIA_BUCKET, row.keyOriginal));
  } catch (err) {
    if (isMissingObject(err)) {
      logger.warn({ mediaId }, 'Original is missing from storage; marking the picture failed');
      await markFailed(tenantId, mediaId);
      return;
    }
    return failOrRetry(err, tenantId, mediaId, delivery);
  }

  let processed: Processed;
  try {
    processed = await processImage(original);
  } catch (err) {
    // Not a usable image: permanent. Record it and stop — retrying the same
    // bytes five times would only delay the admin seeing the error.
    logger.warn({ err, mediaId }, 'Uploaded file is not a usable image; marking the picture failed');
    await markFailed(tenantId, mediaId);
    return;
  }

  try {
    const keys = {} as Record<DerivativeName, string>;
    for (const name of Object.keys(DERIVATIVE_WIDTHS) as DerivativeName[]) {
      keys[name] = derivativeKey(row, name);
      await minioClient.putObject(MEDIA_BUCKET, keys[name], processed.buffers[name], DERIVATIVE_HEADERS);
    }

    await withTenant(tenantId, (tx) =>
      mediaRepo.updateStatus(tx, mediaId, {
        status: 'ready',
        keyThumb: keys.thumb,
        keyCard: keys.card,
        keyFull: keys.full,
        width: processed.width,
        height: processed.height,
      }),
    );
  } catch (err) {
    return failOrRetry(err, tenantId, mediaId, delivery);
  }
}

// A storage or database error is usually temporary. Rethrowing hands the job
// back to the bus, which retries with backoff (core/events.ts); only when the
// attempts are exhausted is the picture marked failed, so the admin sees a
// definite result instead of a permanent "pending".
async function failOrRetry(err: unknown, tenantId: string, mediaId: string, delivery: DeliveryInfo): Promise<never> {
  if (delivery.isLastAttempt) {
    logger.error({ err, mediaId, attempt: delivery.attempt }, 'Media processing failed on the last attempt');
    await markFailed(tenantId, mediaId);
  }
  throw err;
}

export function registerMediaWorker(): void {
  events.on<MediaUploadedPayload>('media.uploaded', handleMediaUploaded);
}
