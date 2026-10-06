import pg from 'pg';
import Redis from 'ioredis';
import { createApp } from './app.js';
import { createPgStore } from './store.js';
import { createPublisher } from './events.js';
import { createLogger } from './common/logger.js';
import { createMetrics } from './common/metrics.js';
import { createChaos } from './common/chaos.js';
import { requireEnv, retry } from './common/util.js';

const logger = createLogger('ticket-service');
requireEnv(['JWT_SECRET']);
const dbUrl = process.env.DATABASE_URL || process.env.TICKET_DB_URL;
const redisUrl = process.env.REDIS_URL;
if (!dbUrl || !redisUrl) {
  logger.fatal('DATABASE_URL (or TICKET_DB_URL) and REDIS_URL are required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
pool.on('error', (err) => logger.error({ err: err.message }, 'idle postgres client error'));
const store = createPgStore(pool);
await retry(() => store.ensureSchema(), { logger, label: 'database schema setup' });
if (process.env.SEED_DEMO_DATA === 'true' && (await store.seedIfEmpty())) logger.info('seeded demo tickets');

// Fail fast when Redis is down so ticket requests are never blocked by the queue.
const redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000 });
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));

const metrics = createMetrics();
metrics.eventsPublished = new metrics.client.Counter({ name: 'events_published_total', help: 'Events published to the queue', labelNames: ['type'], registers: [metrics.register] });
metrics.eventsFailed = new metrics.client.Counter({ name: 'events_publish_failures_total', help: 'Events that could not be published', labelNames: ['type'], registers: [metrics.register] });

const streamKey = process.env.EVENTS_STREAM || 'helpdesk.ticket-events';
const publisher = createPublisher({ redis, streamKey, logger, metrics });
const config = { jwtSecret: process.env.JWT_SECRET };

const app = createApp({ store, publisher, config, metrics, chaos: createChaos(logger), logger });
const port = Number(process.env.PORT || process.env.TICKET_PORT || 4002);
const server = app.listen(port, () => logger.info({ port }, 'ticket-service listening'));

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await pool.end().catch(() => {});
    redis.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
