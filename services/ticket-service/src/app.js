import express from 'express';
import { requireAuth, requireRole } from './common/auth.js';
import { wrap } from './common/util.js';
import { requestLogger } from './common/logger.js';

const PRIORITIES = ['low', 'medium', 'high'];
const STATUSES = ['open', 'in_progress', 'resolved'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createApp({ store, publisher, config, metrics, chaos, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(requestLogger(logger));
  app.use(metrics.middleware);
  app.use(chaos.middleware);

  // ---- business metrics ----
  const { client, register } = metrics;
  const ticketsCreated = new client.Counter({ name: 'tickets_created_total', help: 'Tickets created', labelNames: ['priority'], registers: [register] });
  const statusChanges = new client.Counter({ name: 'ticket_status_changes_total', help: 'Ticket status changes', labelNames: ['status'], registers: [register] });
  const resolutionSeconds = new client.Histogram({
    name: 'ticket_resolution_seconds',
    help: 'Time from creation to resolution',
    buckets: [60, 300, 900, 3600, 4 * 3600, 24 * 3600, 3 * 24 * 3600],
    registers: [register],
  });
  new client.Gauge({
    name: 'tickets_open',
    help: 'Tickets not yet resolved, by priority',
    labelNames: ['priority'],
    registers: [register],
    async collect() {
      try {
        const { openByPriority } = await store.stats();
        for (const p of PRIORITIES) this.set({ priority: p }, openByPriority[p] || 0);
      } catch (err) {
        logger.warn({ err: err.message }, 'could not collect tickets_open gauge');
      }
    },
  });

  // ---- operational endpoints ----
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (req, res) => {
    const checks = { postgres: 'ok', redis: 'ok' };
    try { await store.ping(); } catch (err) { checks.postgres = 'down'; logger.error({ err: err.message }, 'postgres check failed'); }
    try { await publisher.ping(); } catch { checks.redis = 'down'; }
    // Redis is informational only: tickets keep working without it (notifications catch up later).
    const ready = checks.postgres === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready', checks });
  });
  app.get('/metrics', wrap(async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  }));
  app.all('/chaos', chaos.handler);

  // ---- ticket API ----
  const auth = requireAuth(config.jwtSecret);
  const isAgent = (u) => u.role === 'agent';
  const canSee = (u, ticket) => isAgent(u) || ticket.requester_email === u.email;
  const parseId = (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: 'invalid ticket id' }); return null; }
    return id;
  };
  const eventData = (ticket, user, extra = {}) => ({
    ticketId: ticket.id,
    title: ticket.title,
    priority: ticket.priority,
    status: ticket.status,
    requesterEmail: ticket.requester_email,
    requesterName: ticket.requester_name,
    assigneeEmail: ticket.assignee_email,
    assigneeName: ticket.assignee_name,
    actorEmail: user.email,
    actorName: user.name,
    actorRole: user.role,
    ...extra,
  });

  app.post('/api/tickets', auth, wrap(async (req, res) => {
    const { title, description = '', priority = 'medium' } = req.body || {};
    if (typeof title !== 'string' || title.trim().length < 3 || title.length > 200) {
      return res.status(400).json({ error: 'title must be 3-200 characters' });
    }
    if (typeof description !== 'string' || description.length > 5000) return res.status(400).json({ error: 'description too long' });
    if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: `priority must be one of ${PRIORITIES.join(', ')}` });
    const ticket = await store.createTicket({
      title: title.trim(), description: description.trim(), priority,
      requesterEmail: req.user.email, requesterName: req.user.name,
    });
    ticketsCreated.inc({ priority });
    await publisher.publish('ticket.created', eventData(ticket, req.user));
    res.status(201).json({ ticket });
  }));

  app.get('/api/tickets', auth, wrap(async (req, res) => {
    const { status, priority, assignee } = req.query;
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: 'invalid priority' });
    const filters = { status, priority };
    if (isAgent(req.user)) filters.assignee = assignee === 'me' ? req.user.email : assignee;
    else filters.requesterEmail = req.user.email; // requesters only ever see their own tickets
    res.json({ tickets: await store.listTickets(filters) });
  }));

  // Must be declared before /:id
  app.get('/api/tickets/stats', auth, requireRole('agent'), wrap(async (req, res) => {
    res.json(await store.stats());
  }));

  app.get('/api/tickets/:id', auth, wrap(async (req, res) => {
    const id = parseId(req, res); if (id === null) return;
    const ticket = await store.getTicket(id);
    if (!ticket || !canSee(req.user, ticket)) return res.status(404).json({ error: 'ticket not found' });
    res.json({ ticket, comments: await store.getComments(id) });
  }));

  app.patch('/api/tickets/:id', auth, requireRole('agent'), wrap(async (req, res) => {
    const id = parseId(req, res); if (id === null) return;
    const before = await store.getTicket(id);
    if (!before) return res.status(404).json({ error: 'ticket not found' });
    const { status, assignee } = req.body || {};
    const changes = {};

    if (status !== undefined) {
      if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
      if (status !== before.status) changes.status = status;
    }
    let assigneeChanged = false;
    if (assignee !== undefined) {
      let next = null;
      if (assignee === 'me') next = { email: req.user.email, name: req.user.name };
      else if (assignee && typeof assignee === 'object') {
        if (!EMAIL_RE.test(assignee.email || '')) return res.status(400).json({ error: 'assignee.email invalid' });
        next = { email: assignee.email.toLowerCase(), name: assignee.name || assignee.email };
      } else if (assignee !== null) return res.status(400).json({ error: "assignee must be 'me', {email,name} or null" });
      if ((next?.email || null) !== before.assignee_email) { changes.assignee = next; assigneeChanged = true; }
      // Picking up an open ticket moves it to in_progress automatically.
      if (next && before.status === 'open' && changes.status === undefined) changes.status = 'in_progress';
    }

    if (Object.keys(changes).length === 0) return res.json({ ticket: before });
    const ticket = await store.updateTicket(id, changes);

    if (changes.status !== undefined) {
      statusChanges.inc({ status: changes.status });
      if (changes.status === 'resolved') {
        resolutionSeconds.observe((new Date(ticket.resolved_at) - new Date(ticket.created_at)) / 1000);
      }
    }
    if (assigneeChanged) await publisher.publish('ticket.assigned', eventData(ticket, req.user));
    if (status !== undefined && status !== before.status) {
      await publisher.publish('ticket.status_changed', eventData(ticket, req.user, { previousStatus: before.status }));
    }
    res.json({ ticket });
  }));

  app.post('/api/tickets/:id/comments', auth, wrap(async (req, res) => {
    const id = parseId(req, res); if (id === null) return;
    const ticket = await store.getTicket(id);
    if (!ticket || !canSee(req.user, ticket)) return res.status(404).json({ error: 'ticket not found' });
    const body = req.body?.body;
    if (typeof body !== 'string' || body.trim().length < 1 || body.length > 3000) {
      return res.status(400).json({ error: 'comment must be 1-3000 characters' });
    }
    const comment = await store.addComment(id, {
      authorEmail: req.user.email, authorName: req.user.name, authorRole: req.user.role, body: body.trim(),
    });
    await publisher.publish('ticket.commented', eventData(ticket, req.user, { commentPreview: body.trim().slice(0, 80) }));
    res.status(201).json({ comment });
  }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({ error: 'internal server error' });
  });
  return app;
}
