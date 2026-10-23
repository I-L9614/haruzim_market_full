const test = require('node:test');
const assert = require('node:assert/strict');
const { getIsraelTime, isShabbatMode, fallbackWindow } = require('../src/middleware/shabbat');
const { charge } = require('../src/services/calGateway');
const { containsUnsafeMongoKey } = require('../src/middleware/sanitizeMongoInput');
const { getErrorResponse } = require('../src/middleware/errorHandler');

test('Shabbat clock handles midnight as 00:00 in Israel', () => {
  const midnight = new Date('2026-10-02T21:00:00.000Z');
  assert.deepEqual(getIsraelTime(midnight), { weekday: 'Sat', minutes: 0 });
  assert.equal(isShabbatMode(midnight), true);
});

test('Shabbat mode ends at the configured Saturday closing time', () => {
  const beforeClose = new Date('2026-10-03T17:29:00.000Z');
  const atClose = new Date('2026-10-03T17:30:00.000Z');
  assert.equal(isShabbatMode(beforeClose), true);
  assert.equal(isShabbatMode(atClose), false);
});

test('offline payment mode never reports a mock charge as paid', async () => {
  const originalMode = process.env.PAYMENT_MODE;
  process.env.PAYMENT_MODE = 'offline';
  try {
    await assert.rejects(charge({ amount: 100, token: 'unused', customer: {} }), /payments are disabled/i);
  } finally {
    if (originalMode === undefined) delete process.env.PAYMENT_MODE;
    else process.env.PAYMENT_MODE = originalMode;
  }
});

test('Shabbat fallback window uses Jerusalem wall-clock times independent of server timezone', () => {
  const duringShabbat = new Date('2026-10-03T14:00:00.000Z');
  const window = fallbackWindow(duringShabbat);
  assert.equal(window.start.toISOString(), '2026-10-02T13:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-10-03T17:30:00.000Z');
});

test('Mongo input protection rejects operator and dotted keys recursively', () => {
  assert.equal(containsUnsafeMongoKey({ customer: { name: 'דנה' } }), false);
  assert.equal(containsUnsafeMongoKey({ filter: { $gt: '' } }), true);
  assert.equal(containsUnsafeMongoKey({ 'profile.email': 'x@example.com' }), true);
});

test('API error response is Hebrew, uniform and does not expose production details', () => {
  const result = getErrorResponse(Object.assign(new Error('private database detail'), { status: 500 }), true);
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { success: false, error: 'אירעה שגיאה במערכת. נסו שוב מאוחר יותר.' });
});