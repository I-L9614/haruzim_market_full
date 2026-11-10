import { creditKey, validSecret, publicAccount, changeBalance, deliverCredit, problem } from './credit.js';
import { Hono } from 'hono';
import { acquireDb, isValidObjectId, startSession } from './db.js';
import { signToken, verifyToken } from './jwt.js';
import { getShabbatStatus } from './shabbat.js';
import { createRateLimit } from './ratelimit.js';
import { AuthDO, RealtimeDO, RateLimitDO, registerApp } from './durable.js';

export { AuthDO, RealtimeDO, RateLimitDO };

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = new Hono();

// ---------- helpers ----------
function allowedOrigins(env) {
  return String(env.CLIENT_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
}

function authStub(env) {
  return env.AUTH_DO.get(env.AUTH_DO.idFromName('auth'));
}

function realtimeStub(env) {
  return env.REALTIME_DO.get(env.REALTIME_DO.idFromName('admin-feed'));
}

function broadcast(c, event, payload) {
  const stub = realtimeStub(c.env);
  // Mongoose .lean()/documents still contain BSON ObjectIds, which are not
  // structured-cloneable over the DO RPC boundary (DataCloneError). A JSON
  // round-trip converts them to plain strings/dates before the call.
  const safePayload = JSON.parse(JSON.stringify(payload));
  c.executionCtx.waitUntil(stub.broadcast(event, safePayload).catch((e) => console.warn('broadcast failed', e.name)));
}

async function readBody(c) {
  try { return await c.req.json(); } catch { return {}; }
}

// ---------- product images ----------
const IMAGE_TYPES = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'image/gif': [0x47, 0x49, 0x46, 0x38]
};
const MAX_IMAGE_BYTES = 700 * 1024;
const MAX_IMAGE_BASE64 = 1000000;

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function imageOrigin(c) {
  return new URL(c.req.url).origin;
}

// Responses expose imageUrl as the EFFECTIVE image (an uploaded image wins over
// the URL fallback); sourceImageUrl keeps the raw URL so edit forms don't lose it.
function withEffectiveImage(c, product) {
  if (!product) return product;
  const plain = typeof product.toObject === 'function' ? product.toObject() : { ...product };
  plain.sourceImageUrl = plain.imageUrl || '';
  if (plain.imageId) plain.imageUrl = `${imageOrigin(c)}/api/images/${plain.imageId}`;
  return plain;
}

function containsUnsafeMongoKey(value) {
  if (Array.isArray(value)) return value.some(containsUnsafeMongoKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key.startsWith('$') || key.includes('.') || containsUnsafeMongoKey(child));
}

// ---------- global middleware ----------
app.use('*', async (c, next) => {
  // security headers (helmet equivalent)
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Content-Security-Policy', "default-src 'self'");

  const origin = c.req.header('origin');
  const allowed = allowedOrigins(c.env);
  if (origin && !allowed.includes(origin)) {
    return c.json({ success: false, error: 'מקור הבקשה אינו מורשה.' }, 403);
  }
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') {
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return c.body(null, 204);
  }
  return next();
});

app.use('/api/*', async (c, next) => {
  let body = null;
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') body = await readBody(c);
  c.set('body', body);
  if ((body && containsUnsafeMongoKey(body)) || containsUnsafeMongoKey(c.req.param()) || containsUnsafeMongoKey(c.req.query())) {
    return c.json({ success: false, error: 'הבקשה מכילה שדות שאינם מורשים.' }, 400);
  }
  return next();
});

// Maintenance gate: while READ_ONLY=1, every mutation is refused before any
// auth, DB write, or rate-limit bucket is touched. Removed at cutover.
// ALLOW_AUTH=1 (acceptance testing): login POSTs pass the gate so a real
// sign-in can be verified end-to-end, while register/google/checkout/admin
// writes and every other mutation stay 503-blocked.
const AUTH_ALLOWLIST = new Set(['/api/auth/admin/login', '/api/auth/customer/login']);
app.use('/api/*', async (c, next) => {
  if (c.env.READ_ONLY === '1' && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const path = new URL(c.req.url).pathname;
    const authAllowed = c.env.ALLOW_AUTH === '1' && c.req.method === 'POST' && AUTH_ALLOWLIST.has(path);
    if (!authAllowed) {
      return c.json({ success: false, error: 'האתר בעבודות תחזוקה. נסו שוב בעוד זמן קצר.' }, 503);
    }
  }
  return next();
});

app.use('/api/*', createRateLimit({ windowMs: 15 * 60 * 1000, max: 600 }));

// open a fresh Mongo connection per request (documented Workers I/O restriction),
// close it after the response is complete.
// No index management here: required unique indexes were verified present on the
// existing database by read-only inspection; the worker never mutates schema.
app.use('/api/*', async (c, next) => {
  const lease = await acquireDb(c.env);
  c.set('db', lease.db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(Promise.resolve(lease.release()));
  }
});

// error handler
app.onError((error, c) => {
  const status = error.status || (error.name === 'ValidationError' || error.name === 'CastError' ? 400 : error.code === 11000 ? 409 : 500);
  const production = c.env.NODE_ENV === 'production';
  const safeMessage = status >= 500 ? 'אירעה שגיאה במערכת. נסו שוב מאוחר יותר.' : (error.publicMessage || error.message || 'הבקשה לא הצליחה.');
  console.error('API request failed', error.code || error.name, status, error.stack);
  return c.json({ success: false, error: safeMessage, ...(error.code && !production ? { code: String(error.code) } : {}) }, status);
});

async function shabbatGuard(c, next) {
  const status = await getShabbatStatus();
  if (!status.isShabbat) return next();
  return c.json({
    success: false,
    isShabbat: true,
    error: 'האתר סגור לפעילות בשבתות ובחגי ישראל. נשמח לראותכם במוצאי השבת!',
    startsAt: status.startsAt,
    endsAt: status.endsAt
  }, 503);
}

// ---------- auth middleware ----------
async function requireAuth(c, next) {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.json({ error: 'AUTH_REQUIRED', message: 'יש להזין טוקן אימות.' }, 401);
  let decoded;
  try { decoded = await verifyToken(token, c.env); }
  catch { return c.json({ error: 'INVALID_TOKEN', message: 'הטוקן אינו תקף.' }, 401); }
  const { Admin } = c.get('db').models;
  const admin = await Admin.findById(decoded.id).select('name email role active').lean();
  if (!admin || !admin.active) {
    return c.json({ error: 'ACCOUNT_DISABLED', message: 'החשבון אינו פעיל. יש לפנות למנהל המערכת.' }, 401);
  }
  c.set('user', { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role });
  return next();
}

async function requireCustomerAuth(c, next) {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.json({ error: 'AUTH_REQUIRED', message: 'יש להתחבר לחשבון לקוח.' }, 401);
  let decoded;
  try {
    decoded = await verifyToken(token, c.env);
    if (decoded.role !== 'customer') throw new Error('Wrong account type');
  } catch { return c.json({ error: 'INVALID_TOKEN', message: 'החיבור לחשבון פג. התחברו מחדש.' }, 401); }
  const { User } = c.get('db').models;
  const user = await User.findById(decoded.id).select('name email phone role').lean();
  if (!user || user.role !== 'customer') return c.json({ error: 'ACCOUNT_NOT_FOUND', message: 'חשבון הלקוח לא נמצא.' }, 401);
  c.set('customerUser', user);
  return next();
}

