const { Order, Product } = require('../models');

async function getAdminStats(req, res, next) {
  try {
    const [orders, topProducts] = await Promise.all([
      Order.find({}).lean(),
      Order.aggregate([
        { $match: { 'payment.status': 'paid', status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.product', totalSold: { $sum: '$items.quantity' } } },
        { $sort: { totalSold: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
        { $unwind: '$product' },
        { $project: { _id: 0, productId: '$_id', name: '$product.name', totalSold: 1 } }
      ])
    ]);

    const totalRevenue = orders.reduce((sum, order) => sum + (order.payment?.status === 'paid' ? Number(order.total) || 0 : 0), 0);
    const totalOrders = orders.length;

    const orderStatuses = {
      pending_payment: 0,
      pending: 0,
      preparing: 0,
      shipped: 0,
      delivered: 0,
      cancelled: 0
    };

    for (const order of orders) {
      const status = order.status || 'pending_payment';
      if (orderStatuses[status] !== undefined) orderStatuses[status] += 1;
    }

    return res.json({
      totalRevenue,
      totalOrders,
      orderStatusBreakdown: orderStatuses,
      topSellingProducts: topProducts
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getAdminStats };
