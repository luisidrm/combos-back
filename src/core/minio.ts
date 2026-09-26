import { Client } from 'minio';
import { config } from '../config/index.js';

// The client the API and worker use to talk to MinIO (reads originals,
// writes derivatives, checks existence).
export const minioClient = new Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

// A second client used ONLY to sign upload permissions. A presigned URL
// embeds its host, and the signature covers it, so the host has to be the one
// the *browser* will connect to — in production that is the public address
// behind Caddy/Cloudflare, not the internal Docker hostname the API uses.
// Fixing `region` stops the library asking the server for it, which would
// make the API call its own public address just to sign a URL.
export const presignClient = new Client({
  endPoint: config.minio.publicEndPoint,
  port: config.minio.publicPort,
  useSSL: config.minio.publicUseSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
  region: 'us-east-1',
});

export const MEDIA_BUCKET = config.minio.bucket;

// Processed pictures live under this prefix and ONLY this prefix is publicly
// readable. Originals (uploaded as-is, possibly huge, possibly with GPS
// metadata) sit outside it and stay private — CLAUDE.md section 11, "never
// serve originals", enforced by storage rather than by good intentions.
export const PUBLIC_PREFIX = 'public/';

export function publicUrlFor(key: string): string {
  return `${config.mediaPublicBaseUrl}/${key}`;
}

let bucketEnsured = false;

interface S3Error {
  code?: string;
}

function isBucketAlreadyOwnedError(err: unknown): boolean {
  const code = (err as S3Error).code;
  return code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists';
}

// Anonymous read of derivatives, nothing else. Applied on every start so a
// bucket created before this policy existed picks it up.
function publicReadPolicy(): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${MEDIA_BUCKET}/${PUBLIC_PREFIX}*`],
      },
    ],
  });
}

// Called once at startup by both main.ts and worker.ts, not per-request —
// creating a bucket is an idempotent but non-trivial round trip.
export async function ensureMediaBucket(): Promise<void> {
  if (bucketEnsured) return;

  // Deliberately not swallowing bucketExists errors into "false" — a
  // transient connection error is not the same as "the bucket doesn't
  // exist," and treating it as one leads straight into makeBucket
  // rejecting with BucketAlreadyOwnedByYou (found by hitting this for
  // real: intermittent ECONNRESET here got misread as "create it").
  const exists = await minioClient.bucketExists(MEDIA_BUCKET);
  if (!exists) {
    try {
      await minioClient.makeBucket(MEDIA_BUCKET);
    } catch (err) {
      if (!isBucketAlreadyOwnedError(err)) {
        throw err;
      }
    }
  }
  await minioClient.setBucketPolicy(MEDIA_BUCKET, publicReadPolicy());
  bucketEnsured = true;
}
