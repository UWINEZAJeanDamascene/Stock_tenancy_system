const mongoose = require('mongoose');

const inventoryBatchSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Inventory batch must belong to a company']
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  warehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse',
    required: true
  },
  batchNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  lotNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  expiryDate: {
    type: Date
  },
  quantity: {
    type: Number,
    required: [true, 'Please provide quantity'],
    min: [0, 'Quantity cannot be negative']
  },
  availableQuantity: {
    type: Number,
    required: [true, 'Please provide available quantity'],
    min: [0, 'Available quantity cannot be negative']
  },
  reservedQuantity: {
    type: Number,
    default: 0,
    min: [0, 'Reserved quantity cannot be negative']
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
  // For tracking incoming stock movement
  stockMovement: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StockMovement'
  },
  // Additional metadata
  manufacturingDate: {
    type: Date
  },
  notes: String,
  // Status: active, partially_used, exhausted, expired, quarantined
  status: {
    type: String,
    enum: ['active', 'partially_used', 'exhausted', 'expired', 'quarantined'],
    default: 'active'
  },
  receivedDate: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound indexes for efficient querying
inventoryBatchSchema.index({ company: 1, product: 1 });
inventoryBatchSchema.index({ company: 1, warehouse: 1 });
inventoryBatchSchema.index({ batchNumber: 1, company: 1 });
inventoryBatchSchema.index({ lotNumber: 1, company: 1 });
inventoryBatchSchema.index({ expiryDate: 1, company: 1 });
inventoryBatchSchema.index({ product: 1, warehouse: 1, status: 1 });

// Virtual for checking if batch is expired
inventoryBatchSchema.virtual('isExpired').get(function() {
  if (!this.expiryDate) return false;
  return new Date() > this.expiryDate;
});

// Virtual for checking if batch is low stock
inventoryBatchSchema.virtual('isLowStock').get(function() {
  return this.availableQuantity > 0 && this.availableQuantity <= 10;
});

// Virtual for checking if batch is nearing expiration (within 30 days)
inventoryBatchSchema.virtual('isNearingExpiry').get(function() {
  if (!this.expiryDate) return false;
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
  return this.expiryDate <= thirtyDaysFromNow && this.expiryDate > new Date();
});

// Update status based on quantities
inventoryBatchSchema.methods.updateStatus = function() {
  if (this.availableQuantity === 0 && this.reservedQuantity === 0) {
    this.status = 'exhausted';
  } else if (this.availableQuantity < this.quantity) {
    this.status = 'partially_used';
  } else if (this.isExpired) {
    this.status = 'expired';
  } else {
    this.status = 'active';
  }
  return this;
};

// Pre-save middleware to calculate totals
inventoryBatchSchema.pre('save', function(next) {
  this.totalCost = this.quantity * (this.unitCost || 0);
  this.updateStatus();
  next();
});

// Set toJSON and toObject to include virtuals
inventoryBatchSchema.set('toJSON', { virtuals: true });
inventoryBatchSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('InventoryBatch', inventoryBatchSchema);
