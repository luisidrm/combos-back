import { events } from '../../core/events.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { ensureMediaBucket, MEDIA_BUCKET, minioClient, presignClient, publicUrlFor } from '../../core/minio.js';
import { withTenant } from '../../db/client.js';
import * as mediaRepo from './media.repo.js';
import {
  MAX_UPLOAD_BYTES,
  uploadContentTypes,
  type Media,
  type MediaOwnerType,
  type ReorderMediaInput,
  type UpdateMediaInput,
  type UploadContentType,
} from './media.schema.js';

// How long a browser has to start using a presigned upload permission.
const UPLOAD_PERMISSION_SECONDS = 10 * 60;

// A pending upload this old will never finish (its permission expired hours
// ago), so the sweeper discards it.
const STALE_PENDING_HOURS = 24;

// Bus payload for 'media.deleted' — IDs only, per CLAUDE.md section 4.
export interface MediaDeletedPayload extends Record<string, unknown> {
  mediaId: string;
  tenantId: string;
  ownerType: string;
  ownerId: string;
}

// What an anonymous storefront visitor gets for a picture: ready pictures
// only, as URLs the browser can load directly. Never the original, never
// internal ids or storage keys.
export interface PublicPicture {
  id: string;
  thumbUrl: string;
  cardUrl: string;
  fullUrl: string;
  width: number | null;
  height: number | null;
  altTextEs: string | null;
  altTextEn: string | null;
  isCover: boolean;
}

// What the owner/admin sees while managing pictures — including ones still
// processing or failed, so an upload UI can show progress and errors. URLs
// are present only once the derivatives exist.
export interface MediaView {
  id: string;
  ownerType: string;
  ownerId: string;
  status: string;
  isCover: boolean;
  sortOrder: number;
  altTextEs: string | null;
  altTextEn: string | null;
  width: number | null;
  height: number | null;
  thumbUrl: string | null;
  cardUrl: string | null;
  fullUrl: string | null;
  createdAt: Date;
}

// What the browser needs to upload: POST a multipart form to `url` with every
// entry of `fields` first and the file itself LAST, under the name "file".
// MinIO rejects anything over `maxBytes` or not of the declared content type.
export interface UploadPermission {
  mediaId: string;
  url: string;
  method: 'POST';
  fields: Record<string, string>;
  maxBytes: number;
  expiresInSeconds: number;
}

function toManagementView(row: Media): MediaView {
  return {
    id: row.id,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    status: row.status,
    isCover: row.isCover,
    sortOrder: row.sortOrder,
    altTextEs: row.altTextEs,
    altTextEn: row.altTextEn,
    width: row.width,
    height: row.height,
    thumbUrl: row.keyThumb ? publicUrlFor(row.keyThumb) : null,
    cardUrl: row.keyCard ? publicUrlFor(row.keyCard) : null,
    fullUrl: row.keyFull ? publicUrlFor(row.keyFull) : null,
    createdAt: row.createdAt,
  };
}

// Storage cleanup is best-effort: the database is the source of truth, and a
// failed delete leaves an orphan file, not a broken app. Logged, not thrown.
async function removeObjectsQuietly(keys: Array<string | null>): Promise<void> {
  const present = keys.filter((key): key is string => typeof key === 'string');
  if (present.length === 0) return;
  try {
    await minioClient.removeObjects(MEDIA_BUCKET, present);
  } catch (err) {
    logger.warn({ err, count: present.length }, 'Could not remove media objects; leaving orphans');
  }
}

function isMissingObject(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'NotFound' || code === 'NoSuchKey';
}

// --- uploading ------------------------------------------------------------

interface RequestUploadInput {
  tenantId: string;
  ownerType: MediaOwnerType;
  ownerId: string;
  contentType: UploadContentType;
}

