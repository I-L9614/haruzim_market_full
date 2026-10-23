const express = require('express');
const { requireAuth, adminOnly } = require('../middleware/auth');
const { getAdminStats } = require('../controllers/analyticsController');

const router = express.Router();

router.get('/stats', requireAuth, adminOnly, getAdminStats);

module.exports = router;
