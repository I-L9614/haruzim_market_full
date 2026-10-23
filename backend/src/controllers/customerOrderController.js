const mongoose = require('mongoose');
const { Order } = require('../models');
const { validateCartStock } = require('./orderController');

async function listCustomerOrders(req, res, next) {
  try {
    const orders = await Order.find({ user: req.customerUser._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('items total status payment.status fulfillment.status createdAt')
      .lean();
    return res.json({ orders });
  } catch (error) {
    return next(error);
  }
}

async function reorderCustomerOrder(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה בחשבון.' });
    }
    const order = await Order.findOne({ _id: req.params.id, user: req.customerUser._id }).lean();
    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה בחשבון.' });

    const validation = await validateCartStock(order.items.map((item) => ({ productId: item.product, quantity: item.quantity })));
    const available = validation.validItems.map((item) => ({
      productId: String(item.productId),
      name: item.name,
      quantity: item.quantity,
      unitType: item.unitType || 'units',
      price: item.unitPrice,
      stockQuantity: item.stockQuantity
    }));
    return res.json({
      available,
      missingItems: validation.unavailable,
      message: validation.unavailable.length ? 'הוספנו מוצרים זמינים בלבד; חלק מהמוצרים כבר אינם זמינים.' : 'הפריטים הזמינים נוספו לעגלה.'
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { listCustomerOrders, reorderCustomerOrder };