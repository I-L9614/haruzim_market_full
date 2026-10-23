const express = require('express');
const { requireAuth, adminOnly } = require('../middleware/auth');
const { createCategory, getFeaturedSelection, setFeaturedProduct } = require('../controllers/adminCatalogController');
const { shabbatMiddleware } = require('../middleware/shabbat');

const router = express.Router();
router.use(requireAuth, adminOnly);
router.post('/categories', shabbatMiddleware, createCategory);
router.get('/featured-product', getFeaturedSelection);
router.put('/featured-product', shabbatMiddleware, setFeaturedProduct);

module.exports = router;