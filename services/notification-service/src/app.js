import express from 'express';
import { requireAuth } from './common/auth.js';
import { wrap } from './common/util.js';
import { requestLogger } from './common/logger.js';

export function createApp({ store, queue, config, metrics, chaos, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(requestLogger(logger));
  app.use(metrics.middleware);
  app.use(chaos.middleware);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (req, res) => {
    const checks = { mysql: 'ok', redis: 'ok' };
    try { await store.ping(); } catch (err) { checks.mysql = 'down'; logger.error({ err: err.message }, 'mysql check failed'); }
    try { await queue.queueStats(); } catch { checks.redis = 'down'; }
    const ready = checks.mysql === 'ok'; // Redis outage only delays notifications; the API can still serve stored ones
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready', checks });
  });
  app.get('/metrics', wrap(async (req, res) => {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  }));
  app.all('/chaos', chaos.handler);

  const auth = requireAuth(config.jwtSecret);

  app.get('/api/notifications', auth, wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    res.json(await store.listFor({ email: req.user.email, role: req.user.role, limit }));
  }));

  app.post('/api/notifications/read-all', auth, wrap(async (req, res) => {
    await store.markAllRead({ email: req.user.email, role: req.user.role });
    res.json({ ok: true });
  }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({ error: 'internal server error' });
  });
  return app;
}