async function optionalCustomerAuth(c, next) {
  if (!c.req.header('authorization')) return next();
  return requireCustomerAuth(c, next);
}

async function adminOnly(c, next) {
  const user = c.get('user');
  if (!user || !['admin', 'manager'].includes(user.role)) {
    return c.json({ error: 'FORBIDDEN', message: 'אין הרשאה לגישה.' }, 403);
  }
  return next();
}

async function ownerOnly(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'OWNER_REQUIRED', message: 'רק מנהל ראשי יכול לנהל חשבונות מנהלים.' }, 403);
  }
  return next();
}

// ---------- public routes ----------
const loginLimit = createRateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'בוצעו יותר מדי ניסיונות התחברות. נסו שוב בעוד 15 דקות.' });
const checkoutLimit = createRateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: 'נשלחו יותר מדי הזמנות מהמכשיר הזה. נסו שוב מאוחר יותר.' });
const validateLimit = createRateLimit({ windowMs: 15 * 60 * 1000, max: 40 });

app.get('/api/health', (c) => {
  const ready = c.get('db').connection.readyState === 1;
  return c.json({ ok: ready, database: ready ? 'connected' : 'disconnected', service: 'haruzim-market-api' }, ready ? 200 : 503);
});

app.get('/api/shabbat/status', async (c) => {
  const status = await getShabbatStatus();
  return c.json({ success: true, ...status });
});

app.get('/api/catalog', async (c) => {
  const { Product } = c.get('db').models;
  const filter = { active: true };
  if (c.req.query('category')) filter.category = c.req.query('category');
  if (c.req.query('search')) filter.$text = { $search: c.req.query('search') };
  const products = await Product.find(filter).populate('category', 'name slug').sort({ name: 1 });
  return c.json({ products: products.map((product) => withEffectiveImage(c, product)) });
});

app.get('/api/categories', async (c) => {
  const { Category } = c.get('db').models;
  const categories = await Category.find({ active: true }).sort({ name: 1 });
  return c.json({ categories });
});

app.get('/api/featured-product', async (c) => {
  const { Product, StorefrontConfig } = c.get('db').models;
  const config = await StorefrontConfig.findById('storefront').select('featuredProduct').lean();
  if (!config?.featuredProduct) return c.json({ product: null });
  const product = await Product.findOne({
    _id: config.featuredProduct, active: true,
    $or: [{ stockQuantity: { $gt: 0 } }, { stockQuantity: null }, { stockQuantity: { $exists: false } }]
  }).populate('category', 'name slug').lean();
  return c.json({ product: product ? withEffectiveImage(c, product) : null });
});

// ---------- credit accounts: manager-only and isolated from customer login ----------
async function accountId(name) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(creditKey(name)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
app.get('/api/admin/credit-accounts', requireAuth, adminOnly, async (c) => {
  const accounts = await c.get('db').models.CreditAccount.find().sort({ name: 1 }).limit(1000).lean();
  return c.json({ accounts: accounts.map(publicAccount) });
});
app.post('/api/admin/credit-accounts', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const { name, password } = c.get('body') || {};
  const normalized = creditKey(name);
  if (!validSecret(password)) throw problem('הקוד חייב להכיל 8 עד 72 תווים (עד 72 בתים).', 400);
  const _id = await accountId(normalized);
  const passwordHash = await authStub(c.env).hashPassword(password);
  const db = c.get('db'), session = await db.connection.startSession();
  let account;
  try {
    await session.withTransaction(async () => {
      if (await db.models.CreditAccount.exists({ _id }).session(session)) throw problem('כבר קיים לקוח הקפה בשם הזה.');
      [account] = await db.models.CreditAccount.create([{ _id, name: name.normalize('NFKC').trim().replace(/\s+/g, ' '), passwordHash, createdBy: c.get('user').id }], { session });
      await db.models.CreditEntry.create([{ _id: `created:${_id}`, account: _id, kind: 'created', deltaCents: 0, beforeCents: 0, afterCents: 0, actorId: c.get('user').id, reason: 'פתיחת חשבון הקפה' }], { session });
    });
  } finally { await session.endSession(); }
  return c.json({ account: publicAccount(account) }, 201);
});
app.get('/api/admin/credit-accounts/:id/history', requireAuth, adminOnly, async (c) => {
  const { CreditAccount, CreditEntry } = c.get('db').models;
  const account = await CreditAccount.findById(c.req.param('id')).lean();
  if (!account) throw problem('לקוח ההקפה לא נמצא.', 404);
  const before = c.req.query('before');
  if (before && !Number.isFinite(Date.parse(before))) throw problem('תאריך היסטוריה אינו תקין.', 400);
  const entries = await CreditEntry.find({ account: account._id, ...(before ? { createdAt: { $lt: new Date(before) } } : {}) }).sort({ createdAt: -1 }).limit(101).lean();
  return c.json({ account: publicAccount(account), entries: entries.slice(0, 100), nextBefore: entries.length > 100 ? entries[99].createdAt : null });
});
app.patch('/api/admin/credit-accounts/:id/balance', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const account = await changeBalance(c.get('db'), { ...(c.get('body') || {}), accountId: c.req.param('id'), actorId: c.get('user').id });
  broadcast(c, 'creditUpdated', { accountId: account._id });
  return c.json({ account });
});
app.patch('/api/admin/credit-accounts/:id/access', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const { active, password, expectedVersion } = c.get('body') || {};
  if (!Number.isInteger(expectedVersion) || (active !== undefined && typeof active !== 'boolean') || (password !== undefined && !validSecret(password)) || (active === undefined && password === undefined)) throw problem('פרטי העדכון אינם תקינים. קוד חייב להכיל לפחות 8 תווים.', 400);
  const passwordHash = password === undefined ? undefined : await authStub(c.env).hashPassword(password);
  const db = c.get('db'), session = await db.connection.startSession(); let account;
  try { await session.withTransaction(async () => {
    account = await db.models.CreditAccount.findById(c.req.param('id')).session(session);
    if (!account) throw problem('לקוח ההקפה לא נמצא.', 404);
    if (account.version !== expectedVersion) throw problem('החשבון השתנה. רעננו ונסו שוב.');
    if (active !== undefined) account.active = active;
    if (passwordHash) account.passwordHash = passwordHash;
    account.version += 1; await account.save({ session });
    await db.models.CreditEntry.create([{ _id: crypto.randomUUID(), account: account._id, kind: passwordHash ? 'credentials' : 'access', deltaCents: 0, beforeCents: account.balanceCents, afterCents: account.balanceCents, actorId: c.get('user').id, reason: passwordHash ? 'החלפת קוד הקפה' : active ? 'הפעלת אפשרות הקפה' : 'חסימת הזמנות הקפה חדשות' }], { session });
  }); } finally { await session.endSession(); }
  return c.json({ account: publicAccount(account) });
});

