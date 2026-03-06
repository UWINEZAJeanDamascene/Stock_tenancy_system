const mongoose = require('mongoose');

const auditItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  // System recorded quantity
  systemQuantity: {
    type: Number,
    required: true,
    min: 0
  },
  // Physical counted quantity
  countedQuantity: {
    type: Number,
    required: true,
    min: 0
  },
  // Variance (can be positive or negative)
  variance: {
    type: Number,
    required: true
  },
  // Notes for this item
  notes: String,
  // Status: pending, verified, adjusted
  status: {
    type: String,
    enum: ['pending', 'verified', 'adjusted'],
    default: 'pending'
  },
  // Batch info if applicable
  batchNumber: String,
  // Counted by
  countedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  countedDate: Date
}, { _id: true });

const stockAuditSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Stock audit must belong to a company']
  },
  auditNumber: {
    type: String,
    required: true,
    uppercase: true
  },
  // Warehouse being audited (null means all warehouses)
  warehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse'
  },
  // Category being audited (null means all categories)
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category'
  },
  // Type of audit
  type: {
    type: String,
    enum: ['full', 'partial', 'cycle_count', 'spot_check'],
    default: 'cycle_count'
  },
  items: [auditItemSchema],
  // Status: draft, in_progress, completed, cancelled
  status: {
    type: String,
    enum: ['draft', 'in_progress', 'completed', 'cancelled'],
    default: 'draft'
  },
  // Dates
  startDate: {
    type: Date,
    default: Date.now
  },
  completedDate: Date,
  dueDate: Date,
  // Summary statistics
  totalItems: {
    type: Number,
    default: 0
  },
  itemsCounted: {
    type: Number,
    default: 0
  },
  itemsWithVariance: {
    type: Number,
    default: 0
  },
  totalVarianceValue: {
    type: Number,
    default: 0
  },
  // Notes
  notes: String,
  // Approval and completion
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedDate: Date,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound indexes for efficient querying
stockAuditSchema.index({ company: 1, auditNumber: 1 }, { unique: true });
stockAuditSchema.index({ company: 1, status: 1 });
stockAuditSchema.index({ warehouse: 1, status: 1 });
stockAuditSchema.index({ startDate: -1 });

// Pre-save middleware to generate audit number
stockAuditSchema.pre('save', async function(next) {
  if (this.isNew && !this.auditNumber) {
    const count = await mongoose.model('StockAudit').countDocuments({ company: this.company });
    this.auditNumber = `AUD-${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

// Method to calculate summary statistics
stockAuditSchema.methods.calculateSummary = function() {
  this.totalItems = this.items.length;
  this.itemsCounted = this.items.filter(item => item.status !== 'pending').length;
  this.itemsWithVariance = this.items.filter(item => item.variance !== 0).length;
  // Note: totalVarianceValue would need product cost information to calculate accurately
  this.totalVarianceValue = this.items.reduce((sum, item) => sum + Math.abs(item.variance), 0);
  return this;
};

// Method to add or update audit item
stockAuditSchema.methods.addItem = function(productId, countedQuantity, systemQuantity, countedBy, notes) {
  const existingItem = this.items.find(item => item.product.toString() === productId.toString());
  
  if (existingItem) {
    existingItem.countedQuantity = countedQuantity;
    existingItem.variance = countedQuantity - systemQuantity;
    existingItem.countedBy = countedBy;
    existingItem.countedDate = new Date();
    existingItem.notes = notes;
    existingItem.status = 'verified';
  } else {
    this.items.push({
      product: productId,
      systemQuantity,
      countedQuantity,
      variance: countedQuantity - systemQuantity,
      countedBy,
      countedDate: new Date(),
      notes,
      status: 'verified'
    });
  }
  
  this.calculateSummary();
  return this;
};

// Set toJSON and toObject
stockAuditSchema.set('toJSON', { virtuals: true });
stockAuditSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('StockAudit', stockAuditSchema);
