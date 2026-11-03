import { useEffect, useState } from 'react';
import { api } from './api.js';

const money = (n) => Number(n).toFixed(2);

function readUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

export default function App() {
  const [view, setView] = useState('products'); // products | cart | login | orders | admin
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({}); // { productId: quantity }
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(readUser());
  const [orders, setOrders] = useState([]);
  const [msg, setMsg] = useState('');

  const loadProducts = () => api('/products').then(setProducts).catch((e) => setMsg(e.message));
  useEffect(() => { loadProducts(); }, []);

  const logout = (message) => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken('');
    setUser(null);
    setView('login');
    if (message) setMsg(message);
  };

  // an "Unauthorized" answer means the login expired
  const handleErr = (e) => {
    if (e.message === 'Unauthorized') logout('Session expired. Please log in again.');
    else setMsg(e.message);
  };

  const refreshOrders = () => api('/orders', { token }).then(setOrders).catch(handleErr);
  useEffect(() => { if (view === 'orders' && token) refreshOrders(); }, [view]);

  const addToCart = (id) => setCart((c) => ({ ...c, [id]: (c[id] || 0) + 1 }));
  const removeFromCart = (id) =>
    setCart((c) => {
      const n = { ...c };
      delete n[id];
      return n;
    });

  const cartItems = Object.entries(cart)
    .map(([id, quantity]) => ({ product: products.find((p) => p.id === Number(id)), quantity }))
    .filter((i) => i.product);
  const total = cartItems.reduce((s, i) => s + Number(i.product.price) * i.quantity, 0);
  const count = Object.values(cart).reduce((a, b) => a + b, 0);

  const payNow = async (order_id) => {
    try {
      const rp = await api('/payments/create-order', { method: 'POST', token, body: { order_id } });
      const options = {
        key: rp.key_id,
        amount: rp.amount,
        currency: rp.currency,
        order_id: rp.razorpay_order_id,
        name: 'Shop',
        description: `Order #${order_id}`,
        prefill: { name: user ? user.name : '' },
        handler: async (resp) => {
          try {
            await api('/payments/verify', { method: 'POST', token, body: resp });
            setMsg(`Payment successful for order #${order_id}`);
          } catch (e) {
            setMsg(e.message);
          }
          setView('orders');
          refreshOrders();
        },
        modal: {
          ondismiss: () => {
            setMsg('Payment not completed. You can pay from the Orders page.');
            setView('orders');
            refreshOrders();
          },
        },
      };
      new window.Razorpay(options).open();
    } catch (e) {
      // for example payments not configured yet: the order stays PENDING
      handleErr(e);
      setView('orders');
      refreshOrders();
    }
  };

  const placeOrder = async () => {
    if (!token) return setView('login');
    try {
      const items = cartItems.map((i) => ({ product_id: i.product.id, quantity: i.quantity }));
      const r = await api('/orders', { method: 'POST', token, body: { items } });
      setCart({});
      loadProducts();
      await payNow(r.order_id);
    } catch (e) {
      handleErr(e);
    }
  };

  return (
    <div>
      <header>
        <h1 onClick={() => setView('products')}>Shop</h1>
        <nav>
          <button onClick={() => setView('products')}>Products</button>
          <button onClick={() => setView('cart')}>Cart ({count})</button>
          {user ? (
            <>
              <button onClick={() => setView('orders')}>Orders</button>
              {user.role === 'admin' && <button onClick={() => setView('admin')}>Admin</button>}
              <button onClick={() => logout()}>Logout ({user.name})</button>
            </>
          ) : (
            <button onClick={() => setView('login')}>Login</button>
          )}
        </nav>
      </header>

      {msg && <p className="msg" onClick={() => setMsg('')}>{msg} (click to dismiss)</p>}

      <main>
        {view === 'products' && (
          <div className="grid">
            {products.length === 0 && <p>No products yet.</p>}
            {products.map((p) => (
              <div className="card" key={p.id}>
                {p.image_url && <img src={p.image_url} alt={p.name} />}
                <h3>{p.name}</h3>
                <p>{p.description}</p>
                <p><b>₹{money(p.price)}</b> · Stock: {p.stock}</p>
                <button disabled={p.stock < 1} onClick={() => addToCart(p.id)}>
                  {p.stock < 1 ? 'Out of stock' : 'Add to cart'}
                </button>
              </div>
            ))}
          </div>
        )}

        {view === 'cart' && (
          <div>
            <h2>Your cart</h2>
            {cartItems.length === 0 && <p>Cart is empty.</p>}
            {cartItems.map((i) => (
              <div className="row" key={i.product.id}>
                <span>{i.product.name} × {i.quantity}</span>
                <span>₹{money(Number(i.product.price) * i.quantity)}</span>
                <button onClick={() => removeFromCart(i.product.id)}>Remove</button>
              </div>
            ))}
            {cartItems.length > 0 && (
              <>
                <h3>Total: ₹{money(total)}</h3>
                <button onClick={placeOrder}>Place order</button>
              </>
            )}
          </div>
        )}

        {view === 'login' && (
          <AuthForm
            onMsg={setMsg}
            onDone={(data) => {
              localStorage.setItem('token', data.token);
              localStorage.setItem('user', JSON.stringify(data.user));
              setToken(data.token);
              setUser(data.user);
              setMsg('');
              setView('products');
            }}
          />
        )}

        {view === 'orders' && (
          <div>
            <h2>My orders</h2>
            {orders.length === 0 && <p>No orders yet.</p>}
            {orders.map((o) => (
              <div className="row" key={o.id}>
                <span>Order #{o.id}</span>
                <span>₹{money(o.total)}</span>
                <span>{o.status}</span>
                <span>{new Date(o.created_at).toLocaleString()}</span>
                {o.status === 'PENDING' && <button onClick={() => payNow(o.id)}>Pay now</button>}
              </div>
            ))}
          </div>
        )}

        {view === 'admin' && user && user.role === 'admin' && (
          <AdminForm
            token={token}
            onMsg={setMsg}
            onAdded={() => {
              loadProducts();
              setView('products');
            }}
          />
        )}
      </main>
    </div>
  );
}

