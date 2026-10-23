const mongoose = require('mongoose');
const { Order, Product } = require('../models');

async function listOrders(req, res, next) {
  try {
    const pageSize = 100;
    const filter = {};
    const cursorDate = new Date(String(req.query.before || ''));
    const cursorId = String(req.query.id || '');
    if (req.query.before || req.query.id) {
      if (!Number.isFinite(cursorDate.getTime()) || !mongoose.isValidObjectId(cursorId)) {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: 'לא ניתן לטעון את ההיסטוריה כרגע.' });
      }
      filter.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, _id: { $lt: cursorId } }
      ];
    }
    const result = await Order.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(pageSize + 1)
      .lean();
    const hasMore = result.length > pageSize;
    const orders = result.slice(0, pageSize);
    const lastOrder = orders[orders.length - 1];
    return res.json({
      orders,
      nextCursor: hasMore && lastOrder ? { createdAt: lastOrder.createdAt, id: String(lastOrder._id) } : null
    });
  } catch (error) {
    return next(error);
  }
}

async function updateOrderStatuses(req, res, next) {
  let session;
  try {
    const { paymentStatus, fulfillmentStatus } = req.body || {};
    const allowedPayment = ['pending', 'paid', 'failed'];
    const allowedFulfillment = ['pending', 'shipped', 'delivered', 'cancelled'];
    if (!mongoose.isValidObjectId(req.params.id) || !allowedPayment.includes(paymentStatus) || !allowedFulfillment.includes(fulfillmentStatus)) {
      return res.status(400).json({ error: 'INVALID_ORDER_STATUS', message: 'סטטוס ההזמנה אינו תקין.' });
    }

    if (fulfillmentStatus === 'cancelled') {
      session = await mongoose.startSession();
      let cancelledOrder;
      await session.withTransaction(async () => {
        const order = await Order.findById(req.params.id).session(session);
        if (!order) return;
        const previousFulfillment = order.fulfillment?.status || 'pending';
        if (order.payment?.status === 'paid') {
          throw Object.assign(new Error('PAID_ORDER_REQUIRES_MANUAL_REFUND'), { status: 409 });
        }
        if (previousFulfillment !== 'cancelled') {
          if (previousFulfillment !== 'pending') {
            throw Object.assign(new Error('ORDER_ALREADY_DISPATCHED'), { status: 409 });
          }
          for (const item of order.items) {
            await Product.updateOne({ _id: item.product, stockQuantity: { $ne: null } }, { $inc: { stockQuantity: item.quantity } }, { session });
          }
          order.fulfillment = { status: 'cancelled', updatedAt: new Date() };
          order.status = 'cancelled';
          await order.save({ session });
        }
        cancelledOrder = order;
      });
      if (!cancelledOrder) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה.' });
      const payload = {
        orderId: cancelledOrder._id,
        status: cancelledOrder.status,
        payment: cancelledOrder.payment,
        fulfillment: cancelledOrder.fulfillment,
        updatedAt: cancelledOrder.updatedAt
      };
      if (global.io) global.io.emit('orderUpdated', payload);
      return res.json({ order: cancelledOrder });
    }

    const currentOrder = await Order.findById(req.params.id).lean();
    if (!currentOrder) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה.' });
    const currentFulfillment = currentOrder.fulfillment?.status || 'pending';
    if (currentFulfillment === 'cancelled' || (currentOrder.payment?.status === 'paid' && paymentStatus !== 'paid')) {
      return res.status(409).json({ error: 'ORDER_TRANSITION_NOT_ALLOWED', message: 'לא ניתן לשנות את סטטוס ההזמנה במצב הנוכחי.' });
    }
    if ((fulfillmentStatus === 'shipped' && !['pending', 'shipped'].includes(currentFulfillment)) ||
        (fulfillmentStatus === 'delivered' && !['shipped', 'delivered'].includes(currentFulfillment)) ||
        (fulfillmentStatus === 'pending' && currentFulfillment !== 'pending')) {
      return res.status(409).json({ error: 'ORDER_TRANSITION_NOT_ALLOWED', message: 'יש לעדכן את סטטוס המשלוח לפי סדר השלבים.' });
    }

    const status = paymentStatus !== 'paid'
      ? (paymentStatus === 'failed' ? 'cancelled' : 'pending_payment')
      : fulfillmentStatus === 'delivered' ? 'delivered'
        : fulfillmentStatus === 'shipped' ? 'shipped'
          : 'preparing';

    const order = await Order.findByIdAndUpdate(req.params.id, {
      $set: {
        'payment.status': paymentStatus,
        'fulfillment.status': fulfillmentStatus,
        'fulfillment.updatedAt': new Date(),
        status
      }
    }, { new: true, runValidators: true });

    if (!order) return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'ההזמנה לא נמצאה.' });

    const payload = {
      orderId: order._id,
      status: order.status,
      payment: order.payment,
      fulfillment: order.fulfillment,
      updatedAt: order.updatedAt
    };
    if (global.io) global.io.emit('orderUpdated', payload);
    return res.json({ order });
  } catch (error) {
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
}

module.exports = { listOrders, updateOrderStatuses };