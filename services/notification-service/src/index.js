import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import { createApp } from './app.js';
import { createMysqlStore } from './store.js';
import { createConsumer } from './consumer.js';
import { createLogger } from './common/logger.js';
import { createMetrics } from './common/metrics.js';
import { createChaos } from './common/chaos.js';
import { requireEnv, retry } from './common/util.js';

const logger = createLogger('notification-service');
requireEnv(['JWT_SECRET']);
const dbUrl = process.env.DATABASE_URL || process.env.NOTIFICATIONS_DB_URL;
const redisUrl = process.env.REDIS_URL;
if (!dbUrl || !redisUrl) {
  logger.fatal('DATABASE_URL (or NOTIFICATIONS_DB_URL) and REDIS_URL are required');
  process.exit(1);
}

const pool = mysql.createPool({ uri: dbUrl, connectionLimit: 10 });
const store = createMysqlStore(pool);
await retry(() => store.ensureSchema(), { logger, label: 'database schema setup' });

const streamKey = process.env.EVENTS_STREAM || 'helpdesk.ticket-events';
const group = process.env.CONSUMER_GROUP || 'notification-service';
// Two connections: one dedicated to the blocking read, one for acks, stats and health.
const blocking = new Redis(redisUrl, { maxRetriesPerRequest: null });
const redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000 });
for (const [name, r] of [['blocking', blocking], ['control', redis]]) r.on('error', (err) => logger.warn({ name, err: err.message }, 'redis error'));

const metrics = createMetrics();
const { client, register } = metrics;
metrics.processed = new client.Counter({ name: 'events_processed_total', help: 'Queue events processed', labelNames: ['result'], registers: [register] });
metrics.created = new client.Counter({ name: 'notifications_created_total', help: 'Notifications created', labelNames: ['type'], registers: [register] });
const delivered = new client.Counter({ name: 'notifications_delivered_total', help: 'External deliveries', labelNames: ['channel', 'result'], registers: [register] });

// Optional external delivery. In-app notifications are always stored in MySQL.
const webhook = process.env.DISCORD_WEBHOOK_URL;
async function deliver(n) {
  if (!webhook) return;
  try {
    const res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `**Helpdesk** ${n.message}` }), signal: AbortSignal.timeout(5000) });
    delivered.inc({ channel: 'discord', result: res.ok ? 'ok' : 'error' });
  } catch (err) {
    delivered.inc({ channel: 'discord', result: 'error' });
    logger.warn({ err: err.message }, 'discord delivery failed');
  }
}

const consumer = createConsumer({ blocking, redis, store, logger, metrics, streamKey, group, deliver });
async function collectQueue(gauge, field) {
  try { gauge.set((await consumer.queueStats())[field]); } catch { /* Redis down: keep last value */ }
}
new client.Gauge({ name: 'notification_queue_pending', help: 'Events delivered to consumers but not yet acknowledged', registers: [register], async collect() { await collectQueue(this, 'pending'); } });
new client.Gauge({ name: 'notification_queue_lag', help: 'Events waiting in the stream, not yet read by the group', registers: [register], async collect() { await collectQueue(this, 'lag'); } });

const app = createApp({ store, queue: consumer, config: { jwtSecret: process.env.JWT_SECRET }, metrics, chaos: createChaos(logger), logger });
const port = Number(process.env.PORT || process.env.NOTIFICATION_PORT || 4003);
const server = app.listen(port, () => logger.info({ port, streamKey, group }, 'notification-service listening'));
consumer.start();

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  consumer.stop();
  server.close(async () => {
    await pool.end().catch(() => {});
    blocking.disconnect();
    redis.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
