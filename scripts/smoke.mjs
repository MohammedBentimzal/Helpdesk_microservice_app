// End-to-end smoke test of the running app. Usage: npm run smoke
// By default it talks to each service directly (ports 4001-4003).
// Set BASE_URL=http://localhost:5173 to go through the frontend proxy / ingress instead.
const BASE = process.env.BASE_URL;
const URLS = {
  auth: BASE || process.env.AUTH_URL || 'http://localhost:4001',
  tickets: BASE || process.env.TICKETS_URL || 'http://localhost:4002',
  notifications: BASE || process.env.NOTIFICATIONS_URL || 'http://localhost:4003',
};

let failed = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const fail = (name, detail) => { failed++; console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); };
const check = (name, cond, detail) => (cond ? ok(name) : fail(name, detail));

async function call(svc, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(URLS[svc] + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitFor(fn, { timeoutMs = 15000, everyMs = 500 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

async function login(email, name, role) {
  const r = await call('auth', '/api/auth/dev-login', { method: 'POST', body: { email, name, role } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)} (is AUTH_MODE=dev?)`);
  return r.data.token;
}

console.log('Helpdesk smoke test');
try {
  for (const [svc, path] of [['auth', '/api/auth/config'], ['tickets', '/api/tickets'], ['notifications', '/api/notifications']]) {
    const r = await call(svc, path);
    check(`${svc} is reachable`, r.status === 200 || r.status === 401, `status ${r.status}`);
  }

  const stamp = Date.now();
  const requesterEmail = `smoke-req-${stamp}@example.com`;
  const otherEmail = `smoke-other-${stamp}@example.com`;
  const agentEmail = `smoke-agent-${stamp}@example.com`;
  const requester = await login(requesterEmail, 'Smoke Requester', 'requester');
  const other = await login(otherEmail, 'Smoke Other', 'requester');
  const agent = await login(agentEmail, 'Smoke Agent', 'agent');
  ok('demo logins for requester and agent');

  const created = await call('tickets', '/api/tickets', { method: 'POST', token: requester, body: { title: `Smoke test ${stamp}`, description: 'created by smoke test', priority: 'high' } });
  check('requester creates a ticket', created.status === 201, `status ${created.status}`);
  const id = created.data.ticket?.id;

  const agentSawNew = await waitFor(async () => (await call('notifications', '/api/notifications', { token: agent })).data.items?.some((n) => n.ticket_id === id && /New high priority/.test(n.message)));
  check('agent is notified of the new ticket (queue -> worker -> MySQL)', !!agentSawNew);

  check('another requester cannot see the ticket', (await call('tickets', `/api/tickets/${id}`, { token: other })).status === 404);
  check('requester cannot change status', (await call('tickets', `/api/tickets/${id}`, { method: 'PATCH', token: requester, body: { status: 'resolved' } })).status === 403);

  const assigned = await call('tickets', `/api/tickets/${id}`, { method: 'PATCH', token: agent, body: { assignee: 'me' } });
  check('agent assigns the ticket (moves to in_progress)', assigned.status === 200 && assigned.data.ticket?.status === 'in_progress');

  const comment = await call('tickets', `/api/tickets/${id}/comments`, { method: 'POST', token: agent, body: { body: 'Please try restarting.' } });
  check('agent comments', comment.status === 201);

  const resolved = await call('tickets', `/api/tickets/${id}`, { method: 'PATCH', token: agent, body: { status: 'resolved' } });
  check('agent resolves the ticket', resolved.status === 200 && resolved.data.ticket?.status === 'resolved');

  const reqSaw = await waitFor(async () => {
    const items = (await call('notifications', '/api/notifications', { token: requester })).data.items || [];
    return items.some((n) => n.ticket_id === id && /Resolved/.test(n.message)) && items.some((n) => n.ticket_id === id && /assigned/.test(n.message));
  });
  check('requester is notified of assignment and resolution', !!reqSaw);

  const stats = await call('tickets', '/api/tickets/stats', { token: agent });
  check('agent stats endpoint works', stats.status === 200 && stats.data.byStatus?.resolved >= 1);

  if (!BASE) {
    const metrics = await (await fetch(`${URLS.tickets}/metrics`)).text();
    check('ticket-service exposes business metrics', /tickets_created_total/.test(metrics) && /tickets_open/.test(metrics));
  }
} catch (err) {
  fail('unexpected error', err.message);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
