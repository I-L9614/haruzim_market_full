const express = require('express');
const { shabbatMiddleware } = require('../middleware/shabbat');
const { optionalCustomerAuth } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/rateLimit');
const { checkoutOrder, trackOrder } = require('../controllers/orderController');

const router = express.Router();

router.post('/checkout/validate', createRateLimit({ windowMs: 15 * 60 * 1000, max: 40 }), shabbatMiddleware, async (req, res, next) => {
  try {
    const { items } = req.body || {};
    const validation = await require('../controllers/orderController').validateCartStock(items);

    return res.status(validation.valid ? 200 : 400).json({
      valid: validation.valid,
      stock_issue: !validation.valid,
      missingItems: validation.unavailable,
      alternatives: validation.unavailable,
      validItems: validation.validItems
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/checkout', createRateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: 'נשלחו יותר מדי הזמנות מהמכשיר הזה. נסו שוב מאוחר יותר.' }), shabbatMiddleware, optionalCustomerAuth, checkoutOrder);
router.post('/orders/:id/track', trackOrder);

module.exports = router;
