const mongoose = require('mongoose');

const cashTransactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['sale', 'refund', 'cash_in', 'cash_out'], required: true },
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: ['cash', 'card', 'mobile_money', 'other'], default: 'cash' },
  reference: String,
  notes: String,
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  timestamp: { type: Date, default: Date.now }
});

const cashDrawerSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  drawerId: { type: String, required: true },
  status: { type: String, enum: ['open', 'closed'], default: 'closed' },
  openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  openedAt: Date,
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  closedAt: Date,
  openingBalance: { type: Number, default: 0 },
  closingBalance: { type: Number, default: 0 },
  transactions: [cashTransactionSchema],
  notes: String
}, {
  timestamps: true
});

cashDrawerSchema.index({ company: 1, drawerId: 1 }, { unique: true });

module.exports = mongoose.model('CashDrawer', cashDrawerSchema);
