/**
 * reset-admin.js — Resets the admin account password using the same
 * PostgreSQL connection as the main app (via DATABASE_URL in .env).
 *
 * Usage:
 *   node reset-admin.js
 *
 * Make sure your .env has the correct DATABASE_URL before running.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const USERNAME = process.env.ADMIN_USERNAME || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD;

if (!PASSWORD) {
  console.error('❌  Set ADMIN_PASSWORD in your .env file first.');
  console.error('    Example: ADMIN_PASSWORD=greetingamerica1187');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set in .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
});

(async () => {
  try {
    console.log('🔌 Connecting to PostgreSQL...');

    const { rows } = await pool.query('SELECT id, username FROM admins ORDER BY id LIMIT 5');
    console.log('📋 Current admins:', rows.length ? rows : '(none)');

    const hash = bcrypt.hashSync(PASSWORD, 12);

    if (rows.length === 0) {
      await pool.query(
        'INSERT INTO admins (username, password) VALUES ($1, $2)',
        [USERNAME, hash]
      );
      console.log(`✅ Admin CREATED  →  username: "${USERNAME}"  password: "${PASSWORD}"`);
    } else {
      await pool.query(
        'UPDATE admins SET username=$1, password=$2 WHERE id=$3',
        [USERNAME, hash, rows[0].id]
      );
      console.log(`✅ Admin UPDATED  →  username: "${USERNAME}"  password: "${PASSWORD}"`);
    }

    await pool.end();
    console.log('✅ Done. You can now log in.');
  } catch (e) {
    console.error('❌ Failed:', e.message);
    process.exit(1);
  }
})();
