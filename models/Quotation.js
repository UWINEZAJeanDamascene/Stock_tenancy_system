const mongoose = require('mongoose');
const { generateUniqueNumber } = require('./utils/autoIncrement');

const quotationItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
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
  taxRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  subtotal: {
    type: Number,
    required: true
  },
  total: {
    type: Number,
    required: true
  }
});

const quotationSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Quotation must belong to a company']
  },
  quotationNumber: {
    type: String,
    uppercase: true
  },
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  status: {
    type: String,
    enum: ['draft', 'sent', 'approved', 'rejected', 'converted', 'expired'],
    default: 'draft'
  },
  items: [quotationItemSchema],
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
  validUntil: {
    type: Date,
    required: true
  },
  terms: String,
  notes: String,
  // Store company and client TINs for PDF/printing convenience
  companyTin: String,
  clientTin: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedDate: Date,
  convertedToInvoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  conversionDate: Date
}, {
  timestamps: true
});

// Compound index for company + unique quotation number
quotationSchema.index({ company: 1, quotationNumber: 1 }, { unique: true });
quotationSchema.index({ company: 1 });

// Auto-generate quotation number
quotationSchema.pre('save', async function(next) {
  if (this.isNew && !this.quotationNumber) {
    this.quotationNumber = await generateUniqueNumber('QUO', mongoose.model('Quotation'), this.company, 'quotationNumber');
  }
  next();
});

// Calculate totals before saving
quotationSchema.pre('save', function(next) {
  if (this.items && this.items.length > 0) {
    this.subtotal = this.items.reduce((sum, item) => sum + item.subtotal, 0);
    this.totalDiscount = this.items.reduce((sum, item) => sum + item.discount, 0);
    this.totalTax = this.items.reduce((sum, item) => {
      const itemTotal = item.subtotal - item.discount;
      return sum + (itemTotal * item.taxRate / 100);
    }, 0);
    this.grandTotal = this.subtotal - this.totalDiscount + this.totalTax;
  }
  next();
});

module.exports = mongoose.model('Quotation', quotationSchema);
