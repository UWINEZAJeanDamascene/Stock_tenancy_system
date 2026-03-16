const mongoose = require('mongoose');

const actionLogSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Action log must belong to a company']
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  action: {
    type: String,
    required: true
  },
  module: {
    type: String,
    enum: [
      'product', 'stock', 'supplier', 'client', 
      'quotation', 'invoice', 'user', 'category', 'report', 'purchase', 'company', 'department', 'receivable',
      'delivery_note'
    ],
    required: true
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId
  },
  targetModel: String,
  details: mongoose.Schema.Types.Mixed,
  ipAddress: String,
  userAgent: String,
  status: {
    type: String,
    enum: ['success', 'failed'],
    default: 'success'
  }
}, {
  timestamps: true
});

// Index for efficient querying
actionLogSchema.index({ company: 1 });
actionLogSchema.index({ user: 1, createdAt: -1 });
actionLogSchema.index({ module: 1, createdAt: -1 });
actionLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ActionLog', actionLogSchema);
