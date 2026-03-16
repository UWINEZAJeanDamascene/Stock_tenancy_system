const mongoose = require('mongoose');
const { generateUniqueCode } = require('./utils/autoIncrement');

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
  // Barcode fields
  barcode: {
    type: String,
    trim: true,
    default: null
  },
  barcodeType: {
    type: String,
    enum: ['CODE128', 'EAN13', 'EAN8', 'UPC', 'CODE39', 'ITF14', 'QR', 'NONE'],
    default: 'CODE128'
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
  sellingPrice: {
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
  // Additional product attributes
  weight: {
    type: Number,
    default: 0,
    min: 0
  },
  brand: {
    type: String,
    trim: true
  },
  location: {
    type: String,
    trim: true
  },
  // Advanced inventory tracking flags
  trackBatch: {
    type: Boolean,
    default: false
  },
  trackSerialNumbers: {
    type: Boolean,
    default: false
  },
  // Reorder settings
  reorderPoint: {
    type: Number,
    min: 0
  },
  reorderQuantity: {
    type: Number,
    min: 0
  },
  // Multiple warehouse support - store default warehouse
  defaultWarehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse'
  },
  // Preferred supplier for reordering
  preferredSupplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  // Tax settings: product-level default tax code and rate
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

// Performance indexes for reports and queries
productSchema.index({ company: 1, category: 1 });
productSchema.index({ company: 1, isArchived: 1 });
productSchema.index({ company: 1, currentStock: 1 });
productSchema.index({ supplier: 1 });

// Virtual for low stock alert
productSchema.virtual('isLowStock').get(function() {
  return this.currentStock <= this.lowStockThreshold;
});

// Add history entry before save
productSchema.pre('save', async function(next) {
  if (this.isNew) {
    // Handle SKU conflicts - if SKU already exists, generate a unique one
    if (this.sku) {
      const existing = await mongoose.model('Product').findOne({
        company: this.company,
        sku: this.sku.toUpperCase()
      });
      
      if (existing) {
        this.sku = await generateUniqueCode('PRD', mongoose.model('Product'), this.company, 'sku');
      }
    }
    
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
