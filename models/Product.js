const mongoose = require('mongoose');

const productHistorySchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['created', 'updated', 'archived', 'restored'],
    required: true
  },
  changes: {
    type: mongoose.Schema.Types.Mixed
  },
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  notes: String
});

const productSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Product must belong to a company']
  },
  name: {
    type: String,
    required: [true, 'Please provide a product name'],
    trim: true
  },
  sku: {
    type: String,
    required: [true, 'Please provide a SKU'],
    uppercase: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: [true, 'Please provide a category']
  },
  unit: {
    type: String,
    required: [true, 'Please provide a unit of measurement'],
    enum: ['kg', 'g', 'pcs', 'box', 'm', 'm²', 'm³', 'l', 'ml', 'ton', 'bag', 'roll', 'sheet', 'set'],
    default: 'pcs'
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  currentStock: {
    type: Number,
    default: 0,
    min: 0
  },
  lowStockThreshold: {
    type: Number,
    default: 10,
    min: 0
  },
  averageCost: {
    type: Number,
    default: 0,
    min: 0
  },
  lastSupplyDate: {
    type: Date
  },
  lastSaleDate: {
    type: Date
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  history: [productHistorySchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound index for company + unique sku
productSchema.index({ company: 1, sku: 1 }, { unique: true });
// Index for searching
productSchema.index({ name: 'text', sku: 'text', description: 'text' });
// Index for company filtering
productSchema.index({ company: 1 });

// Virtual for low stock alert
productSchema.virtual('isLowStock').get(function() {
  return this.currentStock <= this.lowStockThreshold;
});

// Add history entry before save
productSchema.pre('save', function(next) {
  if (this.isNew) {
    this.history.push({
      action: 'created',
      changedBy: this.createdBy,
      changes: this.toObject()
    });
  }
  next();
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);
