const mongoose = require('mongoose');

const loanPaymentSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  paymentDate: {
    type: Date,
    default: Date.now
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'cheque', 'mobile_money'],
  },
  reference: String,
  notes: String,
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

const loanSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Loan must belong to a company']
  },
  loanNumber: {
    type: String,
    uppercase: true
  },
  lenderName: {
    type: String,
    required: [true, 'Please provide lender name'],
    trim: true
  },
  lenderContact: String,
  
  // Loan details
  loanType: {
    type: String,
    enum: ['short-term', 'long-term'],
    required: true
  },
  purpose: {
    type: String,
    trim: true
  },
  originalAmount: {
    type: Number,
    required: true,
    min: 0
  },
  interestRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  // Interest calculation method
  interestMethod: {
    type: String,
    enum: ['simple', 'compound'],
    default: 'simple'
  },
  // Duration in months (drives schedule calculation)
  durationMonths: {
    type: Number,
    min: 1
  },
  
  // Dates
  startDate: {
    type: Date,
    required: true
  },
  endDate: Date,
  
  // Status
  status: {
    type: String,
    enum: ['active', 'paid-off', 'defaulted', 'cancelled'],
    default: 'active'
  },
  
  // Payment tracking
  amountPaid: {
    type: Number,
    default: 0
  },
  payments: [loanPaymentSchema],
  
  // How the loan was received
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'cheque', 'mobile_money'],
    default: 'bank_transfer'
  },
  
  // Terms
  paymentTerms: {
    type: String,
    enum: ['monthly', 'quarterly', 'annually', 'bullet'],
    default: 'monthly'
  },
  monthlyPayment: Number,
  
  // Security/collateral
  collateral: String,
  notes: String,
  
  // User tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Compound index for company + unique loan number
loanSchema.index({ company: 1, loanNumber: 1 }, { unique: true });
loanSchema.index({ company: 1 });
loanSchema.index({ company: 1, status: 1 });

// Auto-generate loan number
loanSchema.pre('save', async function(next) {
  if (this.isNew && !this.loanNumber) {
    const count = await mongoose.model('Loan').countDocuments({ company: this.company });
    this.loanNumber = `LN-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

// Virtual for remaining balance
loanSchema.virtual('remainingBalance').get(function() {
  return this.originalAmount - this.amountPaid;
});

// Virtual for next payment due (simplified)
loanSchema.virtual('nextPaymentDue').get(function() {
  if (this.status !== 'active' || !this.startDate) return null;
  // Simplified calculation - in real system would track actual schedule
  const nextDate = new Date(this.startDate);
  const monthsPaid = this.amountPaid / (this.monthlyPayment || 1);
  nextDate.setMonth(nextDate.getMonth() + Math.ceil(monthsPaid) + 1);
  return nextDate;
});

loanSchema.set('toJSON', { virtuals: true });
loanSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Loan', loanSchema);
