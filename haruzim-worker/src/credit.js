// All amounts are integer agorot. A transaction commits the account, immutable
// audit entry, and delivery decision together. No browser-supplied balances.
export function cents(value, { signed = false } = {}) {
  if (!['string', 'number'].includes(typeof value) || !/^-?\d+(\.\d{1,2})?$/.test(String(value))) throw problem('יש להזין סכום תקין עם עד שתי ספרות אחרי הנקודה.', 400);
  const n = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 100000000 || (!signed && n < 0)) throw problem('הסכום אינו בטווח המותר.', 400);
  return n;
}
export function problem(message, status = 409) { return Object.assign(new Error(message), { status, publicMessage: message }); }
export function creditKey(name) {
  if (typeof name !== 'string') throw problem('יש להזין שם לקוח להקפה.', 400);
  const key = name.normalize('NFKC').trim().toLocaleLowerCase('he').replace(/\s+/g, ' ');
  if (key.length < 2 || key.length > 80 || /[\x00-\x1f]/.test(key)) throw problem('שם לקוח להקפה חייב להכיל 2 עד 80 תווים.', 400);
  return key;
}
export function validSecret(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 72 && new TextEncoder().encode(value).length <= 72; }
export function publicAccount(a) {
  return { _id: a._id, name: a.name, active: a.active, balanceCents: a.balanceCents, version: a.version, createdAt: a.createdAt, updatedAt: a.updatedAt };
}
export async function changeBalance(db, { accountId, expectedVersion, amount, mode, reason, actorId, requestId }) {
  const { CreditAccount, CreditEntry } = db.models;
  if (!['set', 'reset'].includes(mode) || !Number.isInteger(expectedVersion) || typeof reason !== 'string' || reason.trim().length < 2 || reason.length > 300 || !/^[a-f0-9-]{36}$/i.test(requestId || '')) throw problem('יש לציין סכום, סיבת שינוי וגרסת חשבון תקינים.', 400);
  const target = mode === 'reset' ? 0 : cents(amount, { signed: true });
  const entryId = `manual:${accountId}:${requestId}`;
  let result;
  const session = await db.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const previous = await CreditEntry.findById(entryId).session(session).lean();
      if (previous) {
        if (previous.afterCents !== target || previous.reason !== reason.trim() || previous.actorId !== actorId) throw problem('מזהה הפעולה כבר שימש לשינוי אחר.');
        result = await CreditAccount.findById(accountId).session(session); return;
      }
      const a = await CreditAccount.findById(accountId).session(session);
      if (!a) throw problem('לקוח ההקפה לא נמצא.', 404);
      if (a.version !== expectedVersion) throw problem('היתרה השתנתה במכשיר אחר. רעננו ובדקו שוב לפני שמירה.');
      const before = a.balanceCents;
      a.balanceCents = target; a.version += 1;
      await a.save({ session });
      await CreditEntry.create([{ _id: entryId, account: a._id, kind: mode, deltaCents: target - before, beforeCents: before, afterCents: target, reason: reason.trim(), actorId }], { session });
      result = a;
    });
    return publicAccount(result);
  } finally { await session.endSession(); }
}
export async function deliverCredit(db, { orderId, decision, actorId, paymentStatus }) {
  const { Order, CreditAccount, CreditEntry } = db.models;
  if (!decision || !['total', 'custom', 'skip'].includes(decision.mode)) throw problem('יש לבחור האם להוסיף את סכום ההזמנה לחוב, סכום אחר, או לא להוסיף.', 400);
  if (typeof decision.reason !== 'string' || decision.reason.length > 300 || (decision.mode === 'custom' && decision.reason.trim().length < 2)) throw problem('בסכום אחר יש לציין סיבה קצרה.', 400);
  let result;
  const session = await db.connection.startSession();
  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order || order.payment?.provider !== 'credit' || !order.credit?.account) throw problem('הזמנת ההקפה לא נמצאה.', 404);
      if (order.fulfillment.status === 'delivered' && order.credit.decisionAt) {
        const entry = await CreditEntry.findById(`delivery:${orderId}`).session(session).lean();
        const retryAmount = decision.mode === 'total' ? cents(Number(order.total).toFixed(2)) : decision.mode === 'skip' ? 0 : cents(decision.amount, { signed: true });
        if (!entry || order.credit.decisionMode !== decision.mode || entry.deltaCents !== retryAmount || entry.reason !== decision.reason.trim() || entry.actorId !== actorId) throw problem('המסירה כבר נרשמה עם החלטת חוב. רעננו את ההזמנה.');
        result = order; return;
      }
      if (order.fulfillment.status !== 'shipped') throw problem('יש לסמן את ההזמנה כנשלחה לפני המסירה.');
      if (paymentStatus !== 'pending' || order.payment.status !== 'pending') throw problem('הזמנת הקפה נשארת במצב תשלום בהקפה. שינוי חוב נעשה בחשבון הלקוח.');
      const a = await CreditAccount.findById(order.credit.account).session(session);
      if (!a) throw problem('לקוח ההקפה לא נמצא.', 404);
      const delta = decision.mode === 'total' ? cents(Number(order.total).toFixed(2)) : decision.mode === 'skip' ? 0 : cents(decision.amount, { signed: true });
      const before = a.balanceCents, after = before + delta;
      if (!Number.isSafeInteger(after) || Math.abs(after) > 100000000) throw problem('היתרה חורגת מהטווח המותר.', 400);
      a.balanceCents = after; a.version += 1;
      await a.save({ session });
      await CreditEntry.create([{ _id: `delivery:${orderId}`, account: a._id, order: order._id, kind: 'delivery', deltaCents: delta, beforeCents: before, afterCents: after, reason: decision.reason.trim(), actorId }], { session });
      order.credit.decisionAt = new Date(); order.credit.decisionMode = decision.mode; order.credit.amountCents = delta;
      order.fulfillment = { status: 'delivered', updatedAt: new Date() }; order.status = 'delivered';
      await order.save({ session }); result = order;
    });
    return result;
  } finally { await session.endSession(); }
}
