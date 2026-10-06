import os from 'node:os';
import { buildNotifications } from './rules.js';
import { sleep } from './common/util.js';

// Turns the flat [k, v, k, v] array Redis returns into an object.
const toObject = (arr) => Object.fromEntries(arr.reduce((acc, v, i) => (i % 2 ? (acc[acc.length - 1].push(v), acc) : [...acc, [v]]), []));

export function createConsumer({ blocking, redis, store, logger, metrics, streamKey, group, deliver }) {
  const consumerName = process.env.HOSTNAME || os.hostname();
  let stopped = false;

  async function ensureGroup() {
    try {
      await blocking.xgroup('CREATE', streamKey, group, '0', 'MKSTREAM');
      logger.info({ streamKey, group }, 'created consumer group');
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
  }

  // Returns true if the entry was fully handled and can be acknowledged.
  async function handle(entryId, fields) {
    let event;
    try {
      const f = toObject(fields);
      event = { type: f.type, data: JSON.parse(f.payload) };
    } catch (err) {
      logger.error({ entryId, err: err.message }, 'poison message, acknowledging and skipping');
      metrics.processed.inc({ result: 'invalid' });
      return true;
    }
    for (const n of buildNotifications(event)) {
      const created = await store.add({ eventId: entryId, ...n });
      if (created) {
        logger.info({ recipient: n.recipient, ticketId: n.ticketId, type: n.eventType }, 'notification created');
        metrics.created.inc({ type: n.eventType });
        await deliver(n); // best effort, never throws
      }
    }
    metrics.processed.inc({ result: 'ok' });
    return true;
  }

  async function processEntries(entries) {
    for (const [entryId, fields] of entries) {
      try {
        if (await handle(entryId, fields)) await redis.xack(streamKey, group, entryId);
      } catch (err) {
        // Not acknowledged: stays pending and is retried (by this or another replica).
        metrics.processed.inc({ result: 'error' });
        logger.error({ entryId, err: err.message }, 'failed to process event, will retry');
      }
    }
  }

  async function run() {
    let draining = true; // first replay anything still pending for this consumer
    while (!stopped) {
      try {
        await ensureGroup();
        const res = await blocking.xreadgroup('GROUP', group, consumerName, 'COUNT', 10, 'BLOCK', 5000, 'STREAMS', streamKey, draining ? '0' : '>');
        const entries = res?.[0]?.[1] || [];
        if (draining && entries.length === 0) draining = false;
        if (entries.length) await processEntries(entries);
      } catch (err) {
        logger.warn({ err: err.message }, 'consumer loop error (is Redis up?), retrying');
        draining = true;
        await sleep(2000);
      }
    }
  }

  // Take over entries abandoned by crashed replicas.
  async function reclaimLoop() {
    while (!stopped) {
      await sleep(30000);
      try {
        const res = await redis.xautoclaim(streamKey, group, consumerName, 60000, '0-0', 'COUNT', 20);
        const entries = res?.[1] || [];
        if (entries.length) {
          logger.info({ count: entries.length }, 'reclaimed abandoned events');
          await processEntries(entries);
        }
      } catch (err) {
        logger.debug({ err: err.message }, 'reclaim skipped');
      }
    }
  }

  async function queueStats() {
    const groups = await redis.xinfo('GROUPS', streamKey);
    const g = groups.map(toObject).find((x) => x.name === group);
    return { pending: Number(g?.pending || 0), lag: Number(g?.lag || 0) };
  }

  return {
    start() { run(); reclaimLoop(); },
    stop() { stopped = true; },
    queueStats,
  };
}