async function requestUpload(input: RequestUploadInput): Promise<UploadPermission> {
  await ensureMediaBucket();

  // The key is built from ids and a fixed extension only — the client's
  // filename never reaches storage, so it can't carry path tricks, odd
  // characters or a name that makes an original look like a derivative.
  const mediaId = crypto.randomUUID();
  const key = `${input.tenantId}/${input.ownerType}/${input.ownerId}/${mediaId}.${uploadContentTypes[input.contentType]}`;

  // A POST policy (unlike a plain presigned PUT) lets MinIO itself enforce a
  // size ceiling and the content type, so a 5 GB file or an HTML page is
  // refused at the door instead of stored and paid for.
  const policy = presignClient.newPostPolicy();
  policy.setBucket(MEDIA_BUCKET);
  policy.setKey(key);
  policy.setExpires(new Date(Date.now() + UPLOAD_PERMISSION_SECONDS * 1000));
  policy.setContentType(input.contentType);
  policy.setContentLengthRange(1, MAX_UPLOAD_BYTES);
  const { postURL, formData } = await presignClient.presignedPostPolicy(policy);

  await withTenant(input.tenantId, (tx) =>
    mediaRepo.insert(tx, {
      id: mediaId,
      tenantId: input.tenantId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      keyOriginal: key,
      status: 'pending',
    }),
  );

  return {
    mediaId,
    url: postURL,
    method: 'POST',
    fields: formData,
    maxBytes: MAX_UPLOAD_BYTES,
    expiresInSeconds: UPLOAD_PERMISSION_SECONDS,
  };
}

// "The file is uploaded — process it." Checks that it really is there (a
// client can call this without having uploaded anything), then hands it to
// the worker. Safe to call again: a picture already processed is returned
// untouched, one that failed gets another attempt.
async function confirmUpload(tenantId: string, mediaId: string): Promise<MediaView> {
  const row = await getById(tenantId, mediaId);
  if (row.status === 'ready') {
    return toManagementView(row);
  }

  try {
    await minioClient.statObject(MEDIA_BUCKET, row.keyOriginal);
  } catch (err) {
    if (isMissingObject(err)) {
      throw new ConflictError('The file has not been uploaded yet', { reason: 'FILE_NOT_UPLOADED' });
    }
    throw err;
  }

  if (row.status === 'failed') {
    await withTenant(tenantId, (tx) => mediaRepo.updateStatus(tx, mediaId, { status: 'pending' }));
  }
  await events.emit('media.uploaded', { mediaId, tenantId });
  return toManagementView({ ...row, status: 'pending' });
}

// --- reading --------------------------------------------------------------

async function getById(tenantId: string, mediaId: string): Promise<Media> {
  const row = await withTenant(tenantId, (tx) => mediaRepo.findById(tx, mediaId));
  if (!row || row.deletedAt) {
    throw new NotFoundError(`No media with id "${mediaId}"`);
  }
  return row;
}

async function getView(tenantId: string, mediaId: string): Promise<MediaView> {
  return toManagementView(await getById(tenantId, mediaId));
}

// Every picture of an owner in every state, for the people who manage them.
async function listForManagement(tenantId: string, ownerType: MediaOwnerType, ownerId: string): Promise<MediaView[]> {
  const rows = await withTenant(tenantId, (tx) => mediaRepo.findByOwner(tx, ownerType, ownerId));
  return rows.map(toManagementView);
}

// The public surface catalog calls before allowing a product to activate.
async function hasReadyPicture(tenantId: string, ownerType: MediaOwnerType, ownerId: string): Promise<boolean> {
  const rows = await withTenant(tenantId, (tx) => mediaRepo.findByOwner(tx, ownerType, ownerId));
  return rows.some((row) => row.status === 'ready');
}

// Ready pictures for many owners at once, cover first. Consumed by catalog,
// cart and tenancy to build their public responses.
async function getPublicPictures(
  tenantId: string,
  ownerType: MediaOwnerType,
  ownerIds: string[],
): Promise<Map<string, PublicPicture[]>> {
  const rows = await withTenant(tenantId, (tx) => mediaRepo.findReadyByOwners(tx, ownerType, ownerIds));

  const byOwner = new Map<string, PublicPicture[]>();
  for (const row of rows) {
    // Ready rows always carry all three derivative keys (the worker sets
    // them together with the status), so this only narrows the types.
    if (!row.keyThumb || !row.keyCard || !row.keyFull) {
      continue;
    }
    const picture: PublicPicture = {
      id: row.id,
      thumbUrl: publicUrlFor(row.keyThumb),
      cardUrl: publicUrlFor(row.keyCard),
      fullUrl: publicUrlFor(row.keyFull),
      width: row.width,
      height: row.height,
      altTextEs: row.altTextEs,
      altTextEn: row.altTextEn,
      isCover: row.isCover,
    };
    const list = byOwner.get(row.ownerId);
    if (list) {
      list.push(picture);
    } else {
      byOwner.set(row.ownerId, [picture]);
    }
  }
  return byOwner;
}

