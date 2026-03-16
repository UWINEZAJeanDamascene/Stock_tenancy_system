const mongoose = require('mongoose');

const purchaseReturnItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  unitPrice: {
    type: Number,
    required: true
  },
  discount: {
    type: Number,
    default: 0
  },
  total: {
    type: Number,
    required: true
  },
  reason: {
    type: String,
    enum: ['wrong_goods', 'damaged', 'overdelivery', 'wrong_specifications', 'quality_issues', 'expired', 'other'],
    default: 'other'
  },
  notes: String
});

const purchaseReturnSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Purchase return must belong to a company']
  },

  // Reference number
  purchaseReturnNumber: {
    type: String,
    uppercase: true
  },

  // Linked purchase (if returning items from a specific purchase)
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase'
  },

  // Supplier
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: [true, 'Purchase return must have a supplier']
  },

  // Date
  returnDate: {
    type: Date,
    default: Date.now
  },

  // Items
  items: [purchaseReturnItemSchema],

  // Totals
  subtotal: {
    type: Number,
    default: 0
  },
  totalDiscount: {
    type: Number,
    default: 0
  },
  totalTax: {
    type: Number,
    default: 0
  },
  grandTotal: {
    type: Number,
    default: 0
  },

  // Status
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved', 'rejected', 'refunded', 'partially_refunded', 'cancelled'],
    default: 'draft'
  },

  // Financial tracking
  // Original purchase was paid or not
  originalPurchasePaid: {
    type: Boolean,
    default: false
  },
  originalPurchasePaymentDate: Date,
  
  // Refund tracking
  refundAmount: {
    type: Number,
    default: 0
  },
  refundMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'cheque', 'credit', 'none'],
    default: 'none'
  },
  refunded: {
    type: Boolean,
    default: false
  },
  refundDate: Date,
  
  // Accounts Payable impact
  // If original purchase was unpaid, reduce AP by this amount
  reduceAccountsPayable: {
    type: Boolean,
    default: false
  },
  accountsPayableReduction: {
    type: Number,
    default: 0
  },

  // Notes
  notes: String,

  // User tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Auto-generate purchase return number
purchaseReturnSchema.pre('save', async function(next) {
  if (this.isNew && !this.purchaseReturnNumber) {
    const count = await mongoose.model('PurchaseReturn').countDocuments({ company: this.company });
    this.purchaseReturnNumber = `PR-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

// Calculate totals before saving
purchaseReturnSchema.pre('save', function(next) {
  // Calculate subtotal from items
  this.subtotal = this.items.reduce((sum, item) => sum + (item.total || 0), 0);
  
  // Grand total = subtotal - discount + tax
  this.grandTotal = this.subtotal - (this.totalDiscount || 0) + (this.totalTax || 0);
  
  // Set accounts payable reduction amount
  if (this.reduceAccountsPayable && !this.originalPurchasePaid) {
    this.accountsPayableReduction = this.grandTotal;
  } else {
    this.accountsPayableReduction = 0;
  }
  
  next();
});

// Index for efficient queries
purchaseReturnSchema.index({ company: 1, purchaseReturnNumber: 1 });
purchaseReturnSchema.index({ company: 1, supplier: 1 });
purchaseReturnSchema.index({ company: 1, purchase: 1 });
purchaseReturnSchema.index({ company: 1, returnDate: 1 });
purchaseReturnSchema.index({ company: 1, status: 1 });

module.exports = mongoose.model('PurchaseReturn', purchaseReturnSchema);
