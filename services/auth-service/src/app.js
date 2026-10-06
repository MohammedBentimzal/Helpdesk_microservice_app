import express from 'express';
import { signToken, requireAuth, requireRole } from './common/auth.js';
import { wrap } from './common/util.js';
import { requestLogger } from './common/logger.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createApp({ store, config, metrics, chaos, logger, verifyGoogleToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(requestLogger(logger));
  app.use(metrics.middleware);
  app.use(chaos.middleware);

  const logins = new metrics.client.Counter({
    name: 'logins_total',
    help: 'Successful logins',
    labelNames: ['method', 'role'],
    registers: [metrics.register],
  });

  // ---- operational endpoints ----
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (req, res) => {
    try {
      await store.ping();
      res.json({ status: 'ready', checks: { mysql: 'ok' } });
    } catch (err) {
      logger.error({ err: err.message }, 'readiness check failed');
      res.status(503).json({ status: 'not ready', checks: { mysql: 'down' } });
    }
  });
  app.get('/metrics', wrap(async (req, res) => {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  }));
  app.all('/chaos', chaos.handler);

  // ---- public API ----
  app.get('/api/auth/config', (req, res) => {
    res.json({ mode: config.authMode, googleClientId: config.authMode === 'google' ? config.googleClientId : null });
  });

  // Demo login: lets you try the app without Google credentials. Disabled unless AUTH_MODE=dev.
  app.post('/api/auth/dev-login', wrap(async (req, res) => {
    if (config.authMode !== 'dev') return res.status(404).json({ error: 'dev login is disabled' });
    const { email, name, role } = req.body || {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email required' });
    const userRole = role === 'agent' ? 'agent' : 'requester';
    const user = await store.upsertUser({
      email: email.toLowerCase(),
      name: (typeof name === 'string' && name.trim()) || email.split('@')[0],
      picture: null,
      role: userRole,
    });
    logins.inc({ method: 'dev', role: user.role });
    res.json({ token: signToken(user, config.jwtSecret), user });
  }));

  // Google sign-in: the browser sends the Google ID token, we verify it and issue our own JWT.
  app.post('/api/auth/google', wrap(async (req, res) => {
    if (config.authMode !== 'google') return res.status(404).json({ error: 'google login is disabled' });
    const { credential } = req.body || {};
    if (typeof credential !== 'string') return res.status(400).json({ error: 'credential required' });
    let profile;
    try {
      profile = await verifyGoogleToken(credential);
    } catch (err) {
      logger.warn({ err: err.message }, 'google token verification failed');
      return res.status(401).json({ error: 'invalid Google credential' });
    }
    if (!profile.email || profile.emailVerified === false) return res.status(401).json({ error: 'Google email not verified' });
    const email = profile.email.toLowerCase();
    const existing = await store.getUser(email);
    const role = config.agentEmails.has(email) ? 'agent' : existing?.role || 'requester';
    const user = await store.upsertUser({ email, name: profile.name || email, picture: profile.picture, role });
    logins.inc({ method: 'google', role: user.role });
    res.json({ token: signToken(user, config.jwtSecret), user });
  }));

  // ---- authenticated API ----
  const auth = requireAuth(config.jwtSecret);
  app.get('/api/auth/me', auth, wrap(async (req, res) => {
    const user = await store.getUser(req.user.email);
    if (!user) return res.status(401).json({ error: 'unknown user' });
    res.json({ user });
  }));

  app.get('/api/auth/users', auth, requireRole('agent'), wrap(async (req, res) => {
    const role = ['agent', 'requester'].includes(req.query.role) ? req.query.role : undefined;
    res.json({ users: await store.listUsers(role) });
  }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({ error: 'internal server error' });
  });
  return app;
}
