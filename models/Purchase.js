const mongoose = require('mongoose');
const { generateUniqueNumber } = require('./utils/autoIncrement');

const purchaseItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  itemCode: String,
  description: String,
  quantity: {
    type: Number,
    required: true,
    min: 0.01
  },
  unit: String,
  unitCost: {
    type: Number,
    required: true,
    min: 0
  },
  discount: {
    type: Number,
    default: 0,
    min: 0
  },
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
  taxAmount: {
    type: Number,
    default: 0
  },
  subtotal: {
    type: Number,
    required: true
  },
  totalWithTax: {
    type: Number,
    required: true
  }
});

const purchasePaymentSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'bank_transfer', 'cheque', 'mobile_money', 'credit'],
    required: true
  },
  reference: String,
  paidDate: {
    type: Date,
    default: Date.now
  },
  notes: String,
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

const purchaseSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Purchase must belong to a company']
  },
  purchaseNumber: {
    type: String,
    uppercase: true
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  // Supplier details captured at purchase time
  supplierTin: String,
  supplierName: String,
  supplierAddress: String,
  
  // Invoice from supplier
  supplierInvoiceNumber: String,
  supplierInvoiceDate: Date,
  
  // Status
  status: {
    type: String,
    enum: ['draft', 'ordered', 'received', 'partial', 'paid', 'cancelled'],
    default: 'draft'
  },
  
  // Currency and payment terms
  currency: {
    type: String,
    default: 'FRW'
  },
  paymentTerms: {
    type: String,
    enum: ['cash', 'credit_7', 'credit_15', 'credit_30', 'credit_45', 'credit_60'],
    default: 'cash'
  },
  
  items: [purchaseItemSchema],
  
  // Tax breakdown
  totalAEx: {
    type: Number,
    default: 0
  },
  totalB18: {
    type: Number,
    default: 0
  },
  totalTaxA: {
    type: Number,
    default: 0
  },
  totalTaxB: {
    type: Number,
    default: 0
  },
  
  // Legacy totals
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
  roundedAmount: {
    type: Number,
    default: 0
  },
  // Backwards-compatible field names expected by some consumers
  taxAmount: {
    type: Number,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  total: {
    type: Number,
    default: 0
  },
  
  // Payment tracking
  amountPaid: {
    type: Number,
    default: 0
  },
  balance: {
    type: Number,
    default: 0
  },
  payments: [purchasePaymentSchema],
  
  // Dates
  expectedDeliveryDate: Date,
  purchaseDate: {
    type: Date,
    default: Date.now
  },
  receivedDate: Date,
  terms: String,
  notes: String,
  
  // Stock tracking
  stockAdded: {
    type: Boolean,
    default: false
  },
  
  // User tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  paidDate: Date,
  confirmedDate: Date,
  confirmedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancelledDate: Date,
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancellationReason: String
}, {
  timestamps: true
});

// Compound index for company + unique purchase number
purchaseSchema.index({ company: 1, purchaseNumber: 1 }, { unique: true });
purchaseSchema.index({ company: 1 });

// Performance indexes for reports
purchaseSchema.index({ company: 1, status: 1 });
purchaseSchema.index({ company: 1, purchaseDate: 1 });
purchaseSchema.index({ company: 1, supplier: 1 });
purchaseSchema.index({ 'payments.paidDate': 1 });

// Auto-generate purchase number
purchaseSchema.pre('save', async function(next) {
  if (this.isNew && !this.purchaseNumber) {
    this.purchaseNumber = await generateUniqueNumber('PO', mongoose.model('Purchase'), this.company, 'purchaseNumber');
  }
  next();
});

// Calculate totals before saving
purchaseSchema.pre('save', function(next) {
  if (this.items && this.items.length > 0) {
    let totalAEx = 0;
    let totalB18 = 0;
    let totalTaxA = 0;
    let totalTaxB = 0;
    
    this.items.forEach(item => {
      const itemSubtotal = item.quantity * item.unitCost;
      const itemDiscount = item.discount || 0;
      const netAmount = itemSubtotal - itemDiscount;
      
      if (item.taxCode === 'A') {
        totalAEx += netAmount;
        totalTaxA += netAmount * (item.taxRate / 100);
      } else if (item.taxCode === 'B') {
        totalB18 += netAmount;
        totalTaxB += netAmount * (item.taxRate / 100);
      }
      
      item.subtotal = itemSubtotal;
      item.taxAmount = netAmount * (item.taxRate / 100);
      item.totalWithTax = netAmount + item.taxAmount;
    });
    
    this.totalAEx = totalAEx;
    this.totalB18 = totalB18;
    this.totalTaxA = totalTaxA;
    this.totalTaxB = totalTaxB;
    
    this.subtotal = this.items ? this.items.reduce((sum, item) => sum + (item.subtotal || 0), 0) : 0;
    this.totalDiscount = this.items ? this.items.reduce((sum, item) => sum + (item.discount || 0), 0) : 0;
    this.totalTax = totalTaxA + totalTaxB;
    this.grandTotal = this.subtotal - this.totalDiscount + this.totalTax;
    this.roundedAmount = Math.round(this.grandTotal * 100) / 100;
    
    // Always calculate balance - ensure it's never undefined
    this.balance = (this.roundedAmount || 0) - (this.amountPaid || 0);
  }
  
  // Update status based on payment
  if (this.amountPaid >= this.roundedAmount && this.roundedAmount > 0) {
    this.status = 'paid';
    if (!this.paidDate) {
      this.paidDate = new Date();
    }
  } else if (this.amountPaid > 0 && this.amountPaid < this.roundedAmount) {
    this.status = 'partial';
  }

  // Backwards-compatible aliases
  this.taxAmount = this.totalTax;
  this.discount = this.totalDiscount;
  this.total = this.roundedAmount || this.grandTotal;
  
  next();
});

module.exports = mongoose.model('Purchase', purchaseSchema);
