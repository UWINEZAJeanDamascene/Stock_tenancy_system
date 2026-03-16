const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      'low_stock', 'out_of_stock', 'stock_received',
      'invoice_created', 'payment_received', 'payment_overdue', 'invoice_sent',
      'quotation_created', 'quotation_approved', 'quotation_expired',
      'user_created', 'company_approved', 'password_changed', 'failed_login',
      'backup_success', 'backup_failed',
      'invoice_generated', 'recurring_paused',
      'system', 'alert'
    ],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'info'
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date,
    default: null
  },
  link: {
    type: String,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Index for efficient queries
notificationSchema.index({ company: 1, user: 1, isRead: 1, createdAt: -1 });

// Static method to create notification
notificationSchema.statics.createNotification = async function(data) {
  const notification = await this.create(data);
  return notification;
};

// Static method to get unread count
notificationSchema.statics.getUnreadCount = async function(companyId, userId) {
  return this.countDocuments({
    company: companyId,
    user: userId,
    isRead: false
  });
};

module.exports = mongoose.model('Notification', notificationSchema);
