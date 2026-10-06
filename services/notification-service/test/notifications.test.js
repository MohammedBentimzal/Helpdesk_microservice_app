import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotifications } from '../src/rules.js';
import { createApp } from '../src/app.js';
import { createMetrics } from '../src/common/metrics.js';
import { createChaos } from '../src/common/chaos.js';
import { signToken } from '../src/common/auth.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {} };
const base = { ticketId: 7, title: 'Wi-Fi down', priority: 'high', requesterEmail: 'sara@example.com', requesterName: 'Sara',
  assigneeEmail: 'ahmed@example.com', assigneeName: 'Ahmed', actorEmail: 'sara@example.com', actorName: 'Sara', actorRole: 'requester' };

test('new ticket notifies all agents', () => {
  const out = buildNotifications({ type: 'ticket.created', data: base });
  assert.equal(out.length, 1);
  assert.equal(out[0].recipient, 'agents');
  assert.match(out[0].message, /high priority ticket #7/);
});

test('status change notifies the requester, not the actor', () => {
  const agentAction = { ...base, status: 'resolved', actorEmail: 'ahmed@example.com', actorName: 'Ahmed', actorRole: 'agent' };
  const out = buildNotifications({ type: 'ticket.status_changed', data: agentAction });
  assert.equal(out[0].recipient, 'sara@example.com');
  assert.match(out[0].message, /Resolved/);
  const selfAction = { ...base, status: 'open' };
  assert.equal(buildNotifications({ type: 'ticket.status_changed', data: selfAction }).length, 0);
});

test('assignment notifies the requester; unassign notifies nobody', () => {
  const agent = { ...base, actorEmail: 'ahmed@example.com', actorRole: 'agent' };
  assert.equal(buildNotifications({ type: 'ticket.assigned', data: agent })[0].recipient, 'sara@example.com');
  assert.equal(buildNotifications({ type: 'ticket.assigned', data: { ...agent, assigneeEmail: null } }).length, 0);
});

test('comments go to the other side of the conversation', () => {
  const byRequester = buildNotifications({ type: 'ticket.commented', data: base });
  assert.equal(byRequester[0].recipient, 'ahmed@example.com');
  const unassigned = buildNotifications({ type: 'ticket.commented', data: { ...base, assigneeEmail: null } });
  assert.equal(unassigned[0].recipient, 'agents');
  const byAgent = buildNotifications({ type: 'ticket.commented', data: { ...base, actorEmail: 'ahmed@example.com', actorName: 'Ahmed', actorRole: 'agent' } });
  assert.equal(byAgent[0].recipient, 'sara@example.com');
});

test('unknown events produce nothing', () => {
  assert.deepEqual(buildNotifications({ type: 'something.else', data: base }), []);
  assert.deepEqual(buildNotifications({}), []);
});

test('API requires auth and returns notifications for the caller', async () => {
  const calls = [];
  const store = {
    async ping() {},
    async listFor(args) { calls.push(args); return { items: [{ id: 1, message: 'hi' }], unread: 1 }; },
    async markAllRead() {},
  };
  const app = createApp({ store, queue: { queueStats: async () => ({ pending: 0, lag: 0 }) }, config: { jwtSecret: 's' },
    metrics: createMetrics(), chaos: createChaos(silent), logger: silent });
  const server = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/notifications`)).status, 401);
  const token = signToken({ email: 'sara@example.com', name: 'Sara', role: 'requester' }, 's');
  const res = await fetch(`${url}/api/notifications`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).unread, 1);
  assert.equal(calls[0].email, 'sara@example.com');
  assert.equal((await fetch(`${url}/health`)).status, 200);
  await new Promise((r) => server.close(r));
});
