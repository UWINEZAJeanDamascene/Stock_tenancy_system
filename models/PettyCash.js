const mongoose = require('mongoose');

// Petty Cash Expense Schema (individual expense entries)
const pettyCashExpenseSchema = new mongoose.Schema({
  // Company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  // Float reference
  float: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PettyCashFloat',
    required: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  category: {
    type: String,
    enum: [
      'transport',
      'office_supplies',
      'meals',
      'communications',
      'utilities',
      'maintenance',
      'miscellaneous',
      'postage',
      'stationery',
      'refreshments',
      'medical',
      'other'
    ],
    default: 'miscellaneous'
  },
  date: {
    type: Date,
    default: Date.now
  },
  receiptNumber: String,
  receiptImage: {
    name: String,
    url: String
  },
  notes: String,
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'reimbursed'],
    default: 'pending'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: Date
}, {
  timestamps: true
});

// Petty Cash Float/Balance Schema
const pettyCashFloatSchema = new mongoose.Schema({
  // Company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Petty cash must belong to a company']
  },
  // Float name (e.g., "Main Office", "Branch 1")
  name: {
    type: String,
    trim: true,
    default: 'Main Petty Cash'
  },
  // Opening/float balance
  openingBalance: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  // Current balance (calculated)
  currentBalance: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  // Minimum threshold for replenishment
  minimumBalance: {
    type: Number,
    default: 10000
  },
  // Responsible person
  custodian: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Location/description
  location: String,
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  // Notes
  notes: String
}, {
  timestamps: true
});

// Index for efficient queries
pettyCashFloatSchema.index({ company: 1, isActive: 1 });
pettyCashExpenseSchema.index({ company: 1, float: 1, date: -1 });
pettyCashExpenseSchema.index({ company: 1, status: 1 });

// Pre-save middleware to calculate current balance
pettyCashFloatSchema.pre('save', async function(next) {
  if (this.isNew) {
    this.currentBalance = this.openingBalance;
  }
  next();
});

// Static method to get current balance for a float
pettyCashFloatSchema.statics.getCurrentBalance = async function(floatId) {
  const pettyCashFloat = await this.findById(floatId);
  if (!pettyCashFloat) return 0;
  
  // Get all approved expenses for this float
  const PettyCashExpense = mongoose.model('PettyCashExpense');
  const expenses = await PettyCashExpense.find({ 
    float: floatId, 
    status: { $in: ['approved', 'reimbursed'] } 
  });
  
  const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
  
  // Calculate: Current Balance = Opening Balance - Total Expenses + Replenishments
  const PettyCashReplenishment = mongoose.model('PettyCashReplenishment');
  const replenishments = await PettyCashReplenishment.find({ 
    float: floatId, 
    status: 'completed' 
  });
  
  const totalReplenishments = replenishments.reduce((sum, rep) => sum + (rep.amount || 0), 0);
  
  return pettyCashFloat.openingBalance - totalExpenses + totalReplenishments;
};

// Petty Cash Replenishment Request Schema
const pettyCashReplenishmentSchema = new mongoose.Schema({
  // Company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  // Float reference
  float: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PettyCashFloat',
    required: true
  },
  // Replenishment amount requested
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  // Amount actually provided
  actualAmount: {
    type: Number,
    min: 0
  },
  // Reason for replenishment
  reason: {
    type: String,
    trim: true
  },
  // Supporting documents
  receipts: [{
    name: String,
    url: String
  }],
  // Status
  status: {
    type: String,
    enum: ['pending', 'approved', 'completed', 'rejected', 'cancelled'],
    default: 'pending'
  },
  // Requested by
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Approved by
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: Date,
  // Completed by (who provided the cash)
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  completedAt: Date,
  // Notes
  notes: String,
  // Reference number
  replenishmentNumber: String
}, {
  timestamps: true
});

// Auto-generate replenishment number
pettyCashReplenishmentSchema.pre('save', async function(next) {
  if (this.isNew && !this.replenishmentNumber) {
    const count = await mongoose.model('PettyCashReplenishment').countDocuments({ company: this.company });
    this.replenishmentNumber = `REPL-${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

// Main Petty Cash Transaction Schema (tracks all activities)
const pettyCashTransactionSchema = new mongoose.Schema({
  // Company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  // Float reference
  float: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PettyCashFloat',
    required: true
  },
  // Transaction type
  type: {
    type: String,
    enum: ['opening', 'expense', 'replenishment', 'adjustment', 'closing'],
    required: true
  },
  // Reference to related document
  reference: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'referenceType'
  },
  referenceType: {
    type: String,
    enum: ['PettyCashExpense', 'PettyCashReplenishment', null],
    default: null
  },
  // Amount
  amount: {
    type: Number,
    required: true
  },
  // Balance after transaction
  balanceAfter: {
    type: Number,
    required: true
  },
  // Description
  description: String,
  // Date
  date: {
    type: Date,
    default: Date.now
  },
  // User who created the transaction
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Notes
  notes: String
}, {
  timestamps: true
});

// Index for efficient queries
pettyCashTransactionSchema.index({ company: 1, float: 1, date: -1 });

// Create models
const PettyCashFloat = mongoose.model('PettyCashFloat', pettyCashFloatSchema);
const PettyCashExpense = mongoose.model('PettyCashExpense', pettyCashExpenseSchema);
const PettyCashReplenishment = mongoose.model('PettyCashReplenishment', pettyCashReplenishmentSchema);
const PettyCashTransaction = mongoose.model('PettyCashTransaction', pettyCashTransactionSchema);

// Export all models
module.exports = {
  PettyCashFloat,
  PettyCashExpense,
  PettyCashReplenishment,
  PettyCashTransaction
};
