const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { getAuditTrail, getAuditStats, getAuditDetail } = require('../controllers/auditTrailController');

router.use(protect);
router.use(authorize('admin'));

router.get('/', getAuditTrail);
router.get('/stats', getAuditStats);
router.get('/:id', getAuditDetail);

module.exports = router;
