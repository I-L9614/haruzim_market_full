import assert from 'node:assert/strict';
import { test, after, before } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { registerModelsOn } from '../src/models.js';
import worker from '../src/index.js';
import { MAX_FAILURES, LOCK_MS, lockKey } from '../src/loginLock.js';

let repl, conn, models, env;
const pending = [];
const ADMIN_EMAIL = 'lock-admin@test.invalid';
const CUSTOMER_EMAIL = 'lock-customer@test.invalid';
const OTHER_EMAIL = 'other-customer@test.invalid';
const PASSWORD = 'correct-horse-12345';

async function call(path, body) {
  const response = await worker.fetch(new Request(`https://local.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '127.0.0.1' },
    body: JSON.stringify(body)
  }), env, { waitUntil: p => pending.push(p) });
  return { status: response.status, data: await response.json(), retryAfter: response.headers.get('Retry-After') };
}
const adminLogin = (email, password) => call('/api/auth/admin/login', { email, password });
const customerLogin = (email, password) => call('/api/auth/customer/login', { email, password });

before(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.24' } });
  conn = await mongoose.createConnection(repl.getUri()).asPromise();
  models = registerModelsOn(conn);
  const hash = await bcrypt.hash(PASSWORD, 4);
  await models.Admin.create({ name: 'מנהל נעילה', email: ADMIN_EMAIL, passwordHash: hash, role: 'admin' });
  await models.User.create({ name: 'לקוח נעילה', email: CUSTOMER_EMAIL, phone: '0500000011', passwordHash: hash, role: 'customer' });
  await models.User.create({ name: 'לקוח אחר', email: OTHER_EMAIL, phone: '0500000022', passwordHash: hash, role: 'customer' });
  const rate = { check: async (key, ms, max) => ({ allowed: true, max, count: 1, resetAt: Date.now() + ms }) };
  const auth = { hashPassword: p => bcrypt.hash(p, 4), verifyPassword: (p, h) => bcrypt.compare(p, h) };
  const binding = stub => ({ idFromName: x => x, get: () => stub });
  env = { MONGO_URI: repl.getUri(), JWT_SECRET: randomBytes(48).toString('hex'), DIRECT_MODE: '1', NODE_ENV: 'production', AUTH_DO: binding(auth), REALTIME_DO: binding({ broadcast: async () => ({ delivered: 0 }) }), RATE_LIMIT_DO: binding(rate) };
});
after(async () => { await Promise.allSettled(pending); await conn?.close(); await repl?.stop(); });

test('customer: 5th failed attempt locks the account for an hour', async () => {
  for (let i = 1; i < MAX_FAILURES; i++) {
    const r = await customerLogin(CUSTOMER_EMAIL, 'wrong-password');
    assert.equal(r.status, 401, `attempt ${i} should be a plain 401`);
    assert.equal(r.data.error, 'INVALID_CREDENTIALS');
  }
  const fifth = await customerLogin(CUSTOMER_EMAIL, 'wrong-password');
  assert.equal(fifth.status, 429);
  assert.equal(fifth.data.error, 'ACCOUNT_LOCKED');
  assert.match(fifth.data.message, /נחסם/);
  assert.ok(Number(fifth.retryAfter) > 3500 && Number(fifth.retryAfter) <= 3600, `Retry-After ${fifth.retryAfter}`);
  const doc = await models.LoginThrottle.findById(lockKey('customer', CUSTOMER_EMAIL)).lean();
  assert.ok(doc.lockedUntil.getTime() - Date.now() > LOCK_MS - 60000);
  assert.equal(doc.failures, 0);
});

test('locked account refuses even the correct password until the block expires', async () => {
  const r = await customerLogin(CUSTOMER_EMAIL, PASSWORD);
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'ACCOUNT_LOCKED');
  // Expire the block, then the same credentials succeed and clear the record.
  await models.LoginThrottle.updateOne({ _id: lockKey('customer', CUSTOMER_EMAIL) }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  const ok = await customerLogin(CUSTOMER_EMAIL, PASSWORD);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.token);
  assert.equal(await models.LoginThrottle.countDocuments({ _id: lockKey('customer', CUSTOMER_EMAIL) }), 0);
});

test('a successful login resets the failure counter', async () => {
  for (let i = 0; i < MAX_FAILURES - 1; i++) assert.equal((await customerLogin(CUSTOMER_EMAIL, 'nope')).status, 401);
  assert.equal((await customerLogin(CUSTOMER_EMAIL, PASSWORD)).status, 200);
  assert.equal(await models.LoginThrottle.countDocuments({ _id: lockKey('customer', CUSTOMER_EMAIL) }), 0);
  // After the reset, a fresh full set of failures is needed to lock again.
  for (let i = 1; i < MAX_FAILURES; i++) assert.equal((await customerLogin(CUSTOMER_EMAIL, 'nope')).status, 401, `attempt ${i} after reset`);
  assert.equal((await customerLogin(CUSTOMER_EMAIL, 'nope')).status, 429);
  await models.LoginThrottle.deleteOne({ _id: lockKey('customer', CUSTOMER_EMAIL) });
});

test('lock is per account and per scope: other accounts and other scope unaffected', async () => {
  for (let i = 0; i < MAX_FAILURES; i++) await customerLogin(CUSTOMER_EMAIL, 'nope');
  assert.equal((await customerLogin(CUSTOMER_EMAIL, PASSWORD)).status, 429);
  // Different customer account on the same IP is not blocked.
  assert.equal((await customerLogin(OTHER_EMAIL, PASSWORD)).status, 200);
  // Same email in the admin scope is a different account key.
  const adminScoped = await adminLogin(CUSTOMER_EMAIL, 'nope');
  assert.equal(adminScoped.status, 401);
  await models.LoginThrottle.deleteOne({ _id: lockKey('customer', CUSTOMER_EMAIL) });
  await models.LoginThrottle.deleteOne({ _id: lockKey('admin', CUSTOMER_EMAIL) });
});

test('admin login locks the same way, keyed separately from customer', async () => {
  for (let i = 1; i < MAX_FAILURES; i++) assert.equal((await adminLogin(ADMIN_EMAIL, 'bad')).status, 401);
  assert.equal((await adminLogin(ADMIN_EMAIL, 'bad')).status, 429);
  assert.equal((await adminLogin(ADMIN_EMAIL, PASSWORD)).status, 429);
  await models.LoginThrottle.updateOne({ _id: lockKey('admin', ADMIN_EMAIL) }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  assert.equal((await adminLogin(ADMIN_EMAIL, PASSWORD)).status, 200);
  assert.equal(await models.LoginThrottle.countDocuments({ _id: lockKey('admin', ADMIN_EMAIL) }), 0);
});

test('attempts against a nonexistent email are throttled without revealing existence', async () => {
  for (let i = 1; i < MAX_FAILURES; i++) assert.equal((await customerLogin('ghost@test.invalid', 'x')).status, 401);
  const r = await customerLogin('ghost@test.invalid', 'x');
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'ACCOUNT_LOCKED');
  await models.LoginThrottle.deleteOne({ _id: lockKey('customer', 'ghost@test.invalid') });
});

test('concurrent failed attempts count atomically and lock exactly once', async () => {
  const results = await Promise.all(Array.from({ length: MAX_FAILURES }, () => customerLogin(CUSTOMER_EMAIL, 'nope')));
  const locked = results.filter(r => r.status === 429);
  assert.equal(locked.length, 1, JSON.stringify(results.map(r => r.status)));
  assert.ok(results.every(r => r.status === 401 || r.status === 429));
  assert.equal((await customerLogin(CUSTOMER_EMAIL, PASSWORD)).status, 429);
  const doc = await models.LoginThrottle.findById(lockKey('customer', CUSTOMER_EMAIL)).lean();
  assert.ok(doc.lockedUntil.getTime() > Date.now());
  await models.LoginThrottle.deleteOne({ _id: lockKey('customer', CUSTOMER_EMAIL) });
});

test('email normalization: case and whitespace map to the same account key', async () => {
  for (let i = 1; i < MAX_FAILURES; i++) assert.equal((await customerLogin('  OTHER-Customer@Test.INVALID ', 'nope')).status, 401);
  assert.equal((await customerLogin(OTHER_EMAIL, 'nope')).status, 429);
  await models.LoginThrottle.deleteOne({ _id: lockKey('customer', OTHER_EMAIL) });
});
