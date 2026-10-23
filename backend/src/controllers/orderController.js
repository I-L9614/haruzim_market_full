const mongoose = require('mongoose');
const { Order, Product, User } = require('../models');
const { notifyTelegramOrder } = require('../services/orderNotifications');

async function getProductAlternatives(product, limit = 3) {
  if (!product || !product.category) return [];

  const candidates = await Product.find({
    category: product.category,
    active: true,
    $or: [{ stockQuantity: { $gt: 0 } }, { stockQuantity: null }, { stockQuantity: { $exists: false } }],
    _id: { $ne: product._id }
  }).limit(limit).lean();

  return candidates.map((candidate) => ({
    productId: candidate._id,
    name: candidate.name,
    price: candidate.promotion?.price ?? candidate.price,
    stockQuantity: candidate.stockQuantity,
    category: candidate.category
  }));
}

async function validateCartStock(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return { valid: false, unavailable: [], validItems: [] };
  }

  const safeItems = items.filter((item) => item && mongoose.isValidObjectId(item.productId));
  const populated = await Product.find({
    _id: { $in: safeItems.map((item) => item.productId) },
    active: true
  }).lean();

  const byId = new Map(populated.map((product) => [String(product._id), product]));
  const unavailable = [];
  const validItems = [];

  for (const item of items) {
    const productId = item?.productId;
    const product = byId.get(String(productId));
    const requestedQty = Number(item?.quantity);

    if (!product) {
      unavailable.push({
        productId,
        requested: requestedQty || 0,
        available: 0,
        alternatives: []
      });
      continue;
    }

    if (!Number.isFinite(requestedQty) || requestedQty <= 0 || (product.unitType !== 'weight' && !Number.isInteger(requestedQty))) {
      unavailable.push({
        productId: item.productId,
        requested: requestedQty || 0,
        available: product.stockQuantity,
        alternatives: await getProductAlternatives(product)
      });
      continue;
    }

    if (product.stockQuantity != null && requestedQty > product.stockQuantity) {
      unavailable.push({
        productId: item.productId,
        requested: requestedQty,
        available: product.stockQuantity,
        alternatives: await getProductAlternatives(product)
      });
      continue;
    }

    validItems.push({
      productId: product._id,
      quantity: requestedQty,
      name: product.name,
      unitType: product.unitType || 'units',
      unitPrice: product.promotion?.price ?? product.price,
      stockQuantity: product.stockQuantity
    });
  }

  return {
    valid: unavailable.length === 0,
    unavailable,
    validItems
  };
}

