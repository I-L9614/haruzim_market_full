const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductInput } = require('../src/controllers/adminProductController');

const category = '507f1f77bcf86cd799439011';
const validProduct = {
  name: 'תפוחים',
  category,
  price: 12.5,
  promotionPrice: 10,
  unitType: 'weight',
  stockQuantity: 4.25,
  imageUrl: 'https://example.com/apples.jpg'
};

test('product validation accepts weight items, promotion and secure image URL', () => {
  const result = validateProductInput(validProduct);
  assert.equal(result.error, undefined);
  assert.equal(result.value.unitLabel, 'ק״ג');
  assert.equal(result.value.promotion.price, 10);
  assert.equal(result.value.active, true);
});

test('product validation rejects promotion prices not below regular price', () => {
  const result = validateProductInput({ ...validProduct, promotionPrice: 12.5 });
  assert.match(result.error, /נמוך מהמחיר הרגיל/);
});

test('product validation requires whole stock quantities for unit products', () => {
  const result = validateProductInput({ ...validProduct, unitType: 'units', stockQuantity: 1.5 });
  assert.match(result.error, /מספר שלם/);
});

test('product validation accepts an omitted stock limit for both selling types', () => {
  for (const unitType of ['units', 'weight']) {
    const result = validateProductInput({ ...validProduct, unitType, stockQuantity: '' });
    assert.equal(result.error, undefined);
    assert.equal(result.value.stockQuantity, null);
  }
});

test('product validation rejects non-HTTP image locations', () => {
  const result = validateProductInput({ ...validProduct, imageUrl: 'file:///private/image.jpg' });
  assert.match(result.error, /http:\/\/ או https:\/\//);
});