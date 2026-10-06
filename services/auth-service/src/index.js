import mysql from 'mysql2/promise';
import { OAuth2Client } from 'google-auth-library';
import { createApp } from './app.js';
import { createMysqlStore } from './store.js';
import { createLogger } from './common/logger.js';
import { createMetrics } from './common/metrics.js';
import { createChaos } from './common/chaos.js';
import { requireEnv, retry } from './common/util.js';

const logger = createLogger('auth-service');
requireEnv(['JWT_SECRET']);

const authMode = process.env.AUTH_MODE || 'dev';
if (!['dev', 'google'].includes(authMode)) {
  logger.fatal({ authMode }, "AUTH_MODE must be 'dev' or 'google'");
  process.exit(1);
}
if (authMode === 'google') requireEnv(['GOOGLE_CLIENT_ID']);
if (authMode === 'dev') logger.warn('AUTH_MODE=dev: demo login is enabled. Never use this in production.');

const config = {
  authMode,
  jwtSecret: process.env.JWT_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  agentEmails: new Set((process.env.AGENT_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
};

const dbUrl = process.env.DATABASE_URL || process.env.AUTH_DB_URL;
if (!dbUrl) {
  logger.fatal('DATABASE_URL (or AUTH_DB_URL) is required');
  process.exit(1);
}
const pool = mysql.createPool({ uri: dbUrl, connectionLimit: 10 });
const store = createMysqlStore(pool);
await retry(() => store.ensureSchema(), { logger, label: 'database schema setup' });

const googleClient = authMode === 'google' ? new OAuth2Client(config.googleClientId) : null;
const verifyGoogleToken = async (idToken) => {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: config.googleClientId });
  const p = ticket.getPayload();
  return { email: p.email, name: p.name, picture: p.picture, emailVerified: p.email_verified };
};

const app = createApp({ store, config, metrics: createMetrics(), chaos: createChaos(logger), logger, verifyGoogleToken });
const port = Number(process.env.PORT || process.env.AUTH_PORT || 4001);
const server = app.listen(port, () => logger.info({ port, authMode }, 'auth-service listening'));

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
