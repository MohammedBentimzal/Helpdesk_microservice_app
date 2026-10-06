import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMetrics } from '../src/common/metrics.js';
import { createChaos } from '../src/common/chaos.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {} };

function fakeStore() {
  const users = new Map();
  return {
    async ping() {},
    async getUser(email) { return users.get(email) || null; },
    async upsertUser(u) { users.set(u.email, { ...u }); return users.get(u.email); },
    async listUsers(role) { return [...users.values()].filter((u) => !role || u.role === role); },
  };
}

async function start(overrides = {}) {
  const config = { authMode: 'dev', jwtSecret: 'test-secret', googleClientId: 'cid', agentEmails: new Set(['boss@example.com']), ...overrides.config };
  const app = createApp({
    store: overrides.store || fakeStore(),
    config,
    metrics: createMetrics(),
    chaos: createChaos(silent),
    logger: silent,
    verifyGoogleToken: overrides.verifyGoogleToken || (async () => { throw new Error('bad token'); }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', body, token } = {}) =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('health and ready endpoints respond', async () => {
  const s = await start();
  assert.equal((await s.call('/health')).status, 200);
  const ready = await s.call('/ready');
  assert.equal(ready.status, 200);
  await s.close();
});

test('ready returns 503 when the database is down', async () => {
  const store = fakeStore();
  store.ping = async () => { throw new Error('db down'); };
  const s = await start({ store });
  assert.equal((await s.call('/ready')).status, 503);
  await s.close();
});

test('metrics endpoint exposes prometheus metrics', async () => {
  const s = await start();
  await s.call('/api/auth/config');
  const text = await (await s.call('/metrics')).text();
  assert.match(text, /http_requests_total/);
  await s.close();
});

test('dev login issues a token and /me works', async () => {
  const s = await start();
  const res = await s.call('/api/auth/dev-login', { method: 'POST', body: { email: 'sara@example.com', name: 'Sara' } });
  assert.equal(res.status, 200);
  const { token, user } = await res.json();
  assert.equal(user.role, 'requester');
  const me = await s.call('/api/auth/me', { token });
  assert.equal((await me.json()).user.email, 'sara@example.com');
  await s.close();
});

test('dev login is disabled in google mode', async () => {
  const s = await start({ config: { authMode: 'google' } });
  const res = await s.call('/api/auth/dev-login', { method: 'POST', body: { email: 'a@b.co' } });
  assert.equal(res.status, 404);
  await s.close();
});

test('/me without a token returns 401', async () => {
  const s = await start();
  assert.equal((await s.call('/api/auth/me')).status, 401);
  await s.close();
});

test('only agents can list users', async () => {
  const s = await start();
  const req = await (await s.call('/api/auth/dev-login', { method: 'POST', body: { email: 'r@example.com' } })).json();
  const agent = await (await s.call('/api/auth/dev-login', { method: 'POST', body: { email: 'a@example.com', role: 'agent' } })).json();
  assert.equal((await s.call('/api/auth/users', { token: req.token })).status, 403);
  const ok = await s.call('/api/auth/users?role=agent', { token: agent.token });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).users.length, 1);
  await s.close();
});

test('google login gives agent role to emails in AGENT_EMAILS', async () => {
  const s = await start({
    config: { authMode: 'google' },
    verifyGoogleToken: async () => ({ email: 'Boss@Example.com', name: 'Boss', picture: null, emailVerified: true }),
  });
  const res = await s.call('/api/auth/google', { method: 'POST', body: { credential: 'fake' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.role, 'agent');
  await s.close();
});

test('google login rejects invalid credentials', async () => {
  const s = await start({ config: { authMode: 'google' } });
  const res = await s.call('/api/auth/google', { method: 'POST', body: { credential: 'nope' } });
  assert.equal(res.status, 401);
  await s.close();
});

test('chaos error mode injects failures but not on health', async () => {
  process.env.CHAOS_MODE = 'error';
  process.env.CHAOS_ERROR_RATE = '1';
  const s = await start();
  delete process.env.CHAOS_MODE;
  delete process.env.CHAOS_ERROR_RATE;
  assert.equal((await s.call('/api/auth/config')).status, 500);
  assert.equal((await s.call('/health')).status, 200);
  await s.close();
});
