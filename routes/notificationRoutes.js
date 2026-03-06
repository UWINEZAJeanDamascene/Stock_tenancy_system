const express = require('express');
const router = express.Router();
const {
  getSettings,
  updateSettings,
  testEmail,
  testSMS,
  sendManualSummary
} = require('../controllers/notificationController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

// Settings management
router.route('/settings')
  .get(authorize('admin'), getSettings)
  .put(authorize('admin'), updateSettings);

// Test endpoints
router.post('/test-email', authorize('admin'), testEmail);
router.post('/test-sms', authorize('admin'), testSMS);

// Manual summary
router.post('/send-summary', authorize('admin'), sendManualSummary);

module.exports = router;
