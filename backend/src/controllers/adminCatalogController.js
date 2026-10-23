const mongoose = require('mongoose');
const { Category, Product, StorefrontConfig } = require('../models');

async function createCategory(req, res, next) {
  try {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({ error: 'INVALID_CATEGORY', message: 'שם הקטגוריה חייב להכיל 2–80 תווים.' });
    }
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await Category.findOne({ name: new RegExp(`^${escapedName}$`, 'i') });
    if (existing) return res.status(409).json({ error: 'CATEGORY_EXISTS', message: 'כבר קיימת קטגוריה בשם הזה.' });
    const slugBase = name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'category';
    let slug = slugBase;
    let suffix = 2;
    while (await Category.exists({ slug })) slug = `${slugBase}-${suffix++}`;
    const category = await Category.create({ name, slug, active: true });
    return res.status(201).json({ category });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'CATEGORY_EXISTS', message: 'כבר קיימת קטגוריה בשם הזה.' });
    return next(error);
  }
}

async function getFeaturedProduct(req, res, next) {
  try {
    const config = await StorefrontConfig.findById('storefront').select('featuredProduct').lean();
    if (!config?.featuredProduct) return res.json({ product: null });
    const product = await Product.findOne({
      _id: config.featuredProduct,
      active: true,
      $or: [{ stockQuantity: { $gt: 0 } }, { stockQuantity: null }, { stockQuantity: { $exists: false } }]
    })
      .populate('category', 'name slug')
      .lean();
    return res.json({ product: product || null });
  } catch (error) {
    return next(error);
  }
}

async function getFeaturedSelection(req, res, next) {
  try {
    const config = await StorefrontConfig.findById('storefront').select('featuredProduct').lean();
    return res.json({ productId: config?.featuredProduct ? String(config.featuredProduct) : '' });
  } catch (error) {
    return next(error);
  }
}

async function setFeaturedProduct(req, res, next) {
  try {
    const productId = String(req.body?.productId || '');
    if (productId && !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ error: 'INVALID_PRODUCT_ID', message: 'בחירת המוצר אינה תקינה.' });
    }
    if (productId && !await Product.exists({
      _id: productId,
      active: true,
      $or: [{ stockQuantity: { $gt: 0 } }, { stockQuantity: null }, { stockQuantity: { $exists: false } }]
    })) {
      return res.status(404).json({ error: 'PRODUCT_NOT_AVAILABLE', message: 'אפשר לבחור רק מוצר פעיל ובמלאי.' });
    }
    const config = await StorefrontConfig.findByIdAndUpdate('storefront', {
      $set: { featuredProduct: productId || null }
    }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }).lean();
    return res.json({ productId: config.featuredProduct ? String(config.featuredProduct) : '' });
  } catch (error) {
    return next(error);
  }
}

module.exports = { createCategory, getFeaturedProduct, getFeaturedSelection, setFeaturedProduct };