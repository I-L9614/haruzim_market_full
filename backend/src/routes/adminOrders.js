const express = require('express');
const { requireAuth, adminOnly } = require('../middleware/auth');
const { listOrders, updateOrderStatuses } = require('../controllers/adminOrderController');
const { shabbatMiddleware } = require('../middleware/shabbat');

const router = express.Router();
router.use(requireAuth, adminOnly);
router.get('/', listOrders);
router.patch('/:id/status', shabbatMiddleware, updateOrderStatuses);

module.exports = router;