// ---------- admin auth ----------
app.post('/api/auth/admin/login', loginLimit, async (c) => {
  const { email, password } = (await readBody(c)) || {};
  const { Admin } = c.get('db').models;
  const admin = await Admin.findOne({ email: String(email || '').trim().toLowerCase(), active: true });
  const ok = admin?.passwordHash ? await authStub(c.env).verifyPassword(String(password || ''), admin.passwordHash) : false;
  if (!admin || !ok) {
    return c.json({ error: 'INVALID_CREDENTIALS', message: 'אימייל או סיסמה שגויים.' }, 401);
  }
  const token = await signToken({ id: String(admin._id), email: admin.email, role: admin.role }, '12h', c.env);
  return c.json({ token, admin: { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role } });
});

app.get('/api/auth/admin/me', requireAuth, (c) => c.json({ admin: c.get('user') }));

// ---------- customer auth ----------
function customerResponse(user, token) {
  return { token, user: { id: String(user._id), name: user.name, email: user.email, phone: user.phone || '' } };
}

app.post('/api/auth/customer/register', loginLimit, async (c) => {
  const body = (await readBody(c)) || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').replace(/[\s()-]/g, '');
  const password = String(body.password || '');
  if (name.length < 2 || name.length > 120 || !emailPattern.test(email) || !/^\+?[0-9]{9,15}$/.test(phone) || password.length < 12 || password.length > 128) {
    return c.json({ error: 'INVALID_REGISTRATION', message: 'יש להזין שם, טלפון תקין, אימייל תקין וסיסמה באורך 12 תווים לפחות.' }, 400);
  }
  try {
    const passwordHash = await authStub(c.env).hashPassword(password);
    const { User } = c.get('db').models;
    const user = await User.create({ name, email, phone, passwordHash, role: 'customer' });
    const token = await signToken({ id: String(user._id), role: 'customer' }, '30d', c.env);
    return c.json(customerResponse(user, token), 201);
  } catch (error) {
    if (error.code === 11000) {
      if (error.keyPattern?.phone) return c.json({ error: 'PHONE_IN_USE', message: 'מספר הטלפון כבר משויך לחשבון קיים.' }, 409);
      return c.json({ error: 'EMAIL_IN_USE', message: 'כבר קיים חשבון עם כתובת האימייל הזו.' }, 409);
    }
    throw error;
  }
});

app.post('/api/auth/customer/login', loginLimit, async (c) => {
  const body = (await readBody(c)) || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const { User } = c.get('db').models;
  const user = await User.findOne({ email, role: 'customer' }).select('+passwordHash');
  const ok = user?.passwordHash ? await authStub(c.env).verifyPassword(password, user.passwordHash) : false;
  if (!user?.passwordHash || !ok) {
    return c.json({ error: 'INVALID_CREDENTIALS', message: 'האימייל או הסיסמה אינם נכונים.' }, 401);
  }
  const token = await signToken({ id: String(user._id), role: 'customer' }, '30d', c.env);
  return c.json(customerResponse(user, token));
});

app.post('/api/auth/customer/google', loginLimit, async (c) => {
  const clientId = String(c.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) {
    return c.json({ error: 'GOOGLE_LOGIN_NOT_CONFIGURED', message: 'התחברות Google עדיין לא הוגדרה באתר.' }, 503);
  }
  const body = (await readBody(c)) || {};
  const idToken = String(body.credential || '');
  if (!idToken || idToken.length > 10000) {
    return c.json({ error: 'INVALID_GOOGLE_CREDENTIAL', message: 'פרטי ההתחברות של Google אינם תקינים.' }, 400);
  }
  let claims;
  try {
    const verification = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!verification.ok) {
      return c.json({ error: 'INVALID_GOOGLE_CREDENTIAL', message: 'לא הצלחנו לאמת את חשבון Google.' }, 401);
    }
    claims = await verification.json();
  } catch {
    return c.json({ error: 'GOOGLE_VERIFY_FAILED', message: 'אימות מול Google נכשל. נסו שוב בעוד רגע.' }, 502);
  }
  if (claims.aud !== clientId || claims.email_verified !== 'true' || !claims.sub || !emailPattern.test(claims.email || '')) {
    return c.json({ error: 'INVALID_GOOGLE_CREDENTIAL', message: 'חשבון Google לא אומת עבור האתר.' }, 401);
  }
  try {
    const email = claims.email.trim().toLowerCase();
    const { User } = c.get('db').models;
    let user = await User.findOne({ googleSub: claims.sub, role: 'customer' });
    if (!user) {
      user = await User.findOne({ email, role: 'customer' });
      if (user) {
        user.googleSub = claims.sub;
        if (!user.name && claims.name) user.name = String(claims.name).slice(0, 120);
        await user.save();
      } else {
        user = await User.create({ name: String(claims.name || email.split('@')[0]).slice(0, 120), email, googleSub: claims.sub, role: 'customer' });
      }
    }
    const token = await signToken({ id: String(user._id), role: 'customer' }, '30d', c.env);
    return c.json(customerResponse(user, token));
  } catch (error) {
    if (error.code === 11000) {
      return c.json({ error: 'ACCOUNT_CONFLICT', message: 'חשבון זה כבר מקושר למשתמש אחר. פנו לתמיכה.' }, 409);
    }
    throw error;
  }
});

app.get('/api/auth/customer/me', requireCustomerAuth, (c) => {
  const u = c.get('customerUser');
  return c.json({ user: { id: String(u._id), name: u.name, email: u.email } });
});

// ---------- catalog stock validation + checkout ----------
async function getProductAlternatives(Product, product, limit = 3) {
  if (!product || !product.category) return [];
  const candidates = await Product.find({
    category: product.category, active: true,
    $or: [{ stockQuantity: { $gt: 0 } }, { stockQuantity: null }, { stockQuantity: { $exists: false } }],
    _id: { $ne: product._id }
  }).limit(limit).lean();
  return candidates.map((candidate) => ({
    productId: candidate._id, name: candidate.name,
    price: candidate.promotion?.price ?? candidate.price,
    stockQuantity: candidate.stockQuantity, category: candidate.category
  }));
}

async function validateCartStock(models, items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return { valid: false, unavailable: [], validItems: [] };
  }
  const { Product } = models;
  const safeItems = items.filter((item) => item && isValidObjectId(item.productId));
  const populated = await Product.find({ _id: { $in: safeItems.map((item) => item.productId) }, active: true }).lean();
  const byId = new Map(populated.map((product) => [String(product._id), product]));
  const unavailable = [];
  const validItems = [];

  for (const item of items) {
    const productId = item?.productId;
    const product = byId.get(String(productId));
    const requestedQty = Number(item?.quantity);
    if (!product) {
      unavailable.push({ productId, requested: requestedQty || 0, available: 0, alternatives: [] });
      continue;
    }
    if (!Number.isFinite(requestedQty) || requestedQty <= 0 || (product.unitType !== 'weight' && !Number.isInteger(requestedQty))) {
      unavailable.push({ productId: item.productId, requested: requestedQty || 0, available: product.stockQuantity, alternatives: await getProductAlternatives(Product, product) });
      continue;
    }
    if (product.stockQuantity != null && requestedQty > product.stockQuantity) {
      unavailable.push({ productId: item.productId, requested: requestedQty, available: product.stockQuantity, alternatives: await getProductAlternatives(Product, product) });
      continue;
    }
    validItems.push({
      productId: product._id, quantity: requestedQty, name: product.name,
      unitType: product.unitType || 'units', unitPrice: product.promotion?.price ?? product.price, stockQuantity: product.stockQuantity
    });
  }
  return { valid: unavailable.length === 0, unavailable, validItems };
}

