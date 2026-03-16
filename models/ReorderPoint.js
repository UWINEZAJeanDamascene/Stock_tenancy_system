const mongoose = require('mongoose');

const reorderPointSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Reorder point must belong to a company']
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  // Primary supplier for reordering
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  // Reorder point settings
  reorderPoint: {
    type: Number,
    required: [true, 'Please provide reorder point'],
    min: [0, 'Reorder point cannot be negative']
  },
  reorderQuantity: {
    type: Number,
    required: [true, 'Please provide reorder quantity'],
    min: [1, 'Reorder quantity must be at least 1']
  },
  // Safety stock level (buffer stock)
  safetyStock: {
    type: Number,
    default: 0,
    min: 0
  },
  // Maximum stock level
  maxStock: {
    type: Number,
    min: 0
  },
  // Lead time in days
  leadTimeDays: {
    type: Number,
    default: 7,
    min: 0
  },
  // Cost at time of setting
  estimatedUnitCost: {
    type: Number,
    min: 0
  },
  // Auto-reorder settings
  autoReorder: {
    type: Boolean,
    default: false
  },
  // Reorder status
  isActive: {
    type: Boolean,
    default: true
  },
  // Last reorder info
  lastReorderDate: Date,
  lastReorderQuantity: Number,
  lastReorderPrice: Number,
  // Next reorder date (calculated)
  nextReorderDate: Date,
  // Notes
  notes: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound indexes for efficient querying
reorderPointSchema.index({ company: 1, product: 1 }, { unique: true });
reorderPointSchema.index({ company: 1, supplier: 1 });
reorderPointSchema.index({ company: 1, isActive: 1 });

// Pre-save to calculate next reorder date
reorderPointSchema.pre('save', function(next) {
  if (this.reorderPoint && this.leadTimeDays) {
    // Calculate next reorder date based on current stock and lead time
    // This is a simplified calculation - actual implementation would check current stock
    const estimatedStockDepletionDate = new Date();
    estimatedStockDepletionDate.setDate(estimatedStockDepletionDate.getDate() + (this.reorderPoint * 2)); // Rough estimate
    this.nextReorderDate = new Date(estimatedStockDepletionDate.getTime() + (this.leadTimeDays * 24 * 60 * 60 * 1000));
  }
  next();
});

// Static method to find products that need reordering
reorderPointSchema.statics.findItemsNeedingReorder = async function(companyId) {
  const Product = mongoose.model('Product');
  
  const reorderPoints = await this.find({ company: companyId, isActive: true })
    .populate('product', 'name sku currentStock averageCost')
    .populate('supplier', 'name code contact');
  
  const itemsNeedingReorder = [];
  
  for (const rp of reorderPoints) {
    const currentStock = rp.product.currentStock || 0;
    
    if (currentStock <= rp.reorderPoint) {
      itemsNeedingReorder.push({
        reorderPoint: rp,
        currentStock,
        isBelowReorderPoint: true,
        isBelowSafetyStock: currentStock <= rp.safetyStock,
        suggestedReorderQuantity: rp.reorderQuantity,
        estimatedCost: rp.reorderQuantity * (rp.estimatedUnitCost || rp.product.averageCost || 0)
      });
    }
  }
  
  return itemsNeedingReorder;
};

// Virtual for checking if reorder is needed
reorderPointSchema.virtual('isReorderNeeded').get(function() {
  // This would need to be populated with current stock
  return false;
});

// Set toJSON and toObject
reorderPointSchema.set('toJSON', { virtuals: true });
reorderPointSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ReorderPoint', reorderPointSchema);