function AuthForm({ onDone, onMsg }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    try {
      if (mode === 'register') {
        await api('/auth/register', { method: 'POST', body: form });
        onMsg('Registered. Please log in.');
        setMode('login');
      } else {
        const data = await api('/auth/login', {
          method: 'POST',
          body: { email: form.email, password: form.password },
        });
        onDone(data);
      }
    } catch (e) {
      onMsg(e.message);
    }
  };

  return (
    <div className="form">
      <h2>{mode === 'login' ? 'Login' : 'Register'}</h2>
      {mode === 'register' && <input placeholder="Name" value={form.name} onChange={set('name')} />}
      <input placeholder="Email" value={form.email} onChange={set('email')} />
      <input placeholder="Password (8+ characters)" type="password" value={form.password} onChange={set('password')} />
      <button onClick={submit}>{mode === 'login' ? 'Login' : 'Create account'}</button>
      <p className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'New user? Register' : 'Have an account? Login'}
      </p>
    </div>
  );
}

function AdminForm({ token, onMsg, onAdded }) {
  const [f, setF] = useState({ name: '', description: '', price: '', stock: '' });
  const [file, setFile] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async () => {
    try {
      let image_url = '';
      if (file) {
        const fd = new FormData();
        fd.append('image', file);
        const r = await fetch('/api/products/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Upload failed');
        image_url = d.image_url;
      }
      await api('/products', { method: 'POST', token, body: { ...f, image_url } });
      onMsg('Product added');
      onAdded();
    } catch (e) {
      onMsg(e.message);
    }
  };

  return (
    <div className="form">
      <h2>Add product (admin)</h2>
      <input placeholder="Name" value={f.name} onChange={set('name')} />
      <input placeholder="Description" value={f.description} onChange={set('description')} />
      <input placeholder="Price" type="number" value={f.price} onChange={set('price')} />
      <input placeholder="Stock" type="number" value={f.stock} onChange={set('stock')} />
      <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files[0])} />
      <button onClick={submit}>Add product</button>
    </div>
  );
}