app.post('/api/checkout/validate', validateLimit, shabbatGuard, async (c) => {
  const body = (await readBody(c)) || {};
  const validation = await validateCartStock(c.get('db').models, body.items);
  return c.json({
    valid: validation.valid, stock_issue: !validation.valid,
    missingItems: validation.unavailable, alternatives: validation.unavailable, validItems: validation.validItems
  }, validation.valid ? 200 : 400);
});

app.post('/api/checkout', checkoutLimit, shabbatGuard, optionalCustomerAuth, async (c) => {
  const body = (await readBody(c)) || {};
  const { customer, items } = body;
  let creditAccount = null;
  if (body.paymentMethod !== undefined && !['offline', 'credit'].includes(body.paymentMethod)) throw problem('סוג תשלום אינו תקין.', 400);
  if (body.paymentMethod === 'credit') {
    const ip = c.req.header('cf-connecting-ip') || 'unknown';
    const limiter = c.env.RATE_LIMIT_DO.get(c.env.RATE_LIMIT_DO.idFromName('limiter'));
    const ipLimit = await limiter.check(`credit-login:${ip}`, 15 * 60 * 1000, 10);
    if (!ipLimit.allowed) throw problem('בוצעו יותר מדי ניסיונות הקפה. נסו שוב בעוד 15 דקות.', 429);
    let key;
    try { key = await accountId(body.creditCredentials?.name); } catch { throw problem('שם או קוד הקפה שגויים.', 401); }
    const accountLimit = await limiter.check(`credit-account:${key}`, 15 * 60 * 1000, 30);
    if (!accountLimit.allowed) throw problem('בוצעו יותר מדי ניסיונות הקפה. נסו שוב בעוד 15 דקות.', 429);
    const candidate = await c.get('db').models.CreditAccount.findById(key).select('+passwordHash').lean();
    // Fixed cost dummy hash avoids revealing whether the name exists.
    const hash = candidate?.passwordHash || '$2b$12$C6UzMDM.H6dfI/f/IKcEe.3OQFhA5IvM1aT3edFrVZ1ZpQHeXG6um';
    const secret = body.creditCredentials?.password;
    const ok = validSecret(secret) && await authStub(c.env).verifyPassword(secret, hash);
    if (!candidate?.active || !ok) throw problem('שם או קוד הקפה שגויים.', 401);
    creditAccount = candidate;
  }
  const phone = String(customer?.phone || '').replace(/[\s()-]/g, '');
  if (!String(customer?.name || '').trim() || !/^\+?[0-9]{9,15}$/.test(phone) || !String(customer?.address?.street || '').trim() || !String(customer?.address?.city || '').trim() || !Array.isArray(items) || items.length === 0 || items.length > 100) {
    return c.json({ error: 'INVALID_CHECKOUT', message: 'יש למלא שם, טלפון תקין, כתובת למשלוח ולפחות מוצר אחד.' }, 400);
  }
  if (items.some((item) => !item || !isValidObjectId(item.productId) || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 || Number(item.quantity) > 1000)) {
    return c.json({ error: 'INVALID_ITEMS', message: 'פרטי המוצרים בעגלה אינם תקינים.' }, 400);
  }
  const normalizedCustomer = {
    name: String(customer.name).trim().slice(0, 120), phone,
    email: String(customer.email || '').trim().slice(0, 160),
    address: {
      street: String(customer.address.street).trim().slice(0, 160),
      city: String(customer.address.city).trim().slice(0, 100),
      apartment: String(customer.address.apartment || '').trim().slice(0, 50)
    },
    notes: String(customer.notes || '').trim().slice(0, 1000)
  };

  const validation = await validateCartStock(c.get('db').models, items);
  if (!validation.valid) {
    return c.json({
      status: 'stock_issue', stock_issue: true, message: 'חלק מהפריטים אינם זמינים במלאי.',
      missingItems: validation.unavailable, validItems: validation.validItems
    }, 400);
  }

  const { Order, Product, User, CreditAccount } = c.get('db').models;
  const customerUser = c.get('customerUser');
  let session;
  let createdOrder;
  try {
    session = await startSession(c.get('db').connection);
    await session.withTransaction(async () => {
      if (creditAccount) {
        // Touch the account in this transaction so disabling/resetting a code
        // concurrently cannot authorize an order with stale credentials.
        const authorized = await CreditAccount.updateOne({ _id: creditAccount._id, active: true, passwordHash: creditAccount.passwordHash }, { $inc: { version: 1 } }, { session });
        if (authorized.matchedCount !== 1) throw problem('פרטי ההקפה השתנו. יש להזין אותם מחדש.', 401);
      }
      const products = await Product.find({ _id: { $in: items.map((item) => item.productId) }, active: true }).session(session);
      const byId = new Map(products.map((product) => [String(product._id), product]));
      const orderItems = [];
      for (const item of items) {
        const product = byId.get(String(item.productId));
        const quantity = Number(item.quantity);
        if (!product || quantity <= 0 || (product.unitType !== 'weight' && !Number.isInteger(quantity)) || (product.stockQuantity != null && quantity > product.stockQuantity)) {
          throw Object.assign(new Error('OUT_OF_STOCK'), { status: 409 });
        }
        const unitPrice = product.promotion?.price ?? product.price;
        orderItems.push({ product: product._id, name: product.name, unitType: product.unitType || 'units', quantity, unitPrice, total: quantity * unitPrice });
        if (product.stockQuantity != null) {
          product.stockQuantity -= quantity;
          await product.save({ session });
        }
      }
      const subtotal = orderItems.reduce((sum, item) => sum + item.total, 0);
      const userUpdate = { $set: { name: normalizedCustomer.name }, $addToSet: { addresses: normalizedCustomer.address } };
      let user;
      if (customerUser) {
        const phoneOwner = await User.findOne({ phone: normalizedCustomer.phone }).select('_id').session(session);
        if (!phoneOwner || String(phoneOwner._id) === String(customerUser._id)) userUpdate.$set.phone = normalizedCustomer.phone;
        user = await User.findOneAndUpdate({ _id: customerUser._id }, userUpdate, { new: true, session });
      } else {
        user = await User.findOneAndUpdate({ phone: normalizedCustomer.phone }, userUpdate, { upsert: true, new: true, session });
      }
      [createdOrder] = await Order.create([{
        user: user._id, items: orderItems, customer: normalizedCustomer, subtotal, total: subtotal,
        status: creditAccount ? 'pending' : 'pending_payment', payment: { provider: creditAccount ? 'credit' : 'offline', status: 'pending' }, fulfillment: { status: 'pending' }, ...(creditAccount ? { credit: { account: creditAccount._id, name: creditAccount.name } } : {})
      }], { session });
    });
  } catch (error) {
    if (error.status === 409 || error.message === 'OUT_OF_STOCK') {
      return c.json({ error: 'OUT_OF_STOCK', message: 'חלק מהמוצרים אזלו מהמלאי. יש לרענן את העגלה.', stock_issue: true }, 409);
    }
    throw error;
  } finally {
    if (session) await session.endSession();
  }

  broadcast(c, 'newOrder', {
    orderId: createdOrder._id, total: createdOrder.total, customer: createdOrder.customer,
    items: createdOrder.items, status: createdOrder.status, payment: createdOrder.payment,
    fulfillment: createdOrder.fulfillment, credit: createdOrder.credit, createdAt: createdOrder.createdAt
  });
  c.executionCtx.waitUntil(notifyTelegramOrder(c.env, createdOrder));

  return c.json({ order: createdOrder, message: 'ההזמנה נשמרה ותשלום ומשלוח יתואמו טלפונית.' }, 201);
});

