// Creates the tables (safe to run many times). Add --seed to insert sample products.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function run(conn, file) {
  const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
  await conn.query(sql);
  console.log(`Applied ${file}`);
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });
  try {
    await run(conn, 'schema.sql');
    if (process.argv.includes('--seed')) await run(conn, 'seed.sql');
  } finally {
    await conn.end();
  }
})().catch((e) => {
  console.error('DB init failed:', e.message);
  process.exit(1);
});
