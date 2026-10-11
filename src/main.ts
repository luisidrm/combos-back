import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './core/logger.js';
import { initMonitoring, reportUncaughtErrors } from './core/monitoring.js';
import { initSupertokens } from './core/supertokens.js';

initMonitoring('api');
reportUncaughtErrors();
initSupertokens();

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'API listening');
});

// Stop taking new connections, let in-flight requests finish, then exit.
function shutdown(signal: string): void {
  logger.info({ signal }, 'API shutting down');
  server.close(() => process.exit(0));
  // A stuck connection must not hold a deploy hostage.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
