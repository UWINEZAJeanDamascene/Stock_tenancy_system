const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  recurringInvoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RecurringInvoice'
  },
  planName: String,
  amount: {
    type: Number,
    default: 0,
    min: 0
  },
  currency: {
    type: String,
    default: 'FRW'
  },
  billingCycle: {
    type: String,
    enum: ['weekly', 'monthly', 'quarterly'],
    required: true
  },
  interval: {
    type: Number,
    default: 1,
    min: 1
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'cancelled'],
    default: 'active'
  },
  startDate: {
    type: Date,
    default: Date.now
  },
  endDate: Date,
  nextBillingDate: Date,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

subscriptionSchema.index({ company: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
