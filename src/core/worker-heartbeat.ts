import { logger } from './logger.js';
import { redisConnection } from './queue.js';

// The worker process turns uploads into thumbnails, sends email and runs the maintenance pass. When it is not
// running nothing in the API fails: pictures just sit on "Processing" for ever, which looks like a broken
// upload. So the worker writes a short-lived key every few seconds, and the API can tell whether anyone is
// there to do the work (reported by /ready, never used to refuse a request).
const KEY = 'worker:heartbeat';
const BEAT_EVERY_MS = 10_000;
const EXPIRES_AFTER_S = 30;

export function startWorkerHeartbeat(): NodeJS.Timeout {
  const beat = () => {
    redisConnection.set(KEY, String(Date.now()), 'EX', EXPIRES_AFTER_S).catch((err: unknown) => {
      logger.warn({ err }, 'Could not write the worker heartbeat');
    });
  };
  beat();
  return setInterval(beat, BEAT_EVERY_MS);
}

export async function workerIsAlive(): Promise<boolean> {
  return (await redisConnection.exists(KEY)) === 1;
}
