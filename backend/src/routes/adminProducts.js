const express = require('express');
const { requireAuth, adminOnly } = require('../middleware/auth');
const { listProducts, createProduct, updateProduct, deleteProduct } = require('../controllers/adminProductController');
const { shabbatMiddleware } = require('../middleware/shabbat');

const router = express.Router();
router.use(requireAuth, adminOnly);
router.get('/', listProducts);
router.post('/', shabbatMiddleware, createProduct);
router.put('/:id', shabbatMiddleware, updateProduct);
router.patch('/:id', shabbatMiddleware, updateProduct);
router.delete('/:id', shabbatMiddleware, deleteProduct);

module.exports = router;