const mongoose = require('mongoose');

const stockMovementSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Stock movement must belong to a company']
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  type: {
    type: String,
    enum: ['in', 'out', 'adjustment'],
    required: true
  },
  reason: {
    type: String,
    enum: [
      'purchase', 'sale', 'return', 'damage', 'loss', 
      'theft', 'expired', 'transfer_in', 'transfer_out', 'correction', 'initial_stock'
    ],
    required: true
  },
  quantity: {
    type: Number,
    required: [true, 'Please provide a quantity'],
    min: [0.01, 'Quantity must be greater than 0']
  },
  previousStock: {
    type: Number,
    required: true
  },
  newStock: {
    type: Number,
    required: true
  },
  unitCost: {
    type: Number,
    min: 0
  },
  totalCost: {
    type: Number,
    min: 0
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  warehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse'
  },
  batchNumber: String,
  lotNumber: String,
  expiryDate: Date,
  referenceType: {
    type: String,
    enum: ['purchase', 'purchase_order', 'invoice', 'adjustment', 'return', 'credit_note', 'other']
  },
  referenceNumber: String,
  referenceDocument: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'referenceModel'
  },
  referenceModel: {
    type: String,
    enum: ['Purchase', 'Invoice', 'PurchaseOrder', 'StockAdjustment', 'CreditNote']
  },
  notes: String,
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  movementDate: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
stockMovementSchema.index({ company: 1 });
stockMovementSchema.index({ product: 1, movementDate: -1 });
stockMovementSchema.index({ supplier: 1, movementDate: -1 });
stockMovementSchema.index({ type: 1, movementDate: -1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);