async function notifyTelegramOrder(env, order) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  const text = [
    'התקבלה הזמנה חדשה בחנות',
    `מספר: ${order._id}`,
    `לקוח: ${order.customer?.name || '—'}`,
    `טלפון: ${order.customer?.phone || '—'}`,
    `כתובת: ${[order.customer?.address?.street, order.customer?.address?.apartment, order.customer?.address?.city].filter(Boolean).join(', ') || '—'}`,
    `סכום: ${Number(order.total || 0).toFixed(2)} ₪`,
    'סטטוס: ממתינה לתשלום ותיאום משלוח'
  ].join('\n');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }), signal: controller.signal
    });
    if (!response.ok) throw new Error(`Telegram responded with ${response.status}`);
  } catch (error) {
    console.warn('Order notification could not be delivered', error.name || 'TELEGRAM_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

app.post('/api/orders/:id/track', async (c) => {
  if (!isValidObjectId(c.req.param('id'))) {
    return c.json({ error: 'ORDER_NOT_FOUND', message: 'לא נמצאה הזמנה התואמת לפרטים.' }, 404);
  }
  const body = (await readBody(c)) || {};
  const { Order } = c.get('db').models;
  const order = await Order.findById(c.req.param('id')).lean();
  const phone = String(body.phone || '').replace(/[\s()-]/g, '');
  if (!order || !phone || order.customer?.phone !== phone) {
    return c.json({ error: 'ORDER_NOT_FOUND', message: 'לא נמצאה הזמנה התואמת לפרטים.' }, 404);
  }
  return c.json({
    order: {
      _id: order._id, total: order.total, status: order.status,
      payment: { status: order.payment?.status || 'pending' },
      fulfillment: { status: order.fulfillment?.status || 'pending' },
      createdAt: order.createdAt,
      items: order.items.map(({ name, quantity, unitPrice, total }) => ({ name, quantity, unitPrice, total }))
    }
  });
});

// ---------- customer orders ----------
app.get('/api/customer/orders', requireCustomerAuth, async (c) => {
  const { Order } = c.get('db').models;
  const orders = await Order.find({ user: c.get('customerUser')._id })
    .sort({ createdAt: -1 }).limit(50)
    .select('items total status payment.status fulfillment.status createdAt').lean();
  return c.json({ orders });
});

app.post('/api/customer/orders/:id/reorder', requireCustomerAuth, async (c) => {
  if (!isValidObjectId(c.req.param('id'))) {
    return c.json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה בחשבון.' }, 404);
  }
  const { Order } = c.get('db').models;
  const order = await Order.findOne({ _id: c.req.param('id'), user: c.get('customerUser')._id }).lean();
  if (!order) return c.json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה בחשבון.' }, 404);
  const validation = await validateCartStock(c.get('db').models, order.items.map((item) => ({ productId: item.product, quantity: item.quantity })));
  const available = validation.validItems.map((item) => ({
    productId: String(item.productId), name: item.name, quantity: item.quantity,
    unitType: item.unitType || 'units', price: item.unitPrice, stockQuantity: item.stockQuantity
  }));
  return c.json({
    available, missingItems: validation.unavailable,
    message: validation.unavailable.length ? 'הוספנו מוצרים זמינים בלבד; חלק מהמוצרים כבר אינם זמינים.' : 'הפריטים הזמינים נוספו לעגלה.'
  });
});

// ---------- admin: stats ----------
app.get('/api/admin/stats', requireAuth, adminOnly, async (c) => {
  const { Order } = c.get('db').models;
  const [orders, topProducts] = await Promise.all([
    Order.find({}).lean(),
    Order.aggregate([
      { $match: { 'payment.status': 'paid', status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.product', totalSold: { $sum: '$items.quantity' } } },
      { $sort: { totalSold: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $project: { _id: 0, productId: '$_id', name: '$product.name', totalSold: 1 } }
    ])
  ]);
  const totalRevenue = orders.reduce((sum, order) => sum + (order.payment?.status === 'paid' ? Number(order.total) || 0 : 0), 0);
  const orderStatuses = { pending_payment: 0, pending: 0, preparing: 0, shipped: 0, delivered: 0, cancelled: 0 };
  for (const order of orders) {
    const status = order.status || 'pending_payment';
    if (orderStatuses[status] !== undefined) orderStatuses[status] += 1;
  }
  return c.json({ totalRevenue, totalOrders: orders.length, orderStatusBreakdown: orderStatuses, topSellingProducts: topProducts });
});

// ---------- admin: orders ----------
app.get('/api/admin/orders', requireAuth, adminOnly, async (c) => {
  const { Order } = c.get('db').models;
  const pageSize = 100;
  const filter = {};
  const cursorDate = new Date(String(c.req.query('before') || ''));
  const cursorId = String(c.req.query('id') || '');
  if (c.req.query('before') || c.req.query('id')) {
    if (!Number.isFinite(cursorDate.getTime()) || !isValidObjectId(cursorId)) {
      return c.json({ error: 'INVALID_CURSOR', message: 'לא ניתן לטעון את ההיסטוריה כרגע.' }, 400);
    }
    filter.$or = [{ createdAt: { $lt: cursorDate } }, { createdAt: cursorDate, _id: { $lt: cursorId } }];
  }
  const result = await Order.find(filter).sort({ createdAt: -1, _id: -1 }).limit(pageSize + 1).lean();
  const hasMore = result.length > pageSize;
  const orders = result.slice(0, pageSize);
  const lastOrder = orders[orders.length - 1];
  return c.json({ orders, nextCursor: hasMore && lastOrder ? { createdAt: lastOrder.createdAt, id: String(lastOrder._id) } : null });
});

app.patch('/api/admin/orders/:id/status', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const body = (await readBody(c)) || {};
  const { paymentStatus, fulfillmentStatus } = body;
  const allowedPayment = ['pending', 'paid', 'failed'];
  const allowedFulfillment = ['pending', 'shipped', 'delivered', 'cancelled'];
  const id = c.req.param('id');
  if (!isValidObjectId(id) || !allowedPayment.includes(paymentStatus) || !allowedFulfillment.includes(fulfillmentStatus)) {
    return c.json({ error: 'INVALID_ORDER_STATUS', message: 'סטטוס ההזמנה אינו תקין.' }, 400);
  }
  const { Order, Product } = c.get('db').models;
  let session;

  if (fulfillmentStatus === 'cancelled') {
    let cancelledOrder;
    try {
      session = await startSession(c.get('db').connection);
      await session.withTransaction(async () => {
        const order = await Order.findById(id).session(session);
        if (!order) return;
        const previousFulfillment = order.fulfillment?.status || 'pending';
        if (order.payment?.status === 'paid') {
          throw Object.assign(new Error('PAID_ORDER_REQUIRES_MANUAL_REFUND'), { status: 409 });
        }
        if (previousFulfillment !== 'cancelled') {
          if (previousFulfillment !== 'pending') {
            throw Object.assign(new Error('ORDER_ALREADY_DISPATCHED'), { status: 409 });
          }
          for (const item of order.items) {
            await Product.updateOne({ _id: item.product, stockQuantity: { $ne: null } }, { $inc: { stockQuantity: item.quantity } }, { session });
          }
          order.fulfillment = { status: 'cancelled', updatedAt: new Date() };
          order.status = 'cancelled';
          await order.save({ session });
        }
        cancelledOrder = order;
      });
    } finally {
      if (session) await session.endSession();
    }
    if (!cancelledOrder) return c.json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה.' }, 404);
    broadcast(c, 'orderUpdated', {
      orderId: cancelledOrder._id, status: cancelledOrder.status, payment: cancelledOrder.payment,
      fulfillment: cancelledOrder.fulfillment, updatedAt: cancelledOrder.updatedAt
    });
    return c.json({ order: cancelledOrder });
  }

  const currentOrder = await Order.findById(id).lean();
  if (!currentOrder) return c.json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה.' }, 404);
  if (currentOrder.payment?.provider === 'credit') {
    if (paymentStatus !== 'pending') throw problem('זו הזמנת הקפה. תקבולים ושינוי יתרה יש לרשום בחשבון לקוח ההקפה.', 409);
    if (fulfillmentStatus === 'delivered') {
      const order = await deliverCredit(c.get('db'), { orderId: id, decision: body.creditDecision, actorId: c.get('user').id, paymentStatus });
      broadcast(c, 'orderUpdated', { orderId: order._id, status: order.status, payment: order.payment, fulfillment: order.fulfillment, credit: order.credit, updatedAt: order.updatedAt });
      broadcast(c, 'creditUpdated', { accountId: order.credit.account });
      return c.json({ order });
    }
  }
  const currentFulfillment = currentOrder.fulfillment?.status || 'pending';
  if (currentFulfillment === 'cancelled' || (currentOrder.payment?.status === 'paid' && paymentStatus !== 'paid')) {
    return c.json({ error: 'ORDER_TRANSITION_NOT_ALLOWED', message: 'לא ניתן לשנות את סטטוס ההזמנה במצב הנוכחי.' }, 409);
  }
  if ((fulfillmentStatus === 'shipped' && !['pending', 'shipped'].includes(currentFulfillment)) ||
      (fulfillmentStatus === 'delivered' && !['shipped', 'delivered'].includes(currentFulfillment)) ||
      (fulfillmentStatus === 'pending' && currentFulfillment !== 'pending')) {
    return c.json({ error: 'ORDER_TRANSITION_NOT_ALLOWED', message: 'יש לעדכן את סטטוס המשלוח לפי סדר השלבים.' }, 409);
  }
  const status = currentOrder.payment?.provider === 'credit' ? (fulfillmentStatus === 'shipped' ? 'shipped' : 'pending') : paymentStatus !== 'paid'
    ? (paymentStatus === 'failed' ? 'cancelled' : 'pending_payment')
    : fulfillmentStatus === 'delivered' ? 'delivered' : fulfillmentStatus === 'shipped' ? 'shipped' : 'preparing';
  const order = await Order.findOneAndUpdate({ _id: id, 'fulfillment.status': currentFulfillment, 'payment.status': currentOrder.payment.status }, {
    $set: { 'payment.status': paymentStatus, 'fulfillment.status': fulfillmentStatus, 'fulfillment.updatedAt': new Date(), status }
  }, { new: true, runValidators: true });
  if (!order) throw problem('ההזמנה השתנתה במכשיר אחר. רעננו ונסו שוב.');
  broadcast(c, 'orderUpdated', {
    orderId: order._id, status: order.status, payment: order.payment,
    fulfillment: order.fulfillment, updatedAt: order.updatedAt
  });
  return c.json({ order });
});

// ---------- admin: managers ----------
app.get('/api/admin/managers', requireAuth, ownerOnly, async (c) => {
  const { Admin } = c.get('db').models;
  const managers = await Admin.find({ role: 'manager' }).select('name email role active createdAt updatedAt').sort({ active: -1, name: 1 }).lean();
  return c.json({ managers });
});

app.post('/api/admin/managers', requireAuth, ownerOnly, shabbatGuard, async (c) => {
  const body = (await readBody(c)) || {};
  const cleanName = String(body.name || '').trim();
  const cleanEmail = String(body.email || '').trim().toLowerCase();
  const cleanPassword = String(body.password || '');
  if (cleanName.length < 2 || cleanName.length > 100 || !emailPattern.test(cleanEmail) || cleanPassword.length < 12 || cleanPassword.length > 128) {
    return c.json({ error: 'INVALID_MANAGER', message: 'יש להזין שם תקין, כתובת אימייל וסיסמה באורך 12 תווים לפחות.' }, 400);
  }
  try {
    const passwordHash = await authStub(c.env).hashPassword(cleanPassword);
    const { Admin } = c.get('db').models;
    const manager = await Admin.create({ name: cleanName, email: cleanEmail, passwordHash, role: 'manager', active: true });
    return c.json({ manager: { _id: manager._id, name: manager.name, email: manager.email, role: manager.role, active: manager.active, createdAt: manager.createdAt } }, 201);
  } catch (error) {
    if (error.code === 11000) return c.json({ error: 'EMAIL_IN_USE', message: 'כבר קיים חשבון ניהול עם כתובת האימייל הזו.' }, 409);
    throw error;
  }
});

app.delete('/api/admin/managers/:id', requireAuth, ownerOnly, shabbatGuard, async (c) => {
  const { Admin } = c.get('db').models;
  const manager = await Admin.findOneAndUpdate(
    { _id: c.req.param('id'), role: 'manager', active: true },
    { $set: { active: false } },
    { new: true, runValidators: true }
  ).select('name email role active createdAt updatedAt');
  if (!manager) return c.json({ error: 'MANAGER_NOT_FOUND', message: 'המנהל לא נמצא או שכבר הוסר.' }, 404);
  return c.json({ manager });
});

// ---------- admin: product images ----------
app.post('/api/admin/images', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const body = (await readBody(c)) || {};
  const contentType = String(body.contentType || '').toLowerCase();
  const base64 = String(body.data || '').replace(/\s/g, '');
  if (!IMAGE_TYPES[contentType]) return c.json({ error: 'INVALID_IMAGE_TYPE', message: 'סוג הקובץ אינו נתמך. אפשר להעלות JPG, PNG, WebP או GIF.' }, 400);
  if (!base64 || base64.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) return c.json({ error: 'INVALID_IMAGE', message: 'קובץ התמונה אינו תקין או גדול מדי.' }, 400);
  let bytes;
  try { bytes = base64ToBytes(base64); } catch { return c.json({ error: 'INVALID_IMAGE', message: 'קובץ התמונה אינו תקין.' }, 400); }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return c.json({ error: 'IMAGE_TOO_LARGE', message: 'התמונה גדולה מדי. נסו תמונה קטנה יותר.' }, 400);
  const magic = IMAGE_TYPES[contentType];
  const magicOk = magic.every((b, i) => bytes[i] === b) && (contentType !== 'image/webp' || (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50));
  if (!magicOk) return c.json({ error: 'INVALID_IMAGE', message: 'תוכן הקובץ אינו תואם לסוג התמונה.' }, 400);
  const { ProductImage } = c.get('db').models;
  const user = c.get('user');
  const image = await ProductImage.create({ data: base64, contentType, size: bytes.length, createdBy: user?.email || '' });
  const id = String(image._id);
  return c.json({ imageId: id, url: `${imageOrigin(c)}/api/images/${id}` }, 201);
});

app.get('/api/images/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidObjectId(id)) return c.json({ error: 'IMAGE_NOT_FOUND', message: 'התמונה לא נמצאה.' }, 404);
  const { ProductImage } = c.get('db').models;
  const image = await ProductImage.findById(id).lean();
  if (!image) return c.json({ error: 'IMAGE_NOT_FOUND', message: 'התמונה לא נמצאה.' }, 404);
  let bytes;
  try { bytes = base64ToBytes(image.data); } catch { return c.json({ error: 'IMAGE_NOT_FOUND', message: 'התמונה לא נמצאה.' }, 404); }
  return c.body(bytes, 200, {
    'Content-Type': image.contentType,
    'Content-Length': String(bytes.length),
    'Cache-Control': 'public, max-age=31536000, immutable'
  });
});

app.delete('/api/admin/images/:id', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const id = c.req.param('id');
  if (!isValidObjectId(id)) return c.json({ error: 'INVALID_IMAGE_ID', message: 'מזהה התמונה אינו תקין.' }, 400);
  const { ProductImage } = c.get('db').models;
  const deleted = await ProductImage.findByIdAndDelete(id);
  if (!deleted) return c.json({ error: 'IMAGE_NOT_FOUND', message: 'התמונה לא נמצאה.' }, 404);
  return c.json({ deleted: true });
});

// ---------- admin: products + catalog ----------
function validateProductInput(body) {
  const name = String(body?.name || '').trim();
  const category = String(body?.category || '');
  const price = Number(body?.price);
  const rawStockQuantity = body?.stockQuantity;
  const stockQuantity = rawStockQuantity === '' || rawStockQuantity === null || rawStockQuantity === undefined ? null : Number(rawStockQuantity);
  const unitType = body?.unitType || 'units';
  const promotionPrice = body?.promotionPrice === '' || body?.promotionPrice === null || body?.promotionPrice === undefined ? null : Number(body.promotionPrice);
  const imageUrl = String(body?.imageUrl || '').trim();
  const rawImageId = body?.imageId;
  const imageId = rawImageId === undefined ? undefined : (rawImageId === null || rawImageId === '' ? null : String(rawImageId));

  if (name.length < 2 || name.length > 160) return { error: 'יש להזין שם מוצר באורך 2–160 תווים.' };
  if (!isValidObjectId(category)) return { error: 'יש לבחור קטגוריה תקינה.' };
  if (!Number.isFinite(price) || price < 0 || price > 1000000) return { error: 'המחיר חייב להיות מספר תקין ולא שלילי.' };
  if (stockQuantity !== null && (!Number.isFinite(stockQuantity) || stockQuantity < 0 || stockQuantity > 1000000)) return { error: 'כמות המלאי חייבת להיות מספר תקין ולא שלילי.' };
  if (!['units', 'weight'].includes(unitType)) return { error: 'סוג המכירה אינו תקין.' };
  if (unitType === 'units' && stockQuantity !== null && !Number.isInteger(stockQuantity)) return { error: 'מלאי של מוצר הנמכר ביחידות חייב להיות מספר שלם.' };
  if (promotionPrice !== null && (!Number.isFinite(promotionPrice) || promotionPrice < 0 || promotionPrice >= price)) return { error: 'מחיר המבצע חייב להיות תקין ונמוך מהמחיר הרגיל.' };
  if (imageUrl && (!/^https?:\/\//i.test(imageUrl) || imageUrl.length > 2000)) return { error: 'כתובת התמונה חייבת להתחיל ב-http:// או https://.' };
  if (imageId !== undefined && imageId !== null && !isValidObjectId(imageId)) return { error: 'מזהה התמונה שהועלתה אינו תקין.' };

  return {
    value: {
      name,
      description: String(body.description || '').trim().slice(0, 2000),
      imageUrl, ...(imageId !== undefined ? { imageId } : {}), category, price,
      promotion: promotionPrice === null ? undefined : { label: 'מבצע', price: promotionPrice },
      unitType,
      unitLabel: unitType === 'weight' ? 'ק״ג' : 'יחידה',
      stockQuantity,
      active: body.active === undefined ? true : body.active === true || body.active === 'true'
    }
  };
}

app.get('/api/admin/products', requireAuth, adminOnly, async (c) => {
  const { Product, Category } = c.get('db').models;
  const products = await Product.find({}).populate('category', 'name slug').sort({ active: -1, name: 1 }).lean();
  const categories = await Category.find({ active: true }).select('name slug').sort({ name: 1 }).lean();
  return c.json({ products: products.map((product) => withEffectiveImage(c, product)), categories });
});

app.post('/api/admin/products', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const validated = validateProductInput((await readBody(c)) || {});
  if (validated.error) return c.json({ error: 'INVALID_PRODUCT', message: validated.error }, 400);
  const { Product, Category } = c.get('db').models;
  const categoryExists = await Category.exists({ _id: validated.value.category, active: true });
  if (!categoryExists) return c.json({ error: 'INVALID_CATEGORY', message: 'הקטגוריה אינה קיימת או אינה פעילה.' }, 400);
  const product = await Product.create(validated.value);
  await product.populate('category', 'name slug');
  return c.json({ product: withEffectiveImage(c, product) }, 201);
});

const updateProductHandler = async (c) => {
  if (!isValidObjectId(c.req.param('id'))) return c.json({ error: 'INVALID_PRODUCT_ID', message: 'מזהה המוצר אינו תקין.' }, 400);
  const validated = validateProductInput((await readBody(c)) || {});
  if (validated.error) return c.json({ error: 'INVALID_PRODUCT', message: validated.error }, 400);
  const { Product, Category } = c.get('db').models;
  const categoryExists = await Category.exists({ _id: validated.value.category, active: true });
  if (!categoryExists) return c.json({ error: 'INVALID_CATEGORY', message: 'הקטגוריה אינה קיימת או אינה פעילה.' }, 400);
  const previous = await Product.findById(c.req.param('id')).select('imageId').lean();
  const update = { $set: validated.value };
  if (validated.value.promotion === undefined) update.$unset = { promotion: 1 };
  const product = await Product.findByIdAndUpdate(c.req.param('id'), update, { new: true, runValidators: true }).populate('category', 'name slug');
  if (!product) return c.json({ error: 'PRODUCT_NOT_FOUND', message: 'המוצר לא נמצא.' }, 404);
  const oldImageId = previous?.imageId ? String(previous.imageId) : null;
  const newImageId = validated.value.imageId === undefined ? oldImageId : validated.value.imageId;
  if (oldImageId && newImageId !== oldImageId) {
    const { ProductImage } = c.get('db').models;
    await ProductImage.deleteOne({ _id: oldImageId }).catch(() => {});
  }
  return c.json({ product: withEffectiveImage(c, product) });
};
app.put('/api/admin/products/:id', requireAuth, adminOnly, shabbatGuard, updateProductHandler);
app.patch('/api/admin/products/:id', requireAuth, adminOnly, shabbatGuard, updateProductHandler);

app.delete('/api/admin/products/:id', requireAuth, adminOnly, shabbatGuard, async (c) => {
  if (!isValidObjectId(c.req.param('id'))) return c.json({ error: 'INVALID_PRODUCT_ID', message: 'מזהה המוצר אינו תקין.' }, 400);
  const { Product } = c.get('db').models;
  const product = await Product.findByIdAndUpdate(c.req.param('id'), { $set: { active: false } }, { new: true, runValidators: true }).populate('category', 'name slug');
  if (!product) return c.json({ error: 'PRODUCT_NOT_FOUND', message: 'המוצר לא נמצא.' }, 404);
  return c.json({ product, message: 'המוצר הוסר מהחנות. נתוני הזמנות קודמות נשמרו.' });
});

app.post('/api/admin/catalog/categories', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const body = (await readBody(c)) || {};
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 80) {
    return c.json({ error: 'INVALID_CATEGORY', message: 'שם הקטגוריה חייב להכיל 2–80 תווים.' }, 400);
  }
  const { Category } = c.get('db').models;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = await Category.findOne({ name: new RegExp(`^${escapedName}$`, 'i') });
  if (existing) return c.json({ error: 'CATEGORY_EXISTS', message: 'כבר קיימת קטגוריה בשם הזה.' }, 409);
  const slugBase = name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'category';
  let slug = slugBase;
  let suffix = 2;
  while (await Category.exists({ slug })) slug = `${slugBase}-${suffix++}`;
  try {
    const category = await Category.create({ name, slug, active: true });
    return c.json({ category }, 201);
  } catch (error) {
    if (error.code === 11000) return c.json({ error: 'CATEGORY_EXISTS', message: 'כבר קיימת קטגוריה בשם הזה.' }, 409);
    throw error;
  }
});

