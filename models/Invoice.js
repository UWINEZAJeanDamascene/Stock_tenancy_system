const mongoose = require('mongoose');
const { generateUniqueNumber } = require('./utils/autoIncrement');

const invoiceItemSchema = new mongoose.Schema({
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
  unitPrice: {
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

const paymentSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'bank_transfer', 'cheque', 'mobile_money'],
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

const invoiceSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Invoice must belong to a company']
  },
  invoiceNumber: {
    type: String,
    uppercase: true
  },
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  // Customer details captured at invoice time
  customerTin: String,
  customerName: String,
  customerAddress: String,
  
  quotation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quotation'
  },
  
  // Invoice status
  status: {
    type: String,
    enum: ['draft', 'confirmed', 'partial', 'paid', 'cancelled'],
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
  
  items: [invoiceItemSchema],
  
  // Tax breakdown
  totalAEx: {
    type: Number,
    default: 0 // Total without Tax A (0%)
  },
  totalB18: {
    type: Number,
    default: 0 // Total with 18% Tax B
  },
  totalTaxA: {
    type: Number,
    default: 0 // Tax A amount (0%)
  },
  totalTaxB: {
    type: Number,
    default: 0 // Tax B amount (18%)
  },
  
  // Legacy totals (for compatibility)
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
  
  // Payment tracking
  amountPaid: {
    type: Number,
    default: 0
  },
  balance: {
    type: Number,
    default: 0
  },
  payments: [paymentSchema],
  
  // Dates
  dueDate: Date,
  invoiceDate: {
    type: Date,
    default: Date.now
  },
  terms: String,
  notes: String,
  
  // Stock tracking
  stockDeducted: {
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
  ,
  // Link to recurring template if generated automatically
  generatedFromRecurring: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RecurringInvoice'
  },
  // Credit notes applied to this invoice
  creditNotes: [{
    creditNoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditNote' },
    creditNoteNumber: String,
    amount: { type: Number, default: 0 },
    appliedDate: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

// Compound index for company + unique invoice number
invoiceSchema.index({ company: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ company: 1 });

// Auto-generate invoice number
invoiceSchema.pre('save', async function(next) {
  if (this.isNew && !this.invoiceNumber) {
    this.invoiceNumber = await generateUniqueNumber('INV', mongoose.model('Invoice'), this.company, 'invoiceNumber');
  }
  next();
});

// Calculate totals before saving - with Tax A and Tax B support
invoiceSchema.pre('save', function(next) {
  if (this.items && this.items.length > 0) {
    // Calculate tax breakdown
    let totalAEx = 0;
    let totalB18 = 0;
    let totalTaxA = 0;
    let totalTaxB = 0;
    
    this.items.forEach(item => {
      const itemSubtotal = item.quantity * item.unitPrice;
      const itemDiscount = item.discount || 0;
      const netAmount = itemSubtotal - itemDiscount;
      
      if (item.taxCode === 'A') {
        // Tax A - typically 0%
        totalAEx += netAmount;
        totalTaxA += netAmount * (item.taxRate / 100);
      } else if (item.taxCode === 'B') {
        // Tax B - typically 18%
        totalB18 += netAmount;
        totalTaxB += netAmount * (item.taxRate / 100);
      }
      
      // Update item calculations
      item.subtotal = itemSubtotal;
      item.taxAmount = netAmount * (item.taxRate / 100);
      item.totalWithTax = netAmount + item.taxAmount;
    });
    
    // Set tax breakdown
    this.totalAEx = totalAEx;
    this.totalB18 = totalB18;
    this.totalTaxA = totalTaxA;
    this.totalTaxB = totalTaxB;
    
    // Legacy calculations
    this.subtotal = this.items ? this.items.reduce((sum, item) => sum + (item.subtotal || 0), 0) : 0;
    this.totalDiscount = this.items ? this.items.reduce((sum, item) => sum + (item.discount || 0), 0) : 0;
    this.totalTax = totalTaxA + totalTaxB;
    this.grandTotal = this.subtotal - this.totalDiscount + this.totalTax;
    
    // Rounded amount
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
  
  next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);
