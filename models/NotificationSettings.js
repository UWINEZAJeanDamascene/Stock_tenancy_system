const mongoose = require('mongoose');

const notificationSettingsSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true
  },
  // Email notifications
  emailNotifications: {
    enabled: { type: Boolean, default: true },
    invoiceDelivery: { type: Boolean, default: false },
    paymentReminders: { type: Boolean, default: true },
    lowStockAlerts: { type: Boolean, default: true },
    dailySummary: { type: Boolean, default: false },
    weeklySummary: { type: Boolean, default: true }
  },
  // SMS notifications
  smsNotifications: {
    enabled: { type: Boolean, default: false },
    criticalOnly: { type: Boolean, default: true },
    adminPhones: [{ type: String }] // Array of phone numbers
  },
  // Notification preferences
  preferences: {
    lowStockThreshold: { type: Number, default: 10 },
    paymentReminderDays: { type: Number, default: 3 },
    summarySendTime: { type: String, default: '09:00' }, // HH:MM format
    largeOrderThreshold: { type: Number, default: 10000 }
  },
  // Admin phone numbers for critical alerts
  criticalAlertPhones: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

notificationSettingsSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('NotificationSettings', notificationSettingsSchema);
