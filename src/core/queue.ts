import { Redis } from 'ioredis';
import { config } from '../config/index.js';

// BullMQ requires this on any connection it manages.
export const redisConnection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});
