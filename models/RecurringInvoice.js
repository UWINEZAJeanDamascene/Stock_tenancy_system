const mongoose = require('mongoose');

const recurringItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  },
  description: String,
  itemCode: String,
  quantity: {
    type: Number,
    default: 1,
    min: 0
  },
  unit: String,
  unitPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  discount: {
    type: Number,
    default: 0,
    min: 0
  },
  taxCode: {
    type: String,
    enum: ['A', 'B', 'None'],
    default: 'A'
  },
  taxRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  }
});

const scheduleSchema = new mongoose.Schema({
  frequency: {
    type: String,
    enum: ['weekly', 'monthly', 'quarterly'],
    required: true
  },
  interval: {
    type: Number,
    default: 1,
    min: 1
  },
  // optional: day of month for monthly schedules (1-28/31)
  dayOfMonth: Number,
  // optional: day of week for weekly schedules (0-6)
  dayOfWeek: Number
});

const recurringInvoiceSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  name: String,
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  items: [recurringItemSchema],
  schedule: scheduleSchema,
  startDate: {
    type: Date,
    default: Date.now
  },
  endDate: Date,
  nextRunDate: Date,
  active: {
    type: Boolean,
    default: true
  },
  // whether generated invoices should be auto-confirmed
  autoConfirm: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, { timestamps: true });

recurringInvoiceSchema.index({ company: 1 });

module.exports = mongoose.model('RecurringInvoice', recurringInvoiceSchema);
