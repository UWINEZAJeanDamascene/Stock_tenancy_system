const express = require('express');
const router = express.Router();
const {
  getSettings,
  updateSettings,
  testEmail,
  testSMS,
  sendManualSummary,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification
} = require('../controllers/notificationController');
const { protect, authorize } = require('../middleware/auth');

router.use(protect);

// Settings management (must come before /:id routes)
router.route('/settings')
  .get(authorize('admin'), getSettings)
  .put(authorize('admin'), updateSettings);

// Test endpoints
router.post('/test-email', authorize('admin'), testEmail);
router.post('/test-sms', authorize('admin'), testSMS);

// Manual summary
router.post('/send-summary', authorize('admin'), sendManualSummary);

// Unread count
router.get('/unread-count', getUnreadCount);

// Mark all as read
router.put('/read-all', markAllAsRead);

// Notifications (actual notification items) - must come before /:id
router.route('/')
  .get(getNotifications);

// Single notification operations (must come last)
router.delete('/:id', deleteNotification);
router.put('/:id/read', markAsRead);

module.exports = router;
