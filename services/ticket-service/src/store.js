// Data access for ticket-service (PostgreSQL).
const TICKET_COLS = `id, title, description, priority, status, requester_email, requester_name,
  assignee_email, assignee_name, created_at, updated_at, resolved_at`;

export function createPgStore(pool) {
  const store = {
    async ensureSchema() {
      // Advisory lock: several replicas may start at once, and CREATE TABLE IF NOT EXISTS can race.
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(727001)');
        await client.query(`
          CREATE TABLE IF NOT EXISTS tickets (
            id SERIAL PRIMARY KEY,
            title VARCHAR(200) NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
            status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
            requester_email VARCHAR(255) NOT NULL,
            requester_name VARCHAR(255) NOT NULL,
            assignee_email VARCHAR(255),
            assignee_name VARCHAR(255),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            resolved_at TIMESTAMPTZ
          )`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_email)');
        await client.query(`
          CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            author_email VARCHAR(255) NOT NULL,
            author_name VARCHAR(255) NOT NULL,
            author_role VARCHAR(20) NOT NULL,
            body TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id)');
      } finally {
        await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
        client.release();
      }
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    async createTicket({ title, description, priority, requesterEmail, requesterName }) {
      const { rows } = await pool.query(
        `INSERT INTO tickets (title, description, priority, requester_email, requester_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${TICKET_COLS}`,
        [title, description, priority, requesterEmail, requesterName]
      );
      return rows[0];
    },

    async listTickets({ requesterEmail, status, priority, assignee } = {}) {
      const where = [];
      const params = [];
      const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
      if (requesterEmail) add('requester_email = ?', requesterEmail);
      if (status) add('status = ?', status);
      if (priority) add('priority = ?', priority);
      if (assignee === 'unassigned') where.push('assignee_email IS NULL');
      else if (assignee) add('assignee_email = ?', assignee);
      const sql = `SELECT ${TICKET_COLS} FROM tickets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY created_at DESC LIMIT 200`;
      const { rows } = await pool.query(sql, params);
      return rows;
    },

    async getTicket(id) {
      const { rows } = await pool.query(`SELECT ${TICKET_COLS} FROM tickets WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    async getComments(ticketId) {
      const { rows } = await pool.query(
        'SELECT id, author_email, author_name, author_role, body, created_at FROM comments WHERE ticket_id = $1 ORDER BY created_at',
        [ticketId]
      );
      return rows;
    },

    async updateTicket(id, { status, assignee }) {
      // assignee: undefined = unchanged, null = unassign, {email,name} = assign
      const sets = ['updated_at = now()'];
      const params = [];
      const add = (sql, value) => { params.push(value); sets.push(sql.replace('?', `$${params.length}`)); };
      if (status !== undefined) {
        add('status = ?', status);
        sets.push(status === 'resolved' ? 'resolved_at = now()' : 'resolved_at = NULL');
      }
      if (assignee !== undefined) {
        add('assignee_email = ?', assignee ? assignee.email : null);
        add('assignee_name = ?', assignee ? assignee.name : null);
      }
      params.push(id);
      const { rows } = await pool.query(
        `UPDATE tickets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${TICKET_COLS}`,
        params
      );
      return rows[0] || null;
    },

    async addComment(ticketId, { authorEmail, authorName, authorRole, body }) {
      const { rows } = await pool.query(
        `INSERT INTO comments (ticket_id, author_email, author_name, author_role, body)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, author_email, author_name, author_role, body, created_at`,
        [ticketId, authorEmail, authorName, authorRole, body]
      );
      await pool.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [ticketId]);
      return rows[0];
    },

    async stats() {
      const { rows: byStatus } = await pool.query('SELECT status, COUNT(*)::int AS count FROM tickets GROUP BY status');
      const { rows: byPriority } = await pool.query(
        "SELECT priority, COUNT(*)::int AS count FROM tickets WHERE status <> 'resolved' GROUP BY priority"
      );
      const { rows: avg } = await pool.query(
        'SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))::float AS seconds FROM tickets WHERE resolved_at IS NOT NULL'
      );
      const statusCounts = { open: 0, in_progress: 0, resolved: 0 };
      byStatus.forEach((r) => { statusCounts[r.status] = r.count; });
      const priorityCounts = { low: 0, medium: 0, high: 0 };
      byPriority.forEach((r) => { priorityCounts[r.priority] = r.count; });
      return { byStatus: statusCounts, openByPriority: priorityCounts, avgResolutionSeconds: avg[0]?.seconds ?? null };
    },

    async seedIfEmpty() {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM tickets');
      if (rows[0].n > 0) return false;
      const demo = [
        ['Laptop cannot connect to Wi-Fi', 'It worked yesterday, now the network is not listed.', 'high', 'sara@example.com', 'sara'],
        ['Request access to the shared drive', 'I need read access to the Finance folder.', 'medium', 'sara@example.com', 'sara'],
        ['Projector in room B12 is flickering', 'Happens after about ten minutes.', 'low', 'omar@example.com', 'omar'],
      ];
      for (const [title, description, priority, email, name] of demo) {
        await store.createTicket({ title, description, priority, requesterEmail: email, requesterName: name });
      }
      return true;
    },
  };
  return store;
}
