const jwt = require('jsonwebtoken');
const { Admin, User } = require('../models');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      error: 'AUTH_REQUIRED',
      message: 'יש להזין טוקן אימות.'
    });
  }

  let decoded;
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT secret is not configured');
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({
      error: 'INVALID_TOKEN',
      message: 'הטוקן אינו תקף.'
    });
  }

  try {
    const admin = await Admin.findById(decoded.id).select('name email role active').lean();
    if (!admin || !admin.active) {
      return res.status(401).json({ error: 'ACCOUNT_DISABLED', message: 'החשבון אינו פעיל. יש לפנות למנהל המערכת.' });
    }
    req.user = { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role };
    return next();
  } catch (error) {
    return next(error);
  }
}

async function requireCustomerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'יש להתחבר לחשבון לקוח.' });

  let decoded;
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT secret is not configured');
    decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'customer') throw new Error('Wrong account type');
  } catch {
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'החיבור לחשבון פג. התחברו מחדש.' });
  }

  try {
    const user = await User.findById(decoded.id).select('name email phone role').lean();
    if (!user || user.role !== 'customer') return res.status(401).json({ error: 'ACCOUNT_NOT_FOUND', message: 'חשבון הלקוח לא נמצא.' });
    req.customerUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function optionalCustomerAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return requireCustomerAuth(req, res, next);
}

function ownerOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'OWNER_REQUIRED', message: 'רק מנהל ראשי יכול לנהל חשבונות מנהלים.' });
  }
  return next();
}

function adminOnly(req, res, next) {
  if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'אין הרשאה לגישה.'
    });
  }

  return next();
}

module.exports = { requireAuth, requireCustomerAuth, optionalCustomerAuth, adminOnly, ownerOnly };
