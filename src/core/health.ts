import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { MEDIA_BUCKET, minioClient } from './minio.js';
import { redisConnection } from './queue.js';

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type CheckResult = 'ok' | 'failed';

export interface Readiness {
  ok: boolean;
  checks: Record<'postgres' | 'redis' | 'minio', CheckResult>;
}

async function run(check: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await withTimeout(check());
    return 'ok';
  } catch {
    // Which dependency is down is the useful part; the reason stays out of
    // an unauthenticated response (it could name hosts or credentials).
    return 'failed';
  }
}

// Whether this instance can actually serve traffic: the three things it
// cannot work without. /health only says the process is up; a load balancer
// or deploy script should ask this before sending users to a new release.
export async function checkReadiness(): Promise<Readiness> {
  const [postgres, redis, minio] = await Promise.all([
    run(() => db.execute(sql`select 1`)),
    run(() => redisConnection.ping()),
    run(() => minioClient.bucketExists(MEDIA_BUCKET)),
  ]);
  return { ok: postgres === 'ok' && redis === 'ok' && minio === 'ok', checks: { postgres, redis, minio } };
}
