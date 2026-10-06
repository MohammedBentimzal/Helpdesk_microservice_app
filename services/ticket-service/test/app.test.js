import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMetrics } from '../src/common/metrics.js';
import { createChaos } from '../src/common/chaos.js';
import { signToken } from '../src/common/auth.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {} };
const SECRET = 'test-secret';

function fakeStore() {
  const tickets = [];
  const comments = [];
  const store = {
    async ping() {},
    async createTicket(t) {
      const row = { id: tickets.length + 1, title: t.title, description: t.description, priority: t.priority, status: 'open',
        requester_email: t.requesterEmail, requester_name: t.requesterName, assignee_email: null, assignee_name: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), resolved_at: null };
      tickets.push(row); return { ...row };
    },
    async listTickets(f = {}) {
      return tickets.filter((t) => (!f.requesterEmail || t.requester_email === f.requesterEmail) && (!f.status || t.status === f.status));
    },
    async getTicket(id) { const t = tickets.find((x) => x.id === id); return t ? { ...t } : null; },
    async getComments(id) { return comments.filter((c) => c.ticket_id === id); },
    async updateTicket(id, { status, assignee }) {
      const t = tickets.find((x) => x.id === id);
      if (status !== undefined) { t.status = status; t.resolved_at = status === 'resolved' ? new Date().toISOString() : null; }
      if (assignee !== undefined) { t.assignee_email = assignee?.email ?? null; t.assignee_name = assignee?.name ?? null; }
      return { ...t };
    },
    async addComment(ticketId, c) {
      const row = { id: comments.length + 1, ticket_id: ticketId, author_email: c.authorEmail, author_name: c.authorName, author_role: c.authorRole, body: c.body };
      comments.push(row); return row;
    },
    async stats() {
      return { byStatus: { open: 0, in_progress: 0, resolved: 0 }, openByPriority: { low: 0, medium: 0, high: 0 }, avgResolutionSeconds: null };
    },
  };
  return store;
}

async function start({ redisUp = true, store = fakeStore() } = {}) {
  const events = [];
  const metrics = createMetrics();
  metrics.eventsPublished = new metrics.client.Counter({ name: 'events_published_total', help: 'x', labelNames: ['type'], registers: [metrics.register] });
  metrics.eventsFailed = new metrics.client.Counter({ name: 'events_publish_failures_total', help: 'x', labelNames: ['type'], registers: [metrics.register] });
  const publisher = {
    async publish(type, data) { if (!redisUp) { metrics.eventsFailed.inc({ type }); return false; } events.push({ type, data }); return true; },
    async ping() { if (!redisUp) throw new Error('down'); return true; },
  };
  const app = createApp({ store, publisher, config: { jwtSecret: SECRET }, metrics, chaos: createChaos(silent), logger: silent });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', body, token } = {}) =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { call, events, store, close: () => new Promise((r) => server.close(r)) };
}

const sara = signToken({ email: 'sara@example.com', name: 'Sara', role: 'requester' }, SECRET);
const omar = signToken({ email: 'omar@example.com', name: 'Omar', role: 'requester' }, SECRET);
const ahmed = signToken({ email: 'ahmed@example.com', name: 'Ahmed', role: 'agent' }, SECRET);

test('requires authentication', async () => {
  const s = await start();
  assert.equal((await s.call('/api/tickets')).status, 401);
  await s.close();
});

test('creates a ticket, validates input, and publishes an event', async () => {
  const s = await start();
  assert.equal((await s.call('/api/tickets', { method: 'POST', token: sara, body: { title: 'x' } })).status, 400);
  const res = await s.call('/api/tickets', { method: 'POST', token: sara, body: { title: 'Wi-Fi is down', priority: 'high' } });
  assert.equal(res.status, 201);
  assert.equal(s.events[0].type, 'ticket.created');
  assert.equal(s.events[0].data.priority, 'high');
  await s.close();
});

test('ticket creation still works when the queue (Redis) is down', async () => {
  const s = await start({ redisUp: false });
  const res = await s.call('/api/tickets', { method: 'POST', token: sara, body: { title: 'Printer jam' } });
  assert.equal(res.status, 201);
  const ready = await s.call('/ready');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).checks.redis, 'down');
  await s.close();
});

test('requesters only see their own tickets; agents see all', async () => {
  const s = await start();
  await s.call('/api/tickets', { method: 'POST', token: sara, body: { title: 'Sara ticket' } });
  await s.call('/api/tickets', { method: 'POST', token: omar, body: { title: 'Omar ticket' } });
  assert.equal((await (await s.call('/api/tickets', { token: sara })).json()).tickets.length, 1);
  assert.equal((await (await s.call('/api/tickets', { token: ahmed })).json()).tickets.length, 2);
  assert.equal((await s.call('/api/tickets/2', { token: sara })).status, 404);
  await s.close();
});

test('only agents can change status; assigning moves an open ticket to in_progress', async () => {
  const s = await start();
  await s.call('/api/tickets', { method: 'POST', token: sara, body: { title: 'Broken keyboard' } });
  assert.equal((await s.call('/api/tickets/1', { method: 'PATCH', token: sara, body: { status: 'resolved' } })).status, 403);
  const res = await s.call('/api/tickets/1', { method: 'PATCH', token: ahmed, body: { assignee: 'me' } });
  const { ticket } = await res.json();
  assert.equal(ticket.status, 'in_progress');
  assert.equal(ticket.assignee_email, 'ahmed@example.com');
  assert.ok(s.events.some((e) => e.type === 'ticket.assigned'));
  await s.close();
});

test('resolving a ticket publishes a status_changed event', async () => {
  const s = await start();
  await s.call('/api/tickets', { method: 'POST', token: sara, body: { title: 'Broken keyboard' } });
  const res = await s.call('/api/tickets/1', { method: 'PATCH', token: ahmed, body: { status: 'resolved' } });
  assert.equal((await res.json()).ticket.status, 'resolved');
  assert.ok(s.events.some((e) => e.type === 'ticket.status_changed' && e.data.status === 'resolved'));
  await s.close();
});

test('comments: owner and agents can comment, others get 404', async () => {
  const s = await start();
  await s.call('/api/tickets', { method: 'POST', token: sara, body: { title: 'Broken keyboard' } });
  assert.equal((await s.call('/api/tickets/1/comments', { method: 'POST', token: sara, body: { body: 'still broken' } })).status, 201);
  assert.equal((await s.call('/api/tickets/1/comments', { method: 'POST', token: omar, body: { body: 'hi' } })).status, 404);
  const detail = await (await s.call('/api/tickets/1', { token: ahmed })).json();
  assert.equal(detail.comments.length, 1);
  await s.close();
});

test('stats is agent-only', async () => {
  const s = await start();
  assert.equal((await s.call('/api/tickets/stats', { token: sara })).status, 403);
  assert.equal((await s.call('/api/tickets/stats', { token: ahmed })).status, 200);
  await s.close();
});

test('ready returns 503 when postgres is down; metrics expose business counters', async () => {
  const store = fakeStore();
  const s = await start({ store });
  await s.call('/api/tickets', { method: 'POST', token: sara, body: { title: 'Metric me', priority: 'low' } });
  const text = await (await s.call('/metrics')).text();
  assert.match(text, /tickets_created_total\{priority="low"\} 1/);
  store.ping = async () => { throw new Error('db down'); };
  assert.equal((await s.call('/ready')).status, 503);
  await s.close();
});
