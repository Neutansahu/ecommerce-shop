require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const Razorpay = require('razorpay');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set');
  process.exit(1);
}

const app = express();
// Traffic arrives through CloudFront and then the load balancer, so trust 2 proxy hops
// to see the real client IP (needed for rate limiting).
app.set('trust proxy', 2);
app.use(helmet());
app.use(cors());

// ---------- clients ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
});

const s3 = new S3Client({ region: process.env.AWS_REGION });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) =>
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

// Razorpay is optional until the keys are added to Secrets Manager
const rzp = process.env.RAZORPAY_KEY_ID
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
// lets async route handlers throw without crashing the process
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false });

// ---------- health (used by the load balancer) ----------
app.get('/health', (req, res) => res.send('ok'));
app.get('/api/health', (req, res) => res.send('ok'));

// ---------- Razorpay webhook ----------
// Must be registered BEFORE express.json(): the signature is checked on the raw body.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), ah(async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).send('Webhook not configured');
  const sig = String(req.headers['x-razorpay-signature'] || '');
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(400).send('Invalid signature');
  }
  const event = JSON.parse(req.body.toString());
  if (event.event === 'order.paid' || event.event === 'payment.captured') {
    const p = event.payload.payment.entity;
    await pool.query(
      "UPDATE orders SET status='PAID', razorpay_payment_id=? WHERE razorpay_order_id=? AND status='PENDING'",
      [p.id, p.order_id]
    );
  }
  res.json({ ok: true });
}));

app.use(express.json());

// ---------- auth ----------
app.post('/api/auth/register', authLimiter, ah(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const hash = await bcrypt.hash(String(password), 10);
  try {
    await pool.query('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)', [name, email.toLowerCase(), hash]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already registered' });
    throw e;
  }
  res.status(201).json({ message: 'Registered' });
}));

app.post('/api/auth/login', authLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
}));

// ---------- products ----------
app.get('/api/products', ah(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
  res.json(rows);
}));

app.get('/api/products/:id', ah(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
  res.json(rows[0]);
}));

app.post('/api/products', auth, adminOnly, ah(async (req, res) => {
  const { name, description, price, stock, image_url } = req.body || {};
  const p = Number(price);
  const s = Number(stock);
  if (!name || !(p > 0) || !Number.isInteger(s) || s < 0) {
    return res.status(400).json({ error: 'Name, a price above 0 and a whole-number stock are required' });
  }
  const [r] = await pool.query(
    'INSERT INTO products (name, description, price, stock, image_url) VALUES (?,?,?,?,?)',
    [name, description || '', p, s, image_url || '']
  );
  res.status(201).json({ id: r.insertId });
}));

// Image goes to S3 (key images/<uuid>.<ext>) and CloudFront serves it at /images/...
app.post('/api/products/upload', auth, adminOnly, upload.single('image'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Only jpg, png or webp images up to 5 MB' });
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[req.file.mimetype]
    || path.extname(req.file.originalname).toLowerCase();
  const key = `images/${crypto.randomUUID()}${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
  }));
  res.json({ image_url: '/' + key });
}));

// ---------- orders ----------
// body: { items: [{ product_id, quantity }] }   (prices always come from the database)
app.post('/api/orders', auth, ah(async (req, res) => {
  const raw = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!raw.length) return res.status(400).json({ error: 'Cart is empty' });

  const merged = new Map();
  for (const it of raw) {
    const product_id = Number(it.product_id);
    const quantity = Number(it.quantity);
    if (!Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: 'Invalid cart item' });
    }
    merged.set(product_id, (merged.get(product_id) || 0) + quantity);
  }
  // same lock order for every request avoids database deadlocks
  const items = [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([product_id, quantity]) => ({ product_id, quantity }));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let totalCents = 0;
    const priced = [];
    for (const it of items) {
      const [rows] = await conn.query('SELECT price, stock FROM products WHERE id = ? FOR UPDATE', [it.product_id]);
      const p = rows[0];
      if (!p) throw new HttpError(400, 'A product in your cart no longer exists');
      if (p.stock < it.quantity) throw new HttpError(400, 'Not enough stock for one of the items');
      const cents = Math.round(Number(p.price) * 100);
      totalCents += cents * it.quantity;
      priced.push({ ...it, price: cents / 100 });
    }
    const [o] = await conn.query(
      'INSERT INTO orders (user_id, total, status) VALUES (?,?,?)',
      [req.user.id, totalCents / 100, 'PENDING']
    );
    for (const it of priced) {
      await conn.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)',
        [o.insertId, it.product_id, it.quantity, it.price]
      );
      await conn.query('UPDATE products SET stock = stock - ? WHERE id = ?', [it.quantity, it.product_id]);
    }
    await conn.commit();
    res.status(201).json({ order_id: o.insertId, total: totalCents / 100 });
  } catch (e) {
    await conn.rollback();
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    throw e;
  } finally {
    conn.release();
  }
}));

app.get('/api/orders', auth, ah(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
  res.json(rows);
}));

// ---------- payments ----------
app.post('/api/payments/create-order', auth, ah(async (req, res) => {
  if (!rzp) return res.status(503).json({ error: 'Payments are not configured yet' });
  const [rows] = await pool.query(
    'SELECT * FROM orders WHERE id = ? AND user_id = ?',
    [req.body && req.body.order_id, req.user.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'PENDING') return res.status(400).json({ error: 'Order is not payable' });

  const amount = Math.round(Number(order.total) * 100); // paise, taken from the database
  const rpOrder = await rzp.orders.create({ amount, currency: 'INR', receipt: `order_${order.id}` });
  await pool.query('UPDATE orders SET razorpay_order_id = ? WHERE id = ?', [rpOrder.id, order.id]);
  res.json({ key_id: process.env.RAZORPAY_KEY_ID, razorpay_order_id: rpOrder.id, amount, currency: 'INR' });
}));

app.post('/api/payments/verify', auth, ah(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !process.env.RAZORPAY_KEY_SECRET) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');
  const given = String(razorpay_signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }
  await pool.query(
    "UPDATE orders SET status='PAID', razorpay_payment_id=? WHERE razorpay_order_id=? AND user_id=? AND status='PENDING'",
    [razorpay_payment_id, razorpay_order_id, req.user.id]
  );
  res.json({ message: 'Payment verified' });
}));

// ---------- error handler ----------
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large (max 5 MB)' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- housekeeping: cancel orders unpaid for 30 minutes and return their stock ----------
setInterval(async () => {
  try {
    const [old] = await pool.query(
      "SELECT id FROM orders WHERE status='PENDING' AND created_at < (NOW() - INTERVAL 30 MINUTE)"
    );
    for (const o of old) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query("UPDATE orders SET status='CANCELLED' WHERE id=? AND status='PENDING'", [o.id]);
        if (r.affectedRows === 1) { // only one server wins when several run this job
          await conn.query(
            'UPDATE products p JOIN order_items oi ON oi.product_id = p.id SET p.stock = p.stock + oi.quantity WHERE oi.order_id = ?',
            [o.id]
          );
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
      } finally {
        conn.release();
      }
    }
  } catch (e) {
    console.error('cleanup error:', e.message);
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
