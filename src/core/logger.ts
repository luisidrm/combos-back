import pino from 'pino';
import { config } from '../config/index.js';
import { getRequestId } from './request-context.js';
import { serializeError } from './safe-error.js';

// Defense in depth on top of the "never log PII" discipline in CLAUDE.md
// section 13 — redact common PII/payment field names wherever they appear.
export const logger = pino({
  level: config.isProduction ? 'info' : 'debug',
  // Every `{ err }` logged anywhere goes through this, so a database error
  // can never carry its bound parameters (names, phones, addresses) into the
  // logs — see safe-error.ts.
  serializers: { err: serializeError },
  // Tie every line to the request that caused it (also inside background
  // jobs, where the event bus restores it).
  mixin: () => {
    const requestId = getRequestId();
    return requestId ? { requestId } : {};
  },
  redact: {
    paths: [
      '*.password',
      '*.email',
      '*.phone',
      '*.phone1',
      '*.phone2',
      '*.phoneNumber',
      '*.fullName',
      '*.street',
      '*.address',
      '*.recipientName',
      '*.paymentId',
      '*.token',
      '*.guestToken',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-cart-token"]',
    ],
    censor: '[REDACTED]',
  },
  transport: config.isProduction ? undefined : { target: 'pino-pretty' },
});
