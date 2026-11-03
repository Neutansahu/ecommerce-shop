// Usage: node make-admin.js user@example.com
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const email = (process.argv[2] || '').toLowerCase();
  if (!email) {
    console.error('Usage: node make-admin.js user@example.com');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const [r] = await conn.query("UPDATE users SET role='admin' WHERE email = ?", [email]);
  console.log(r.affectedRows ? `Done: ${email} is now admin` : 'No user with that email (register on the site first)');
  await conn.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
