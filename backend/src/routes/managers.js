const express = require('express');
const { requireAuth, ownerOnly } = require('../middleware/auth');
const { listManagers, createManager, deactivateManager } = require('../controllers/managerController');
const { shabbatMiddleware } = require('../middleware/shabbat');

const router = express.Router();
router.use(requireAuth, ownerOnly);
router.get('/', listManagers);
router.post('/', shabbatMiddleware, createManager);
router.delete('/:id', shabbatMiddleware, deactivateManager);

module.exports = router;