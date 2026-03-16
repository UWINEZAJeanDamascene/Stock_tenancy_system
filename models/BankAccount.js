const mongoose = require('mongoose');

// Bank Account Transaction Schema (for tracking all movements)
const bankTransactionSchema = new mongoose.Schema({
  // Bank account reference (required to link transaction to specific account)
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BankAccount',
    required: [true, 'Transaction must be linked to a bank account']
  },
  // Transaction type
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'transfer_in', 'transfer_out', 'adjustment', 'opening', 'closing'],
    required: true
  },
  // Amount
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  // Balance after transaction
  balanceAfter: {
    type: Number,
    required: true
  },
  // Reference to related document
  reference: {
    type: mongoose.Schema.Types.ObjectId
  },
  referenceType: {
    type: String,
    enum: ['Invoice', 'Expense', 'Purchase', 'PettyCashFloat', 'PettyCashExpense', 'PettyCashReplenishment', 'Loan', 'Payment', null],
    default: null
  },
  // Description
  description: {
    type: String,
    trim: true
  },
  // Date
  date: {
    type: Date,
    default: Date.now
  },
  // Payment method (for incoming payments)
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'cheque', 'mobile_money', 'card', 'other'],
    default: 'bank_transfer'
  },
  // Reference/cheque number
  referenceNumber: String,
  // Status
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'reversed'],
    default: 'completed'
  },
  // Created by
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Notes
  notes: String,
  // Attachments
  attachments: [{
    name: String,
    url: String
  }]
}, {
  timestamps: true
});

// Bank Account Schema
const bankAccountSchema = new mongoose.Schema({
  // Company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Bank account must belong to a company']
  },
  // Account name
  name: {
    type: String,
    required: [true, 'Please provide an account name'],
    trim: true
  },
  // Account type
  accountType: {
    type: String,
    enum: ['bk_bank', 'equity_bank', 'im_bank', 'cogebanque', 'ecobank', 'mtn_momo', 'airtel_money', 'cash_in_hand'],
    required: [true, 'Please specify account type']
  },
  // Account code from chart of accounts (for journal entries)
  accountCode: {
    type: String,
    default: '1100'
  },
  // Account number / Phone number
  accountNumber: {
    type: String,
    trim: true
  },
  // Bank name (for bank accounts)
  bankName: {
    type: String,
    trim: true
  },
  // Branch (for bank accounts)
  branch: {
    type: String,
    trim: true
  },
  // SWIFT/IBAN code
  swiftCode: String,
  // Opening balance
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
  // Minimum/Target balance
  targetBalance: {
    type: Number,
    default: 0
  },
  // Currency
  currency: {
    type: String,
    default: 'FRW'
  },
  // Is this the primary account
  isPrimary: {
    type: Boolean,
    default: false
  },
  // Is active
  isActive: {
    type: Boolean,
    default: true
  },
  // Account holder name (for mobile money)
  holderName: String,
  // Status for reconciliation
  lastReconciledAt: Date,
  lastReconciledBalance: Number,
  // Notes
  notes: String,
  // Color for UI identification
  color: {
    type: String,
    default: '#3B82F6' // Default blue
  },
  // Icon for UI
  icon: {
    type: String,
    default: 'bank'
  },
  // Created by (who created this account)
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Index for efficient queries
bankAccountSchema.index({ company: 1, isActive: 1 });
bankAccountSchema.index({ company: 1, accountType: 1 });
bankTransactionSchema.index({ company: 1, account: 1, date: -1 });
bankTransactionSchema.index({ company: 1, reference: 1 });

// Pre-save middleware to set initial balance
bankAccountSchema.pre('save', async function(next) {
  if (this.isNew) {
    this.currentBalance = this.openingBalance;
    
    // Auto-set account code based on account type if not provided
    if (!this.accountCode) {
      const typeToCode = {
        'bk_bank': '1100',
        'equity_bank': '1100',
        'im_bank': '1100',
        'cogebanque': '1100',
        'ecobank': '1100',
        'mtn_momo': '1200',
        'airtel_money': '1200',
        'cash_in_hand': '1000'
      };
      this.accountCode = typeToCode[this.accountType] || '1100';
    }
  }
  
  // Ensure only one primary account per company
  if (this.isPrimary && this.isModified('isPrimary')) {
    await this.constructor.updateMany(
      { company: this.company, _id: { $ne: this._id } },
      { isPrimary: false }
    );
  }
  
  next();
});

// Static method to get total cash position
bankAccountSchema.statics.getTotalCashPosition = async function(companyId) {
  const accounts = await this.find({ company: companyId, isActive: true });
  
  const result = {
    total: 0,
    byType: {
      bk_bank: 0,
      equity_bank: 0,
      im_bank: 0,
      cogebanque: 0,
      ecobank: 0,
      mtn_momo: 0,
      airtel_money: 0,
      cash_in_hand: 0
    },
    accounts: []
  };
  
  accounts.forEach(account => {
    result.total += account.currentBalance || 0;
    result.byType[account.accountType] += account.currentBalance || 0;
    result.accounts.push({
      _id: account._id,
      name: account.name,
      accountType: account.accountType,
      currentBalance: account.currentBalance
    });
  });
  
  return result;
};

// Static method to get account by type
bankAccountSchema.statics.getByType = async function(companyId, accountType) {
  return this.find({ company: companyId, accountType, isActive: true });
};

// Method to add transaction and update balance
bankAccountSchema.methods.addTransaction = async function(transactionData) {
  const BankTransaction = mongoose.model('BankTransaction');
  
  const transaction = new BankTransaction({
    ...transactionData,
    account: this._id,
    company: this.company,
    balanceAfter: this.currentBalance
  });
  
  await transaction.save();
  
  // Update balance based on transaction type
  if (transaction.type === 'deposit' || transaction.type === 'transfer_in' || transaction.type === 'opening') {
    this.currentBalance += transaction.amount;
  } else if (transaction.type === 'withdrawal' || transaction.type === 'transfer_out' || transaction.type === 'closing') {
    this.currentBalance -= transaction.amount;
  } else if (transaction.type === 'adjustment') {
    this.currentBalance = transaction.balanceAfter;
  }
  
  await this.save();
  
  return transaction;
};

// Create models
const BankAccount = mongoose.model('BankAccount', bankAccountSchema);
const BankTransaction = mongoose.model('BankTransaction', bankTransactionSchema);

// Export all models
module.exports = {
  BankAccount,
  BankTransaction
};
