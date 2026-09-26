import { AsyncLocalStorage } from 'node:async_hooks';

// The current request's id, available anywhere below the request middleware
// without passing it around: the logger reads it into every line, and the
// event bus copies it into each job so a background handler's logs can be
// tied back to the request that caused it (CLAUDE.md section 13).
const storage = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}
