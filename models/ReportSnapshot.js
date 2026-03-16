const mongoose = require('mongoose');

const reportSnapshotSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  // Report type: profit-loss, balance-sheet, vat-summary, cash-flow, etc.
  reportType: {
    type: String,
    required: true,
    enum: [
      // Financial Reports
      'profit-loss',
      'balance-sheet',
      'vat-summary',
      'cash-flow',
      'financial-ratios',
      'product-performance',
      'customer-summary',
      'supplier-summary',
      'stock-valuation',
      // Aging Reports
      'aging-receivables',
      'aging-payables',
      'invoice-aging',
      'supplier-aging',
      // Sales Reports
      'sales-summary',
      'sales-by-product',
      'sales-by-category',
      'sales-by-client',
      'sales-by-salesperson',
      'top-clients',
      'top-products',
      'top-customers',
      'top-suppliers',
      'daily-sales-summary',
      // Purchase Reports
      'purchases',
      'purchase-by-product',
      'purchase-by-category',
      'purchase-by-supplier',
      'purchase-returns',
      'purchase-order-status',
      'supplier-performance',
      // Client/Supplier Reports
      'client-statement',
      'supplier-statement',
      'new-clients',
      'inactive-clients',
      'credit-limit',
      // Accounts Reports
      'accounts-receivable',
      'accounts-payable',
      // Tax Reports
      'vat-return',
      'paye-report',
      'withholding-tax',
      'corporate-tax',
      'tax-payment-history',
      'tax-calendar',
      // Expense Reports
      'expense-by-category',
      'expense-by-period',
      'expense-vs-budget',
      'employee-expense',
      'petty-cash',
      // Asset Reports
      'asset-register',
      'depreciation-schedule',
      'asset-disposal',
      'asset-maintenance',
      'net-book-value',
      // Stock Reports
      'stock-movement',
      'low-stock',
      'dead-stock',
      'stock-aging',
      'inventory-turnover',
      'batch-expiry',
      'serial-number-tracking',
      'warehouse-stock',
      // Bank Reports
      'bank-reconciliation',
      'cash-position',
      'bank-transaction',
      'unreconciled-transactions',
      // Other Reports
      'credit-notes',
      'quotation-conversion',
      'recurring-invoice',
      'discount-report',
      'full-summary'
    ],
    index: true
  },
  // Period type: daily, weekly, monthly, quarterly, semi-annual, annual
  periodType: {
    type: String,
    required: true,
    enum: ['daily', 'weekly', 'monthly', 'quarterly', 'semi-annual', 'annual'],
    index: true
  },
  // Period start and end dates
  periodStart: {
    type: Date,
    required: true,
    index: true
  },
  periodEnd: {
    type: Date,
    required: true
  },
  // Formatted period name for display (e.g., "March 2026", "Q1 2026", "H1 2026")
  periodLabel: {
    type: String,
    required: true
  },
  // Year and period number for easy querying
  year: {
    type: Number,
    required: true,
    index: true
  },
  periodNumber: {
    type: Number, // 1-52 for weekly, 1-12 for monthly, 1-4 for quarterly, 1-2 for semi-annual
    required: true
  },
  // The actual report data (P&L, Balance Sheet, etc.)
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  // Summary metrics for quick display
  summary: {
    revenue: Number,
    cogs: Number,
    grossProfit: Number,
    netProfit: Number,
    totalAssets: Number,
    totalLiabilities: Number,
    totalEquity: Number,
    vatCollected: Number,
    vatPaid: Number,
    netVat: Number
  },
  // Top items for quick display
  topProducts: [{
    productId: mongoose.Schema.Types.ObjectId,
    productName: String,
    revenue: Number,
    quantity: Number,
    profit: Number
  }],
  topCustomers: [{
    customerId: mongoose.Schema.Types.ObjectId,
    customerName: String,
    revenue: Number,
    orders: Number
  }],
  // Comparison with previous period
  comparison: {
    previousSnapshotId: mongoose.Schema.Types.ObjectId,
    previousSnapshot: mongoose.Schema.Types.Mixed,
    revenueChangePercent: Number,
    profitChangePercent: Number,
    revenueChange: Number,
    profitChange: Number
  },
  // Snapshot metadata
  generatedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  generatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // Source of calculation: 'live' (calculated on-the-fly) or 'snapshot' (pre-calculated)
  calculationSource: {
    type: String,
    enum: ['live', 'snapshot'],
    default: 'snapshot'
  },
  // Status: completed, failed, in-progress
  status: {
    type: String,
    enum: ['completed', 'failed', 'in-progress'],
    default: 'completed'
  },
  // Error message if generation failed
  errorMessage: String,
  // Version for tracking changes in report structure
  version: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Compound index for efficient querying
reportSnapshotSchema.index({ company: 1, periodType: 1, year: 1, periodNumber: 1 }, { unique: true });
reportSnapshotSchema.index({ company: 1, periodType: 1, periodStart: -1 });
reportSnapshotSchema.index({ generatedAt: 1 }, { expireAfterSeconds: 31536000 }); // Auto-expire after 1 year (configurable)

// Virtual for checking if this is the latest snapshot
reportSnapshotSchema.virtual('isLatest').get(function() {
  return true; // This would be computed at query time
});

// Static method to get snapshot for a given period
reportSnapshotSchema.statics.getSnapshot = async function(companyId, periodType, year, periodNumber) {
  return this.findOne({
    company: companyId,
    periodType,
    year,
    periodNumber,
    status: 'completed'
  }).sort({ generatedAt: -1 });
};

// Static method to get available periods
reportSnapshotSchema.statics.getAvailablePeriods = async function(companyId, periodType, limit = 24) {
  return this.find({
    company: companyId,
    periodType,
    status: 'completed'
  })
  .sort({ year: -1, periodNumber: -1 })
  .limit(limit)
  .select('periodLabel year periodNumber periodStart periodEnd generatedAt summary');
};

// Static method to clean old snapshots (keep only what we need)
reportSnapshotSchema.statics.cleanOldSnapshots = async function(companyId) {
  const retentionRules = {
    daily: 7,      // Keep 7 days
    weekly: 52,    // Keep 52 weeks (1 year)
    monthly: 24,   // Keep 24 months (2 years)
    quarterly: 8,  // Keep 8 quarters (2 years)
    'semi-annual': 4, // Keep 4 periods (2 years)
    annual: 999    // Keep all years
  };

  for (const [period, retention] of Object.entries(retentionRules)) {
    const cutoffDate = new Date();
    if (period === 'daily') {
      cutoffDate.setDate(cutoffDate.getDate() - retention);
    } else if (period === 'weekly') {
      cutoffDate.setDate(cutoffDate.getDate() - (retention * 7));
    } else if (period === 'monthly') {
      cutoffDate.setMonth(cutoffDate.getMonth() - retention);
    } else if (period === 'quarterly') {
      cutoffDate.setMonth(cutoffDate.getMonth() - (retention * 3));
    } else if (period === 'semi-annual') {
      cutoffDate.setMonth(cutoffDate.getMonth() - (retention * 6));
    } else {
      continue; // Don't delete annual reports
    }

    await this.deleteMany({
      company: companyId,
      periodType: period,
      generatedAt: { $lt: cutoffDate }
    });
  }
};

module.exports = mongoose.model('ReportSnapshot', reportSnapshotSchema);
