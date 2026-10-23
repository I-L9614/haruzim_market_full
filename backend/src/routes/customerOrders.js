const express = require('express');
const { requireCustomerAuth } = require('../middleware/auth');
const { listCustomerOrders, reorderCustomerOrder } = require('../controllers/customerOrderController');

const router = express.Router();
router.use(requireCustomerAuth);
router.get('/', listCustomerOrders);
router.post('/:id/reorder', reorderCustomerOrder);

module.exports = router;