const mongoose = require('mongoose');
const { generateUniqueNumber } = require('./utils/autoIncrement');

const creditItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  },
  itemCode: String,
  description: String,
  quantity: {
    type: Number,
    default: 1,
    min: 0
  },
  unit: String,
  unitPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  discount: {
    type: Number,
    default: 0,
    min: 0
  },
  taxCode: {
    type: String,
    enum: ['A','B','None'],
    default: 'A'
  },
  taxRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  subtotal: Number,
  taxAmount: Number,
  totalWithTax: Number,
  serialNumbers: [String] // For tracking returned serial numbers
});

const refundPaymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: ['cash','card','bank_transfer','cheque','mobile_money'], required: true },
  reference: String,
  refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  refundedAt: { type: Date, default: Date.now }
});

const creditNoteSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  creditNoteNumber: { type: String, uppercase: true },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
  relatedInvoice: { type: String }, // Original invoice number being corrected
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  clientTIN: { type: String }, // Client Tax ID
  issueDate: { type: Date, default: Date.now },
  reason: { 
    type: String, 
    enum: ['returned', 'damaged', 'overcharge', 'discount', 'other'],
    default: 'returned'
  },
  items: [creditItemSchema],
  subtotal: { type: Number, default: 0 },
  totalTax: { type: Number, default: 0 },
  grandTotal: { type: Number, default: 0 },
  // Status: draft → issued → applied (used on next invoice) | refunded | partially_refunded
  status: { type: String, enum: ['draft', 'issued', 'applied', 'refunded', 'partially_refunded', 'cancelled'], default: 'draft' },
  amountRefunded: { type: Number, default: 0 },
  appliedTo: { type: String }, // Invoice number this credit was applied to
  appliedDate: { type: Date },
  payments: [refundPaymentSchema],
  stockReversed: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

creditNoteSchema.index({ company: 1 });

// Auto-generate credit note number
creditNoteSchema.pre('save', async function(next) {
  if (this.isNew && !this.creditNoteNumber) {
    this.creditNoteNumber = await generateUniqueNumber('CN', mongoose.model('CreditNote'), this.company, 'creditNoteNumber');
  }
  next();
});

// Calculate totals
creditNoteSchema.pre('save', function(next) {
  if (this.items && this.items.length > 0) {
    let subtotal = 0;
    let totalTax = 0;
    this.items.forEach(item => {
      const itemSubtotal = (item.quantity || 0) * (item.unitPrice || 0);
      const discount = item.discount || 0;
      const net = itemSubtotal - discount;
      const taxAmount = net * ((item.taxRate || 0) / 100);
      item.subtotal = itemSubtotal;
      item.taxAmount = taxAmount;
      item.totalWithTax = net + taxAmount;
      subtotal += itemSubtotal;
      totalTax += taxAmount;
    });
    this.subtotal = subtotal;
    this.totalTax = totalTax;
    this.grandTotal = subtotal - (this.items.reduce((s,i)=>s+(i.discount||0),0)) + totalTax;
  }
  next();
});

module.exports = mongoose.model('CreditNote', creditNoteSchema);
