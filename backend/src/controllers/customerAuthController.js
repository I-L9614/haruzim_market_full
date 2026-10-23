const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function makeCustomerToken(user) {
  return jwt.sign({ id: user._id, role: 'customer' }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function customerResponse(user) {
  return {
    token: makeCustomerToken(user),
    user: { id: String(user._id), name: user.name, email: user.email }
  };
}

async function registerCustomer(req, res, next) {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (name.length < 2 || name.length > 120 || !emailPattern.test(email) || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'INVALID_REGISTRATION', message: 'יש להזין שם, אימייל תקין וסיסמה באורך 12 תווים לפחות.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, passwordHash, role: 'customer' });
    return res.status(201).json(customerResponse(user));
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'EMAIL_IN_USE', message: 'כבר קיים חשבון עם כתובת האימייל הזו.' });
    return next(error);
  }
}

async function loginCustomer(req, res, next) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await User.findOne({ email, role: 'customer' }).select('+passwordHash');
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'האימייל או הסיסמה אינם נכונים.' });
    }
    return res.json(customerResponse(user));
  } catch (error) {
    return next(error);
  }
}

async function loginWithGoogle(req, res, next) {
  try {
    const idToken = String(req.body?.credential || '');
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'GOOGLE_LOGIN_NOT_CONFIGURED', message: 'התחברות Google עדיין לא הוגדרה באתר.' });
    }
    if (!idToken || idToken.length > 10000) {
      return res.status(400).json({ error: 'INVALID_GOOGLE_CREDENTIAL', message: 'פרטי ההתחברות של Google אינם תקינים.' });
    }

    const verification = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!verification.ok) return res.status(401).json({ error: 'INVALID_GOOGLE_CREDENTIAL', message: 'לא הצלחנו לאמת את חשבון Google.' });
    const claims = await verification.json();
    if (claims.aud !== process.env.GOOGLE_CLIENT_ID || claims.email_verified !== 'true' || !claims.sub || !emailPattern.test(claims.email || '')) {
      return res.status(401).json({ error: 'INVALID_GOOGLE_CREDENTIAL', message: 'חשבון Google לא אומת עבור האתר.' });
    }

    const email = claims.email.trim().toLowerCase();
    let user = await User.findOne({ googleSub: claims.sub, role: 'customer' });
    if (!user) {
      user = await User.findOne({ email, role: 'customer' });
      if (user) {
        user.googleSub = claims.sub;
        if (!user.name && claims.name) user.name = claims.name.slice(0, 120);
        await user.save();
      } else {
        user = await User.create({ name: String(claims.name || email.split('@')[0]).slice(0, 120), email, googleSub: claims.sub, role: 'customer' });
      }
    }
    return res.json(customerResponse(user));
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'ACCOUNT_CONFLICT', message: 'חשבון זה כבר מקושר למשתמש אחר. פנו לתמיכה.' });
    return next(error);
  }
}

module.exports = { registerCustomer, loginCustomer, loginWithGoogle };