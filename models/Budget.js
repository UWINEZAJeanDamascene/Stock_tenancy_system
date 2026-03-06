const mongoose = require('mongoose');

const budgetSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  name: { type: String, required: true },
  type: { type: String, enum: ['revenue', 'expense'], required: true },
  amount: { type: Number, required: true, default: 0 },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date },
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Budget', budgetSchema);
