import { Queue, Worker, type Job } from 'bullmq';
import { logger } from './logger.js';
import { reportError } from './monitoring.js';
import { redisConnection } from './queue.js';
import { getRequestId, runWithRequestId } from './request-context.js';

// Queue-backed event bus (CLAUDE.md section 4, "Circular dependencies use
// the event bus"). One BullMQ queue per event name. Keep payloads minimal
// (IDs, not entities) — subscribers re-fetch what they need through
// services, never through the bus itself.
//
// IMPORTANT — one consumer per event. Two `on()` calls for the same event
// name would be two workers on one queue, which BullMQ treats as competing
// consumers: each job goes to ONE of them, not both. Every event has exactly
// one subscriber today. Before a second module needs the same event, give
// each subscriber its own queue (fan-out at emit time) rather than
// registering another handler here.
const queues = new Map<string, Queue>();
const workers: Worker[] = [];

function getQueue(eventName: string): Queue {
  let queue = queues.get(eventName);
  if (!queue) {
    queue = new Queue(eventName, { connection: redisConnection });
    queues.set(eventName, queue);
  }
  return queue;
}

// Carried inside the job data, under a key no payload uses.
const REQUEST_ID_KEY = '__requestId';

async function emit<TPayload extends Record<string, unknown>>(
  eventName: string,
  payload: TPayload,
): Promise<void> {
  const requestId = getRequestId();
  await getQueue(eventName).add(eventName, requestId ? { ...payload, [REQUEST_ID_KEY]: requestId } : payload, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

// What a handler is told about this delivery, so it can tell a retry from a
// last chance: on the last attempt a handler may want to record a permanent
// failure before rethrowing.
export interface DeliveryInfo {
  attempt: number;
  maxAttempts: number;
  isLastAttempt: boolean;
}

function on<TPayload extends Record<string, unknown>>(
  eventName: string,
  handler: (payload: TPayload, delivery: DeliveryInfo) => Promise<void>,
): Worker<TPayload> {
  const worker = new Worker<TPayload>(
    eventName,
    async (job: Job<TPayload>) => {
      const { [REQUEST_ID_KEY]: requestId, ...payload } = job.data as TPayload & { [REQUEST_ID_KEY]?: string };
      const maxAttempts = job.opts.attempts ?? 1;
      const attempt = job.attemptsMade + 1;
      // Restore the originating request's id so this handler's log lines can
      // be tied back to the request that caused it.
      await runWithRequestId(requestId ?? `job-${job.id ?? 'unknown'}`, () =>
        handler(payload as unknown as TPayload, { attempt, maxAttempts, isLastAttempt: attempt >= maxAttempts }),
      );
    },
    { connection: redisConnection },
  );

  // Without a listener, an 'error' event (a Redis blip) is an unhandled
  // EventEmitter error, which Node treats as fatal.
  worker.on('error', (err) => logger.error({ err, event: eventName }, 'Event worker error'));
  worker.on('failed', (job, err) => {
    logger.warn({ err, event: eventName, attempt: job?.attemptsMade }, 'Event handler failed');
    // Only the last attempt is worth a report: the earlier ones retry by themselves.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      reportError(err, { event: eventName, attempts: job.attemptsMade });
    }
  });

  workers.push(worker);
  return worker;
}

// Lets a process shut down without dropping a job mid-way: workers finish
// what they're doing, then everything disconnects.
async function close(): Promise<void> {
  await Promise.allSettled(workers.map((worker) => worker.close()));
  await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
}

export const events = { emit, on, close };
