const mongoose = require('mongoose');

const expenseItemSchema = new mongoose.Schema({
  description: {
    type: String,
    trim: true,
    default: ''
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  date: {
    type: Date,
    default: Date.now
  },
  reference: String,
  notes: String
});

const expenseSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Expense must belong to a company']
  },

  // Expense type/category
  type: {
    type: String,
    enum: [
      'salaries_wages',
      'rent',
      'utilities',
      'transport_delivery',
      'marketing_advertising',
      'other_expense',
      'interest_income',
      'other_income',
      'other_expense_income' // For other expenses in income statement
    ],
    required: true
  },

  // For backward compatibility - category name
  category: {
    type: String,
    default: function() {
      return this.type;
    }
  },

  // Reference number
  expenseNumber: {
    type: String,
    uppercase: true
  },

  // Description
  description: {
    type: String,
    trim: true
  },

  // Amount
  amount: {
    type: Number,
    required: true,
    min: 0
  },

  // Date
  expenseDate: {
    type: Date,
    default: Date.now
  },

  // Period for reporting (monthly)
  period: {
    type: String, // Format: YYYY-MM
    index: true
  },

  // Status
  status: {
    type: String,
    enum: ['draft', 'recorded', 'approved', 'cancelled'],
    default: 'recorded'
  },

  // Payment info
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'cheque', 'mobile_money', 'credit'],
    default: 'cash'
  },
  paid: {
    type: Boolean,
    default: false
  },
  paidDate: Date,

  // Recurring
  isRecurring: {
    type: Boolean,
    default: false
  },
  recurringFrequency: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'],
    default: 'monthly'
  },

  // User tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Notes
  notes: String,

  // Attachments/references
  attachments: [{
    name: String,
    url: String
  }]
}, {
  timestamps: true
});

// Index for efficient queries
expenseSchema.index({ company: 1, type: 1 });
expenseSchema.index({ company: 1, expenseDate: 1 });
expenseSchema.index({ company: 1, period: 1 });
expenseSchema.index({ company: 1, status: 1 });

// Auto-generate expense number
expenseSchema.pre('save', async function(next) {
  if (this.isNew && !this.expenseNumber) {
    const count = await mongoose.model('Expense').countDocuments({ company: this.company });
    this.expenseNumber = `EXP-${String(count + 1).padStart(5, '0')}`;
  }
  
  // Set period from expenseDate
  if (this.expenseDate) {
    const year = this.expenseDate.getFullYear();
    const month = String(this.expenseDate.getMonth() + 1).padStart(2, '0');
    this.period = `${year}-${month}`;
  }
  
  next();
});

// Static method to get expenses by type for a period
expenseSchema.statics.getByTypeAndPeriod = async function(companyId, type, startDate, endDate) {
  const match = {
    company: companyId,
    type: type,
    status: { $ne: 'cancelled' }
  };
  
  if (startDate || endDate) {
    match.expenseDate = {};
    if (startDate) match.expenseDate.$gte = startDate;
    if (endDate) match.expenseDate.$lte = endDate;
  }
  
  const expenses = await this.find(match);
  const total = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
  
  return { expenses, total };
};

// Static method to get all operating expenses for a period
expenseSchema.statics.getOperatingExpenses = async function(companyId, startDate, endDate) {
  const operatingTypes = [
    'salaries_wages',
    'rent',
    'utilities',
    'transport_delivery',
    'marketing_advertising',
    'other_expense'
  ];
  
  const result = {};
  let totalOperatingExpenses = 0;
  
  for (const type of operatingTypes) {
    const { total } = await this.getByTypeAndPeriod(companyId, type, startDate, endDate);
    const key = type.replace(/_([a-z])/g, (m, p1) => p1.toUpperCase());
    result[key] = total;
    totalOperatingExpenses += total;
  }
  
  return { ...result, total: totalOperatingExpenses };
};

// Static method to get other income/expenses for a period
expenseSchema.statics.getOtherIncomeExpenses = async function(companyId, startDate, endDate) {
  const result = {
    interestIncome: 0,
    otherIncome: 0,
    otherExpense: 0,
    netOtherIncome: 0
  };
  
  // Interest Income
  const interestIncomeData = await this.getByTypeAndPeriod(companyId, 'interest_income', startDate, endDate);
  result.interestIncome = interestIncomeData.total;
  
  // Other Income
  const otherIncomeData = await this.getByTypeAndPeriod(companyId, 'other_income', startDate, endDate);
  result.otherIncome = otherIncomeData.total;
  
  // Other Expense (from income statement perspective)
  const otherExpenseData = await this.getByTypeAndPeriod(companyId, 'other_expense_income', startDate, endDate);
  result.otherExpense = otherExpenseData.total;
  
  // Net Other Income = Interest Income + Other Income - Other Expense
  result.netOtherIncome = result.interestIncome + result.otherIncome - result.otherExpense;
  
  return result;
};

module.exports = mongoose.model('Expense', expenseSchema);
