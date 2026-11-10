import assert from 'node:assert/strict';
import { test, after, before } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { registerModelsOn } from '../src/models.js';
import worker from '../src/index.js';
import { signToken } from '../src/jwt.js';

let repl, conn, models, env, adminToken, customerToken, category;
const pending = [];
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]).toString('base64');

async function call(path, method = 'GET', body, token = adminToken) {
  const response = await worker.fetch(new Request(`https://local.test${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), 'cf-connecting-ip': '127.0.0.1' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: p => pending.push(p) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

before(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.24' } });
  conn = await mongoose.createConnection(repl.getUri()).asPromise(); models = registerModelsOn(conn);
  const admin = await models.Admin.create({ name: 'מנהל בדיקה', email: 'local@test.invalid', passwordHash: 'unused', role: 'admin' });
  const customer = await models.User.create({ name: 'בדיקה', phone: '0500000001', role: 'customer' });
  const rate = { check: async (key, ms, max) => ({ allowed: true, max, count: 1, resetAt: Date.now() + ms }) };
  const auth = { hashPassword: p => bcrypt.hash(p, 4), verifyPassword: (p, h) => bcrypt.compare(p, h) };
  const binding = stub => ({ idFromName: x => x, get: () => stub });
  env = { MONGO_URI: repl.getUri(), JWT_SECRET: randomBytes(48).toString('hex'), DIRECT_MODE: '1', NODE_ENV: 'production', AUTH_DO: binding(auth), REALTIME_DO: binding({ broadcast: async () => ({ delivered: 0 }) }), RATE_LIMIT_DO: binding(rate) };
  adminToken = await signToken({ id: String(admin._id), role: 'admin' }, '1h', env);
  customerToken = await signToken({ id: String(customer._id), role: 'customer' }, '1h', env);
  category = await models.Category.create({ name: 'בדיקה תמונות', slug: 'img-test' });
  const originalFetch = global.fetch;
  global.fetch = (input, opts) => String(input).includes('hebcal.com') ? Promise.resolve(new Response(JSON.stringify({ items: [{ category: 'candles', date: '2099-01-01T16:00:00+02:00' }, { category: 'havdalah', date: '2099-01-02T20:00:00+02:00' }] }))) : originalFetch(input, opts);
});
after(async () => { await Promise.allSettled(pending); await conn?.close(); await repl?.stop(); });

test('image upload requires admin auth and valid content', async () => {
  assert.equal((await call('/api/admin/images', 'POST', { data: PNG_B64, contentType: 'image/png' }, '')).status, 401);
  assert.equal((await call('/api/admin/images', 'POST', { data: PNG_B64, contentType: 'image/png' }, customerToken)).status, 401);
  assert.equal((await call('/api/admin/images', 'POST', { data: PNG_B64, contentType: 'text/html' })).status, 400);
  assert.equal((await call('/api/admin/images', 'POST', { data: 'not-base64!!!', contentType: 'image/png' })).status, 400);
  const wrongMagic = await call('/api/admin/images', 'POST', { data: JPEG_B64, contentType: 'image/png' });
  assert.equal(wrongMagic.status, 400);
});

test('upload, serve with cache headers, and delete', async () => {
  const up = await call('/api/admin/images', 'POST', { data: PNG_B64, contentType: 'image/png' });
  assert.equal(up.status, 201); assert.ok(up.data.imageId); assert.ok(up.data.url.endsWith(`/api/images/${up.data.imageId}`));
  const got = await call(`/api/images/${up.data.imageId}`, 'GET', undefined, '');
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.ok((got.headers.get('cache-control') || '').includes('immutable'));
  assert.equal((await call('/api/admin/images/' + up.data.imageId, 'DELETE')).status, 200);
  assert.equal((await call(`/api/images/${up.data.imageId}`, 'GET', undefined, '')).status, 404);
});

test('uploaded image wins over URL; removal falls back to URL; replaced image is cleaned up', async () => {
  const up1 = await call('/api/admin/images', 'POST', { data: PNG_B64, contentType: 'image/png' });
  const created = await call('/api/admin/products', 'POST', { name: 'מוצר עם תמונה', category: String(category._id), price: 5, imageUrl: 'https://example.com/fallback.jpg', imageId: up1.data.imageId });
  assert.equal(created.status, 201);
  const pid = created.data.product._id;
  assert.ok(created.data.product.imageUrl.endsWith(`/api/images/${up1.data.imageId}`));
  assert.equal(created.data.product.sourceImageUrl, 'https://example.com/fallback.jpg');
  const catalog = await call('/api/catalog', 'GET', undefined, '');
  const inCatalog = catalog.data.products.find(p => String(p._id) === String(pid));
  assert.ok(inCatalog.imageUrl.endsWith(`/api/images/${up1.data.imageId}`));
  // replace upload -> old image deleted
  const up2 = await call('/api/admin/images', 'POST', { data: JPEG_B64, contentType: 'image/jpeg' });
  const replaced = await call(`/api/admin/products/${pid}`, 'PUT', { name: 'מוצר עם תמונה', category: String(category._id), price: 5, imageUrl: 'https://example.com/fallback.jpg', imageId: up2.data.imageId });
  assert.equal(replaced.status, 200);
  assert.ok(replaced.data.product.imageUrl.endsWith(`/api/images/${up2.data.imageId}`));
  assert.equal(await models.ProductImage.countDocuments({ _id: up1.data.imageId }), 0);
  // remove upload -> falls back to URL
  const removed = await call(`/api/admin/products/${pid}`, 'PUT', { name: 'מוצר עם תמונה', category: String(category._id), price: 5, imageUrl: 'https://example.com/fallback.jpg', imageId: null });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.product.imageUrl, 'https://example.com/fallback.jpg');
  assert.equal(await models.ProductImage.countDocuments({ _id: up2.data.imageId }), 0);
  // invalid imageId rejected
  assert.equal((await call(`/api/admin/products/${pid}`, 'PUT', { name: 'מוצר עם תמונה', category: String(category._id), price: 5, imageId: 'zzz' })).status, 400);
});
