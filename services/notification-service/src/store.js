// Data access for notification-service (MySQL).
// A notification's recipient is either a user email or the literal 'agents' (visible to every agent).
// Read state is a per-user watermark: everything up to last_read_id counts as read.
export function createMysqlStore(pool) {
  const visibleTo = `(recipient = ? OR (recipient = 'agents' AND ? = 'agent'))`;
  const store = {
    async ensureSchema() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          event_id VARCHAR(64) NOT NULL,
          recipient VARCHAR(255) NOT NULL,
          event_type VARCHAR(50) NOT NULL,
          ticket_id INT NULL,
          message VARCHAR(500) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_event_recipient (event_id, recipient),
          KEY idx_recipient (recipient, id)
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notification_reads (
          user_email VARCHAR(255) PRIMARY KEY,
          last_read_id BIGINT NOT NULL DEFAULT 0
        )`);
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    // INSERT IGNORE + unique key makes reprocessing the same stream entry harmless (at-least-once delivery).
    async add({ eventId, recipient, eventType, ticketId, message }) {
      const [result] = await pool.query(
        'INSERT IGNORE INTO notifications (event_id, recipient, event_type, ticket_id, message) VALUES (?, ?, ?, ?, ?)',
        [eventId, recipient, eventType, ticketId ?? null, message.slice(0, 500)]
      );
      return result.affectedRows === 1;
    },
    async listFor({ email, role, limit = 20 }) {
      const [items] = await pool.query(
        `SELECT id, event_type, ticket_id, message, created_at FROM notifications WHERE ${visibleTo} ORDER BY id DESC LIMIT ?`,
        [email, role, Number(limit)]
      );
      const [[{ unread }]] = await pool.query(
        `SELECT COUNT(*) AS unread FROM notifications
         WHERE ${visibleTo} AND id > COALESCE((SELECT last_read_id FROM notification_reads WHERE user_email = ?), 0)`,
        [email, role, email]
      );
      return { items, unread: Number(unread) };
    },
    async markAllRead({ email, role }) {
      const [[{ maxId }]] = await pool.query(`SELECT COALESCE(MAX(id), 0) AS maxId FROM notifications WHERE ${visibleTo}`, [email, role]);
      await pool.query(
        'INSERT INTO notification_reads (user_email, last_read_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_read_id = VALUES(last_read_id)',
        [email, maxId]
      );
    },
  };
  return store;
}