// --- changing -------------------------------------------------------------

async function updateMedia(tenantId: string, mediaId: string, input: UpdateMediaInput): Promise<MediaView> {
  return withTenant(tenantId, async (tx) => {
    const updated = await mediaRepo.updateFields(tx, mediaId, input);
    if (!updated) {
      throw new NotFoundError(`No media with id "${mediaId}"`);
    }
    return toManagementView(updated);
  });
}

async function setCover(tenantId: string, ownerType: MediaOwnerType, ownerId: string, mediaId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const row = await mediaRepo.findById(tx, mediaId);
    if (!row || row.deletedAt || row.ownerType !== ownerType || row.ownerId !== ownerId) {
      throw new NotFoundError(`No media "${mediaId}" for this owner`);
    }
    if (row.status !== 'ready') {
      throw new ValidationError('Only a ready picture can be set as cover');
    }
    await mediaRepo.setCover(tx, ownerType, ownerId, mediaId);
  });
}

// The i-th id gets position i. Every id must be one of this owner's pictures.
async function reorder(tenantId: string, input: ReorderMediaInput): Promise<MediaView[]> {
  return withTenant(tenantId, async (tx) => {
    const own = new Set((await mediaRepo.findByOwner(tx, input.ownerType, input.ownerId)).map((row) => row.id));
    for (const id of input.ids) {
      if (!own.has(id)) {
        throw new ValidationError(`Picture "${id}" does not belong to this owner`);
      }
    }
    for (const [index, id] of input.ids.entries()) {
      await mediaRepo.setSortOrder(tx, id, index);
    }
    return (await mediaRepo.findByOwner(tx, input.ownerType, input.ownerId)).map(toManagementView);
  });
}

// Emits media.deleted so an owning module can react — catalog uses it to
// pull a product back to draft when its last picture goes. Media can't
// import catalog (that would be a cycle), so the bus is the only way. The
// files are removed from storage too, after the database change is safe.
async function deleteMedia(tenantId: string, mediaId: string): Promise<void> {
  const row = await withTenant(tenantId, async (tx) => {
    const found = await mediaRepo.findById(tx, mediaId);
    if (!found || found.deletedAt) {
      throw new NotFoundError(`No media with id "${mediaId}"`);
    }
    await mediaRepo.softDelete(tx, mediaId);
    return found;
  });

  const payload: MediaDeletedPayload = { mediaId, tenantId, ownerType: row.ownerType, ownerId: row.ownerId };
  await events.emit('media.deleted', payload);
  await removeObjectsQuietly([row.keyOriginal, row.keyThumb, row.keyCard, row.keyFull]);
}

// --- housekeeping ---------------------------------------------------------

// Discards uploads that were requested but never completed, and whatever
// bytes did arrive. Run periodically by the worker process, once per tenant
// (a maintenance job has no request, so no tenant context of its own).
async function sweepStalePending(tenantId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_PENDING_HOURS * 60 * 60 * 1000);
  const stale = await withTenant(tenantId, async (tx) => {
    const rows = await mediaRepo.findStalePending(tx, cutoff);
    for (const row of rows) {
      await mediaRepo.softDelete(tx, row.id);
    }
    return rows;
  });
  await removeObjectsQuietly(stale.map((row) => row.keyOriginal));
  return stale.length;
}

// The only public surface other modules may depend on (via index.ts).
export const mediaService = {
  requestUpload,
  confirmUpload,
  getById,
  getView,
  listForManagement,
  updateMedia,
  setCover,
  reorder,
  deleteMedia,
  hasReadyPicture,
  getPublicPictures,
  sweepStalePending,
};
