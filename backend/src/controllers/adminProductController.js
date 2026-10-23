const mongoose = require('mongoose');
const { Category, Product } = require('../models');

function validateProductInput(body) {
  const name = String(body?.name || '').trim();
  const category = String(body?.category || '');
  const price = Number(body?.price);
  const rawStockQuantity = body?.stockQuantity;
  const stockQuantity = rawStockQuantity === '' || rawStockQuantity === null || rawStockQuantity === undefined
    ? null
    : Number(rawStockQuantity);
  const unitType = body?.unitType || 'units';
  const promotionPrice = body?.promotionPrice === '' || body?.promotionPrice === null || body?.promotionPrice === undefined
    ? null
    : Number(body.promotionPrice);
  const imageUrl = String(body?.imageUrl || '').trim();

  if (name.length < 2 || name.length > 160) return { error: 'יש להזין שם מוצר באורך 2–160 תווים.' };
  if (!mongoose.isValidObjectId(category)) return { error: 'יש לבחור קטגוריה תקינה.' };
  if (!Number.isFinite(price) || price < 0 || price > 1000000) return { error: 'המחיר חייב להיות מספר תקין ולא שלילי.' };
  if (stockQuantity !== null && (!Number.isFinite(stockQuantity) || stockQuantity < 0 || stockQuantity > 1000000)) return { error: 'כמות המלאי חייבת להיות מספר תקין ולא שלילי.' };
  if (!['units', 'weight'].includes(unitType)) return { error: 'סוג המכירה אינו תקין.' };
  if (unitType === 'units' && stockQuantity !== null && !Number.isInteger(stockQuantity)) return { error: 'מלאי של מוצר הנמכר ביחידות חייב להיות מספר שלם.' };
  if (promotionPrice !== null && (!Number.isFinite(promotionPrice) || promotionPrice < 0 || promotionPrice >= price)) {
    return { error: 'מחיר המבצע חייב להיות תקין ונמוך מהמחיר הרגיל.' };
  }
  if (imageUrl && (!/^https?:\/\//i.test(imageUrl) || imageUrl.length > 2000)) {
    return { error: 'כתובת התמונה חייבת להתחיל ב-http:// או https://.' };
  }

  return {
    value: {
      name,
      description: String(body.description || '').trim().slice(0, 2000),
      imageUrl,
      category,
      price,
      promotion: promotionPrice === null ? undefined : { label: 'מבצע', price: promotionPrice },
      unitType,
      unitLabel: unitType === 'weight' ? 'ק״ג' : 'יחידה',
      stockQuantity,
      active: body.active === undefined ? true : body.active === true || body.active === 'true'
    }
  };
}

async function listProducts(req, res, next) {
  try {
    const products = await Product.find({}).populate('category', 'name slug').sort({ active: -1, name: 1 }).lean();
    const categories = await Category.find({ active: true }).select('name slug').sort({ name: 1 }).lean();
    return res.json({ products, categories });
  } catch (error) {
    return next(error);
  }
}

async function createProduct(req, res, next) {
  try {
    const validated = validateProductInput(req.body);
    if (validated.error) return res.status(400).json({ error: 'INVALID_PRODUCT', message: validated.error });
    const categoryExists = await Category.exists({ _id: validated.value.category, active: true });
    if (!categoryExists) return res.status(400).json({ error: 'INVALID_CATEGORY', message: 'הקטגוריה אינה קיימת או אינה פעילה.' });
    const product = await Product.create(validated.value);
    await product.populate('category', 'name slug');
    return res.status(201).json({ product });
  } catch (error) {
    return next(error);
  }
}

async function updateProduct(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'INVALID_PRODUCT_ID', message: 'מזהה המוצר אינו תקין.' });
    }
    const validated = validateProductInput(req.body);
    if (validated.error) return res.status(400).json({ error: 'INVALID_PRODUCT', message: validated.error });
    const categoryExists = await Category.exists({ _id: validated.value.category, active: true });
    if (!categoryExists) return res.status(400).json({ error: 'INVALID_CATEGORY', message: 'הקטגוריה אינה קיימת או אינה פעילה.' });
    const update = { $set: validated.value };
    if (validated.value.promotion === undefined) update.$unset = { promotion: 1 };
    const product = await Product.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true
    }).populate('category', 'name slug');
    if (!product) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND', message: 'המוצר לא נמצא.' });
    return res.json({ product });
  } catch (error) {
    return next(error);
  }
}

async function deleteProduct(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'INVALID_PRODUCT_ID', message: 'מזהה המוצר אינו תקין.' });
    }
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: { active: false } }, {
      new: true,
      runValidators: true
    }).populate('category', 'name slug');
    if (!product) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND', message: 'המוצר לא נמצא.' });
    return res.json({ product, message: 'המוצר הוסר מהחנות. נתוני הזמנות קודמות נשמרו.' });
  } catch (error) {
    return next(error);
  }
}

module.exports = { validateProductInput, listProducts, createProduct, updateProduct, deleteProduct };