async function checkoutOrder(req, res, next) {
  let session;

  try {
    const { customer, items } = req.body;
    const phone = String(customer?.phone || '').replace(/[\s()-]/g, '');

    if (!String(customer?.name || '').trim() || !/^\+?[0-9]{9,15}$/.test(phone) || !String(customer?.address?.street || '').trim() || !String(customer?.address?.city || '').trim() || !Array.isArray(items) || items.length === 0 || items.length > 100) {
      return res.status(400).json({
        error: 'INVALID_CHECKOUT',
        message: 'יש למלא שם, טלפון תקין, כתובת למשלוח ולפחות מוצר אחד.'
      });
    }

    if (items.some((item) => !item || !mongoose.isValidObjectId(item.productId) || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 || Number(item.quantity) > 1000)) {
      return res.status(400).json({ error: 'INVALID_ITEMS', message: 'פרטי המוצרים בעגלה אינם תקינים.' });
    }

    const normalizedCustomer = {
      name: String(customer.name).trim().slice(0, 120),
      phone,
      email: String(customer.email || '').trim().slice(0, 160),
      address: {
        street: String(customer.address.street).trim().slice(0, 160),
        city: String(customer.address.city).trim().slice(0, 100),
        apartment: String(customer.address.apartment || '').trim().slice(0, 50)
      },
      notes: String(customer.notes || '').trim().slice(0, 1000)
    };

    const validation = await validateCartStock(items);
    if (!validation.valid) {
      return res.status(400).json({
        status: 'stock_issue',
        stock_issue: true,
        message: 'חלק מהפריטים אינם זמינים במלאי.',
        missingItems: validation.unavailable,
        validItems: validation.validItems
      });
    }

    let createdOrder;

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const products = await Product.find({ _id: { $in: items.map((item) => item.productId) }, active: true }).session(session);
      const byId = new Map(products.map((product) => [String(product._id), product]));
      const orderItems = [];

      for (const item of items) {
        const product = byId.get(String(item.productId));
        const quantity = Number(item.quantity);

        if (!product || quantity <= 0 || (product.unitType !== 'weight' && !Number.isInteger(quantity)) || (product.stockQuantity != null && quantity > product.stockQuantity)) {
          throw Object.assign(new Error('OUT_OF_STOCK'), { status: 409 });
        }

        const unitPrice = product.promotion?.price ?? product.price;
        orderItems.push({
          product: product._id,
          name: product.name,
          unitType: product.unitType || 'units',
          quantity,
          unitPrice,
          total: quantity * unitPrice
        });

        if (product.stockQuantity != null) {
          product.stockQuantity -= quantity;
          await product.save({ session });
        }
      }

      const subtotal = orderItems.reduce((sum, item) => sum + item.total, 0);
      const user = await User.findOneAndUpdate(
        req.customerUser ? { _id: req.customerUser._id } : { phone: normalizedCustomer.phone },
        {
          $set: req.customerUser
            ? { name: normalizedCustomer.name, phone: normalizedCustomer.phone }
            : { name: normalizedCustomer.name },
          $addToSet: { addresses: normalizedCustomer.address }
        },
        { upsert: true, new: true, session }
      );

      [createdOrder] = await Order.create([{
        user: user._id,
        items: orderItems,
        customer: normalizedCustomer,
        subtotal,
        total: subtotal,
        status: 'pending_payment',
        payment: { provider: 'offline', status: 'pending' },
        fulfillment: { status: 'pending' }
      }], { session });
    });

    if (global.io) {
      global.io.emit('newOrder', {
        orderId: createdOrder._id,
        total: createdOrder.total,
        customer: createdOrder.customer,
        items: createdOrder.items,
        status: createdOrder.status,
        payment: createdOrder.payment,
        fulfillment: createdOrder.fulfillment,
        createdAt: createdOrder.createdAt
      });
    }
    void notifyTelegramOrder(createdOrder);

    return res.status(201).json({
      order: createdOrder,
      message: 'ההזמנה נשמרה ותשלום ומשלוח יתואמו טלפונית.'
    });
  } catch (error) {
    if (error.status === 409 || error.message === 'OUT_OF_STOCK') {
      return res.status(409).json({
        error: 'OUT_OF_STOCK',
        message: 'חלק מהמוצרים אזלו מהמלאי. יש לרענן את העגלה.',
        stock_issue: true
      });
    }

    return next(error);
  } finally {
    if (session) await session.endSession();
  }
}

async function trackOrder(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'לא נמצאה הזמנה התואמת לפרטים.' });
    }
    const order = await Order.findById(req.params.id).lean();
    const phone = String(req.body?.phone || '').replace(/[\s()-]/g, '');
    if (!order || !phone || order.customer?.phone !== phone) {
      return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'לא נמצאה הזמנה התואמת לפרטים.' });
    }

    return res.json({
      order: {
        _id: order._id,
        total: order.total,
        status: order.status,
        payment: { status: order.payment?.status || 'pending' },
        fulfillment: { status: order.fulfillment?.status || 'pending' },
        createdAt: order.createdAt,
        items: order.items.map(({ name, quantity, unitPrice, total }) => ({ name, quantity, unitPrice, total }))
      }
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  validateCartStock,
  checkoutOrder,
  trackOrder
};