app.get('/api/admin/catalog/featured-product', requireAuth, adminOnly, async (c) => {
  const { StorefrontConfig } = c.get('db').models;
  const config = await StorefrontConfig.findById('storefront').select('featuredProduct').lean();
  return c.json({ productId: config?.featuredProduct ? String(config.featuredProduct) : '' });
});

app.put('/api/admin/catalog/featured-product', requireAuth, adminOnly, shabbatGuard, async (c) => {
  const body = (await readBody(c)) || {};
  const productId = String(body.productId || '');
  if (productId && !isValidObjectId(productId)) {
    return c.json({ error: 'INVALID_PRODUCT_ID', message: 'בחירת המוצר אינה תקינה.' }, 400);
  }
  const { Product, StorefrontConfig } = c.get('db').models;
  if (productId && !await Product.exists({
    _id: productId, active: true,
    $or: [{ stockQuantity: { $gt: 0 } }, { stockQuantity: null }, { stockQuantity: { $exists: false } }]
  })) {
    return c.json({ error: 'PRODUCT_NOT_AVAILABLE', message: 'אפשר לבחור רק מוצר פעיל ובמלאי.' }, 404);
  }
  const config = await StorefrontConfig.findByIdAndUpdate('storefront', {
    $set: { featuredProduct: productId || null }
  }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }).lean();
  return c.json({ productId: config.featuredProduct ? String(config.featuredProduct) : '' });
});

