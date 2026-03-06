const mongoose = require('mongoose');

const stockTransferItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  quantity: {
    type: Number,
    required: [true, 'Please provide quantity'],
    min: [1, 'Quantity must be at least 1']
  },
  // For products with serial numbers
  serialNumbers: [{
    type: String,
    uppercase: true
  }],
  // For batch-tracked products
  batchNumber: String,
  notes: String
}, { _id: false });

const stockTransferSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Stock transfer must belong to a company']
  },
  transferNumber: {
    type: String,
    uppercase: true,
    default: function() {
      // This will be auto-generated in pre-save
      return undefined;
    }
  },
  fromWarehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse',
    required: true
  },
  toWarehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse',
    required: true
  },
  items: [stockTransferItemSchema],
  // Status: draft, pending, in_transit, completed, cancelled
  status: {
    type: String,
    enum: ['draft', 'pending', 'in_transit', 'completed', 'cancelled'],
    default: 'draft'
  },
  transferDate: {
    type: Date,
    default: Date.now
  },
  completedDate: {
    type: Date
  },
  // Reason for transfer
  reason: {
    type: String,
    enum: ['rebalance', 'sale', 'return', 'repair', 'consignment', 'other'],
    default: 'rebalance'
  },
  notes: String,
  // Approval workflow
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedDate: Date,
  // Receiving info
  receivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  receivedDate: Date,
  receivedNotes: String,
  // Reference to related documents
  referenceNumber: String,
  // User who created the transfer
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound indexes for efficient querying
stockTransferSchema.index({ company: 1, transferNumber: 1 }, { unique: true });
stockTransferSchema.index({ company: 1, status: 1 });
stockTransferSchema.index({ fromWarehouse: 1, status: 1 });
stockTransferSchema.index({ toWarehouse: 1, status: 1 });
stockTransferSchema.index({ transferDate: -1 });

// Pre-save middleware to generate transfer number
stockTransferSchema.pre('save', async function(next) {
  if (this.isNew && !this.transferNumber) {
    const count = await mongoose.model('StockTransfer').countDocuments({ company: this.company });
    this.transferNumber = `TRF-${String(count + 1).padStart(6, '0')}`;
  }
  
  // Validate from and to warehouses are different
  if (this.fromWarehouse.toString() === this.toWarehouse.toString()) {
    const error = new Error('Source and destination warehouses must be different');
    error.name = 'ValidationError';
    return next(error);
  }
  
  next();
});

// Method to validate transfer can be completed
stockTransferSchema.methods.canComplete = async function() {
  const InventoryBatch = mongoose.model('InventoryBatch');
  
  for (const item of this.items) {
    // Check if batch exists in source warehouse
    const batch = await InventoryBatch.findOne({
      product: item.product,
      warehouse: this.fromWarehouse,
      batchNumber: item.batchNumber || { $exists: true },
      availableQuantity: { $gte: item.quantity }
    });
    
    if (!batch) {
      return { valid: false, message: `Insufficient stock for product ${item.product}` };
    }
  }
  
  return { valid: true };
};

// Set toJSON and toObject
stockTransferSchema.set('toJSON', { virtuals: true });
stockTransferSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('StockTransfer', stockTransferSchema);
