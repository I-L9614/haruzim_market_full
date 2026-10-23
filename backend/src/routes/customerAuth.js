const express = require('express');
const { requireCustomerAuth } = require('../middleware/auth');
const { createRateLimit } = require('../middleware/rateLimit');
const { registerCustomer, loginCustomer, loginWithGoogle } = require('../controllers/customerAuthController');

const router = express.Router();
const loginLimit = createRateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'בוצעו יותר מדי ניסיונות התחברות. נסו שוב בעוד 15 דקות.' });
router.post('/register', loginLimit, registerCustomer);
router.post('/login', loginLimit, loginCustomer);
router.post('/google', loginLimit, loginWithGoogle);
router.get('/me', requireCustomerAuth, (req, res) => res.json({ user: { id: String(req.customerUser._id), name: req.customerUser.name, email: req.customerUser.email } }));

module.exports = router;