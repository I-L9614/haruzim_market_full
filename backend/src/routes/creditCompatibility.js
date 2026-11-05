// Credit feature compatibility adapter. Production uses the Worker; the legacy
// Express backend registers identical guarded routes and accounting service.
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { webcrypto } = require('node:crypto');
const crypto = webcrypto;
const models = require('../models');
const { requireAuth, adminOnly, optionalCustomerAuth } = require('../middleware/auth');
const { shabbatMiddleware: shabbatGuard } = require('../middleware/shabbat');
const { createRateLimit } = require('../middleware/rateLimit');
const { notifyTelegramOrder: notify } = require('../services/orderNotifications');
const router = express.Router();
const localBuckets = new Map();
function limiterCheck(key, ms, max) {
  const now = Date.now(); let b = localBuckets.get(key);
  if (!b || b.resetAt <= now) { b = {count:0,resetAt:now+ms}; localBuckets.set(key,b); }
  b.count += 1;
  if(localBuckets.size>10000) for(const [k,v] of localBuckets) if(v.resetAt<=now)localBuckets.delete(k);
  return {allowed:b.count<=max,max,count:b.count,resetAt:b.resetAt};
}
const limiter = {idFromName:n=>n,get:()=>({check:async(...args)=>limiterCheck(...args)})};
const auth = {hashPassword:p=>bcrypt.hash(p,12),verifyPassword:(p,h)=>bcrypt.compare(p,h)};
function authStub() { return auth; }
function broadcast(c,event,payload) { if(global.io) global.io.emit(event,payload); }
async function notifyTelegramOrder(env, order) { return notify(order); }
async function readBody(c) { return c.get('body'); }
const isValidObjectId = mongoose.isValidObjectId;
const startSession = connection => connection.startSession();
const checkoutLimit = createRateLimit({windowMs:15*60*1000,max:15});
let creditPromise;
const app = {};
for(const verb of ['get','post','patch']) app[verb]=(path,...handlers)=>{
  const handler=handlers.pop();router[verb](path,...handlers,async(req,res,next)=>{
    try {
      const c={
        env:{...process.env,RATE_LIMIT_DO:limiter},
        executionCtx:{waitUntil:p=>Promise.resolve(p).catch(()=>{})},
        req:{param:k=>req.params[k],query:k=>req.query[k],header:k=>k==='cf-connecting-ip'?req.ip:req.headers[k.toLowerCase()],path:req.path},
        get:k=>({db:{models,connection:mongoose.connection},user:req.user,body:req.body,customerUser:req.customerUser}[k]),
        json:(data,status=200)=>res.status(status).json(data)
      };
      const {creditKey,validSecret,publicAccount,changeBalance,deliverCredit,problem}=await(creditPromise ||= import('../../../haruzim-worker/src/credit.js'));
      return await handler(c, {creditKey,validSecret,publicAccount,changeBalance,deliverCredit,problem});
    } catch(e){next(e);}
  });
};
// Imports are loaded once, but helper bindings below are module-local wrappers.
let creditModule;
async function loadCredit() { return creditModule ||= await import('../../../haruzim-worker/src/credit.js'); }
function problem(message,status=409){return Object.assign(new Error(message),{status,publicMessage:message});}
function creditKey(name){if(typeof name!=='string')throw problem('יש להזין שם לקוח להקפה.',400);const key=name.normalize('NFKC').trim().toLocaleLowerCase('he').replace(/\s+/g,' ');if(key.length<2||key.length>80||/[\x00-\x1f]/.test(key))throw problem('שם לקוח להקפה חייב להכיל 2 עד 80 תווים.',400);return key;}
function validSecret(value){return typeof value==='string'&&value.length>=8&&value.length<=72&&Buffer.byteLength(value)<=72;}
function publicAccount(a){return {_id:a._id,name:a.name,active:a.active,balanceCents:a.balanceCents,version:a.version,createdAt:a.createdAt,updatedAt:a.updatedAt};}
async function changeBalance(...args){return (await loadCredit()).changeBalance(...args);}
async function deliverCredit(...args){return (await loadCredit()).deliverCredit(...args);}

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
});app.patch('/api/admin/orders/:id/status', requireAuth, adminOnly, shabbatGuard, async (c) => {
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


module.exports = router;
