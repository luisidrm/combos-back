// The background-job process — distinct from main.ts (the Express API),
// per CLAUDE.md §3's `worker` service. `npm run dev` starts it next to the
// API (`npm run worker:dev` runs it alone), but never inside it: BullMQ
// consumers have no business sharing a process with the HTTP server.
import { events } from './core/events.js';
import { logger } from './core/logger.js';
import { initMonitoring, reportUncaughtErrors } from './core/monitoring.js';
import { startWorkerHeartbeat } from './core/worker-heartbeat.js';
import { cartService } from './modules/cart/index.js';
import { registerCatalogWorker } from './modules/catalog/index.js';
import { mediaService, registerMediaWorker } from './modules/media/index.js';
import { notificationsService, registerNotificationsWorker } from './modules/notifications/index.js';
import { registerOrdersWorker, runOrderReconciliation } from './modules/orders/index.js';
import { tenancyService } from './modules/tenancy/index.js';

initMonitoring('worker');
reportUncaughtErrors();

registerMediaWorker();
registerCatalogWorker();
registerOrdersWorker();
registerNotificationsWorker();

// Housekeeping with no request behind it: discard abandoned uploads and
// stale guest carts. A job has no tenant of its own, so it walks the active
// tenants and does its work inside each one (RLS still applies).
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function runMaintenance(): Promise<void> {
  const started = Date.now();
  let abandonedUploads = 0;
  let staleCarts = 0;

  for (const tenantId of await tenancyService.listActiveTenantIds()) {
    try {
      abandonedUploads += await mediaService.sweepStalePending(tenantId);
      staleCarts += await cartService.purgeStaleGuestCarts(tenantId);
      // The 24h self-heal / 72h auto-cancel pass (CLAUDE.md section 6).
      await runOrderReconciliation(tenantId);
      // The bell keeps what is recent.
      await notificationsService.pruneOld(tenantId);
    } catch (err) {
      // One tenant's failure must not stop the others being tidied.
      logger.error({ err, tenantId }, 'Maintenance failed for a tenant');
    }
  }
  logger.info({ abandonedUploads, staleCarts, ms: Date.now() - started }, 'Maintenance pass finished');
}

function scheduleMaintenance(): NodeJS.Timeout {
  const run = () => runMaintenance().catch((err: unknown) => logger.error({ err }, 'Maintenance pass crashed'));
  void run();
  return setInterval(run, MAINTENANCE_INTERVAL_MS);
}

const maintenanceTimer = scheduleMaintenance();
const heartbeatTimer = startWorkerHeartbeat();

// Finish the job in hand, then disconnect, instead of dying mid-processing
// (a killed job is retried by the bus, but a clean stop is kinder).
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutting down');
  clearInterval(maintenanceTimer);
  clearInterval(heartbeatTimer);
  await events.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info('Worker process started');