// ---------- realtime (replaces Socket.IO; Electron admin app rewrite deferred) ----------
// Token travels in Sec-WebSocket-Protocol, never in the URL (query tokens leak into logs).
// Browser/Electron client: new WebSocket(url, ['bearer', token]); server replies with protocol 'bearer'.
app.get('/realtime', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'EXPECTED_WEBSOCKET' }, 426);
  }
  const offered = (c.req.header('sec-websocket-protocol') || '').split(',').map((p) => p.trim());
  const token = offered.length === 2 && offered[0] === 'bearer' ? offered[1] : null;
  if (!token) return c.json({ error: 'AUTH_REQUIRED' }, 401);
  try {
    const decoded = await verifyToken(token, c.env);
    const lease = await acquireDb(c.env);
    const db = lease.db;
    try {
      const admin = await db.models.Admin.findById(decoded.id).select('role active').lean();
      if (!admin?.active || !['admin', 'manager'].includes(admin.role)) {
        return c.json({ error: 'FORBIDDEN' }, 403);
      }
    } finally {
      c.executionCtx.waitUntil(Promise.resolve(lease.release()));
    }
  } catch {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }
  // WebSocket upgrade responses must pass through the socket object itself
  const response = await realtimeStub(c.env).fetch(c.req.raw);
  return new Response(null, {
    status: 101,
    webSocket: response.webSocket,
    headers: { 'Sec-WebSocket-Protocol': 'bearer' }
  });
});

// Free-plan Workers allow only 10 ms CPU per request; the API (MongoDB driver,
// mongoose, BSON, JSON) needs more, so the real work runs inside the API Durable
// Object (30 s CPU budget) and the front Worker only forwards the request.
// DIRECT_MODE=1 restores the previous in-Worker behaviour (rollback switch).
registerApp((request, env, ctx) => app.fetch(request, { ...env, SHARED_DB: '1' }, ctx));

export default {
  async fetch(request, env, ctx) {
    if (env.DIRECT_MODE === '1') return app.fetch(request, env, ctx);
    const stub = env.AUTH_DO.get(env.AUTH_DO.idFromName('api-v1'));
    return stub.fetch(request);
  }
};
