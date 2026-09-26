// The background-job process — distinct from main.ts (the Express API),
// per CLAUDE.md §3's `worker` service. Run with `npm run worker:dev`
// alongside `npm run dev`, not inside it: BullMQ consumers have no
// business sharing a process with the HTTP server.
import { events } from './core/events.js';
import { logger } from './core/logger.js';
import { cartService } from './modules/cart/index.js';
import { registerCatalogWorker } from './modules/catalog/index.js';
import { mediaService, registerMediaWorker } from './modules/media/index.js';
import { tenancyService } from './modules/tenancy/index.js';

registerMediaWorker();
registerCatalogWorker();

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

// Finish the job in hand, then disconnect, instead of dying mid-processing
// (a killed job is retried by the bus, but a clean stop is kinder).
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutting down');
  clearInterval(maintenanceTimer);
  await events.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info('Worker process started');
