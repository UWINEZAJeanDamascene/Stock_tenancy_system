const mongoose = require('mongoose');

const taxPaymentSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: true
  },
  paymentDate: {
    type: Date,
    required: true
  },
  reference: {
    type: String
  },
  period: {
    month: Number,
    year: Number
  },
  method: {
    type: String,
    enum: ['bank_transfer', 'cash', 'cheque', 'mobile_money', 'other'],
    default: 'bank_transfer'
  },
  notes: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

const taxFilingSchema = new mongoose.Schema({
  filingDate: {
    type: Date,
    required: true
  },
  filingPeriod: {
    month: { type: Number, required: true },
    year: { type: Number, required: true }
  },
  taxType: {
    type: String,
    enum: ['vat', 'corporate_income', 'paye', 'withholding', 'trading_license'],
    required: true
  },
  amountDeclared: {
    type: Number,
    required: true
  },
  amountPaid: Number,
  status: {
    type: String,
    enum: ['filed', 'paid', 'overdue', 'pending'],
    default: 'pending'
  },
  dueDate: Date,
  filingReference: String,
  rraConfirmation: String,
  notes: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

const taxCalendarSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  taxType: {
    type: String,
    enum: ['vat', 'corporate_income', 'paye', 'withholding', 'trading_license'],
    required: true
  },
  dueDate: {
    type: Date,
    required: true
  },
  period: {
    month: Number,
    year: Number
  },
  description: String,
  isRecurring: {
    type: Boolean,
    default: true
  },
  recurrencePattern: {
    type: String,
    enum: ['monthly', 'quarterly', 'annually'],
    default: 'monthly'
  },
  status: {
    type: String,
    enum: ['upcoming', 'due_soon', 'overdue', 'filed', 'paid'],
    default: 'upcoming'
  },
  reminders: [{
    daysBefore: Number,
    sent: Boolean,
    sentDate: Date
  }]
}, { timestamps: true });

const taxSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  taxType: {
    type: String,
    enum: ['vat', 'corporate_income', 'paye', 'withholding', 'trading_license'],
    required: true
  },
  // VAT specific
  vatRate: {
    type: Number,
    default: 18 // Rwanda standard VAT rate
  },
  vatOutput: {
    type: Number,
    default: 0
  },
  vatInput: {
    type: Number,
    default: 0
  },
  vatNet: {
    type: Number,
    default: 0
  },
  vatPeriod: {
    month: Number,
    year: Number
  },
  // Corporate Income Tax
  corporateIncomeRate: {
    type: Number,
    default: 30 // Rwanda corporate tax rate
  },
  taxableIncome: {
    type: Number,
    default: 0
  },
  taxOwed: {
    type: Number,
    default: 0
  },
  // PAYE tracking
  payeCollected: {
    type: Number,
    default: 0
  },
  payePaid: {
    type: Number,
    default: 0
  },
  payePeriod: {
    month: Number,
    year: Number
  },
  // Withholding Tax
  withholdingCollected: {
    type: Number,
    default: 0
  },
  withholdingPaid: {
    type: Number,
    default: 0
  },
  // Trading License
  tradingLicenseFee: {
    type: Number,
    default: 0
  },
  tradingLicenseYear: {
    type: Number
  },
  tradingLicenseStatus: {
    type: String,
    enum: ['active', 'expired', 'pending', 'not_applicable'],
    default: 'not_applicable'
  },
  // Payment records
  payments: [taxPaymentSchema],
  // Filing history
  filings: [taxFilingSchema],
  // Calendar entries
  calendar: [taxCalendarSchema],
  // Status
  status: {
    type: String,
    enum: ['active', 'inactive', 'pending'],
    default: 'active'
  },
  notes: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Static methods for tax calculations
taxSchema.statics.calculateVAT = function(vatOutput, vatInput) {
  const netVAT = vatOutput - vatInput;
  return {
    vatOutput,
    vatInput,
    vatNet: netVAT,
    isPayable: netVAT > 0,
    refund: netVAT < 0 ? Math.abs(netVAT) : 0
  };
};

taxSchema.statics.calculateCorporateTax = function(taxableIncome, rate = 30) {
  const taxOwed = taxableIncome * (rate / 100);
  return {
    taxableIncome,
    rate,
    taxOwed: Math.round(taxOwed * 100) / 100
  };
};

taxSchema.statics.calculatePAYE = function(grossSalaries) {
  // PAYE is calculated on individual employees, this aggregates
  return {
    totalGrossSalaries: grossSalaries,
    payeCollected: grossSalaries // This would be calculated per employee
  };
};

taxSchema.statics.getDefaultDueDates = function(taxType) {
  const defaults = {
    vat: { day: 15, recurrence: 'monthly' },
    corporate_income: { day: 31, recurrence: 'quarterly' },
    paye: { day: 15, recurrence: 'monthly' },
    withholding: { day: 15, recurrence: 'monthly' },
    trading_license: { day: 31, recurrence: 'annually' }
  };
  return defaults[taxType] || defaults.vat;
};

taxSchema.statics.generateCalendarEntries = function(companyId, year) {
  const entries = [];
  const taxTypes = ['vat', 'paye'];
  
  taxTypes.forEach(taxType => {
    for (let month = 1; month <= 12; month++) {
      const dueDate = new Date(year, month - 1, 15); // 15th of each month
      entries.push({
        company: companyId,
        taxType,
        dueDate,
        period: { month, year },
        isRecurring: true,
        recurrencePattern: 'monthly',
        status: dueDate < new Date() ? 'overdue' : 'upcoming'
      });
    }
  });
  
  // Trading license - annually
  entries.push({
    company: companyId,
    taxType: 'trading_license',
    dueDate: new Date(year, 0, 31), // January 31st
    period: { month: 1, year },
    isRecurring: true,
    recurrencePattern: 'annually',
    status: new Date() > new Date(year, 0, 31) ? 'overdue' : 'upcoming'
  });
  
  return entries;
};

// Virtual for total tax owed
taxSchema.virtual('totalTaxOwed').get(function() {
  return (
    (this.vatNet > 0 ? this.vatNet : 0) +
    this.taxOwed +
    (this.payeCollected - this.payePaid) +
    (this.withholdingCollected - this.withholdingPaid) +
    (this.tradingLicenseStatus === 'active' ? this.tradingLicenseFee : 0)
  );
});

// Virtual for total payments
taxSchema.virtual('totalPayments').get(function() {
  return this.payments.reduce((sum, payment) => sum + payment.amount, 0);
});

module.exports = mongoose.model('Tax', taxSchema);
