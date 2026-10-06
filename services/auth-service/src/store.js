// Data access for auth-service (MySQL). Kept separate from HTTP code so it can be replaced in tests.
export function createMysqlStore(pool) {
  const store = {
    async ensureSchema() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          name VARCHAR(255) NOT NULL,
          picture VARCHAR(500) NULL,
          role ENUM('requester','agent') NOT NULL DEFAULT 'requester',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_login_at TIMESTAMP NULL
        )`);
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    async getUser(email) {
      const [rows] = await pool.query('SELECT email, name, picture, role FROM users WHERE email = ?', [email]);
      return rows[0] || null;
    },
    async upsertUser({ email, name, picture, role }) {
      await pool.query(
        `INSERT INTO users (email, name, picture, role, last_login_at) VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE name = VALUES(name), picture = VALUES(picture), role = VALUES(role), last_login_at = NOW()`,
        [email, name, picture || null, role]
      );
      return store.getUser(email);
    },
    async listUsers(role) {
      const [rows] = role
        ? await pool.query('SELECT email, name, role FROM users WHERE role = ? ORDER BY name', [role])
        : await pool.query('SELECT email, name, role FROM users ORDER BY name');
      return rows;
    },
  };
  return store;
}
