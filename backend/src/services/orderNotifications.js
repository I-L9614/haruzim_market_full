const logger = require('../logger');

async function notifyTelegramOrder(order) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const text = [
    'התקבלה הזמנה חדשה בחנות',
    `מספר: ${order._id}`,
    `לקוח: ${order.customer?.name || '—'}`,
    `טלפון: ${order.customer?.phone || '—'}`,
    `כתובת: ${[order.customer?.address?.street, order.customer?.address?.apartment, order.customer?.address?.city].filter(Boolean).join(', ') || '—'}`,
    `סכום: ${Number(order.total || 0).toFixed(2)} ₪`,
    'סטטוס: ממתינה לתשלום ותיאום משלוח'
  ].join('\n');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Telegram responded with ${response.status}`);
    logger.info('Order notification delivered to Telegram');
  } catch (error) {
    logger.warn('Order notification could not be delivered', { code: error.name || 'TELEGRAM_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { notifyTelegramOrder };
