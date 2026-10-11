import * as Sentry from '@sentry/node';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { getRequestId } from './request-context.js';
import { serializeError } from './safe-error.js';

// Error monitoring (Sentry, or anything speaking its protocol: GlitchTip can be self-hosted on the
// same server by changing only the DSN). Off until SENTRY_DSN is set, so development and tests send
// nothing and need no account.
//
// What is reported is deliberately narrow. CLAUDE.md section 13 says never to send names, phones,
// addresses or payment identifiers anywhere, and a database error's own message carries the SQL
// and its bound values. So an error is never handed to Sentry as thrown: it first goes through the
// same serializer the logs use (code, constraint, table, stack frames, no values), and the SDK's own
// extras are switched off: no request bodies, headers, cookies, users or breadcrumbs.

let enabled = false;

export function initMonitoring(service: 'api' | 'worker'): void {
  if (!config.sentryDsn) return;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.sentryEnvironment,
    // Errors only: no performance traces, and none of the integrations that read requests or consoles.
    tracesSampleRate: 0,
    defaultIntegrations: false,
    beforeBreadcrumb: () => null,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      event.server_name = undefined;
      return event;
    },
    initialScope: { tags: { service } },
  });
  enabled = true;
  logger.info({ service }, 'Error monitoring is on');
}

// Reports an unexpected error with the request id (so it ties back to the logs), after stripping it
// down. Never throws: a broken monitor must not break the request it is reporting on.
export function reportError(err: unknown, context: Record<string, string | number | undefined> = {}): void {
  if (!enabled) return;
  try {
    const safe = serializeError(err);
    const clean = new Error(String(safe.message ?? 'Unknown error'));
    clean.name = String(safe.type ?? 'Error');
    clean.stack = typeof safe.stack === 'string' ? `${clean.name}: ${clean.message}\n${safe.stack}` : clean.stack;
    const requestId = getRequestId();
    Sentry.captureException(clean, {
      tags: { ...(requestId ? { requestId } : {}), ...(typeof safe.code === 'string' ? { dbCode: safe.code } : {}) },
      extra: context,
    });
  } catch (monitorError) {
    logger.warn({ err: monitorError }, 'Could not report an error to monitoring');
  }
}

// Lets the event finish sending before a process exits on purpose (a deploy, a crash).
export async function flushMonitoring(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}

// Anything that escapes every handler. Reported, logged, and the process is allowed to die: a process
// in an unknown state must restart rather than carry on (the supervisor brings it back).
export function reportUncaughtErrors(): void {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    reportError(err, { kind: 'uncaughtException' });
    void flushMonitoring().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    reportError(reason, { kind: 'unhandledRejection' });
  });
}
