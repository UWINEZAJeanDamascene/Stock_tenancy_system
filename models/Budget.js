const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

const budgetItemSchema = new mongoose.Schema({
  category: {
    type: String,
    default: 'other'
  },
  subcategory: {
    type: String,
    default: ''
  },
  description: {
    type: String,
    default: ''
  },
  budgetedAmount: {
    type: Number,
    required: true,
    default: 0
  },
  actualAmount: {
    type: Number,
    default: 0
  },
  variance: {
    type: Number,
    default: 0
  },
  variancePercent: {
    type: Number,
    default: 0
  }
}, { _id: true });

const budgetSchema = new mongoose.Schema({
  // Budget identification
  budgetId: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  
  // Company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  
  // Budget type
  type: {
    type: String,
    enum: ['revenue', 'expense', 'profit'],
    required: true
  },
  
  // Status
  status: {
    type: String,
    enum: ['draft', 'active', 'closed', 'cancelled'],
    default: 'draft'
  },
  
  // Period
  periodStart: {
    type: Date,
    required: true
  },
  periodEnd: {
    type: Date,
    required: true
  },
  periodType: {
    type: String,
    enum: ['monthly', 'quarterly', 'yearly', 'custom'],
    default: 'monthly'
  },
  
  // Budget amounts
  amount: {
    type: Number,
    required: true,
    default: 0
  },
  originalAmount: {
    type: Number,
    default: 0
  },
  adjustedAmount: {
    type: Number,
    default: 0
  },
  
  // Category breakdown (detailed budget items)
  items: [budgetItemSchema],
  
  // Department/Department reference
  department: {
    type: String,
    default: ''
  },
  
  // Notes
  notes: {
    type: String,
    default: ''
  },
  
  // Approval workflow
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: {
    type: Date
  },
  approvalStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  rejectionReason: {
    type: String,
    default: ''
  },
  
  // Tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Version control
  version: {
    type: Number,
    default: 1
  },
  previousVersion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Budget'
  }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for calculating actual totals from items
budgetSchema.virtual('calculatedTotal').get(function() {
  if (this.items && this.items.length > 0) {
    return this.items.reduce((sum, item) => sum + item.budgetedAmount, 0);
  }
  return this.amount;
});

// Index for efficient queries
budgetSchema.index({ company: 1, status: 1 });
budgetSchema.index({ company: 1, periodStart: 1, periodEnd: 1 });
budgetSchema.index({ budgetId: 1 });
budgetSchema.index({ createdBy: 1 });

// Pre-save middleware to set originalAmount
budgetSchema.pre('save', function(next) {
  if (this.isNew && this.originalAmount === 0) {
    this.originalAmount = this.amount;
  }
  next();
});

// Static method to generate unique budget ID
budgetSchema.statics.generateBudgetId = async function(companyId) {
  const company = await mongoose.model('Company').findById(companyId);
  const companyPrefix = company?.code?.substring(0, 3).toUpperCase() || 'BUD';
  
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  
  // Find the latest budget ID for this company/year
  const latestBudget = await this.findOne({
    company: companyId,
    budgetId: new RegExp(`^${companyPrefix}-${year}${month}`)
  }).sort({ budgetId: -1 });
  
  let sequence = 1;
  if (latestBudget) {
    const lastSequence = parseInt(latestBudget.budgetId.split('-').pop() || '0', 10);
    sequence = lastSequence + 1;
  }
  
  const sequenceStr = String(sequence).padStart(4, '0');
  return `${companyPrefix}-${year}${month}-${sequenceStr}`;
};

// Method to calculate actual amounts from transactions
budgetSchema.methods.calculateActuals = async function() {
  const Invoice = mongoose.model('Invoice');
  const Purchase = mongoose.model('Purchase');
  
  const start = this.periodStart;
  const end = this.periodEnd;
  
  let actualAmount = 0;
  
  if (this.type === 'revenue') {
    // Get actual revenue from paid invoices
    const invoices = await Invoice.aggregate([
      {
        $match: {
          company: this.company,
          status: 'paid',
          paidDate: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$grandTotal' }
        }
      }
    ]);
    actualAmount = invoices[0]?.total || 0;
  } else if (this.type === 'expense') {
    // Get actual expenses from paid purchases
    const purchases = await Purchase.aggregate([
      {
        $match: {
          company: this.company,
          status: 'paid',
          paidDate: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$grandTotal' }
        }
      }
    ]);
    actualAmount = purchases[0]?.total || 0;
  }
  
  // Calculate variance
  const variance = this.amount - actualAmount;
  const variancePercent = this.amount > 0 ? (variance / this.amount) * 100 : 0;
  
  return {
    actualAmount,
    variance,
    variancePercent
  };
};

budgetSchema.plugin(mongoosePaginate);

module.exports = mongoose.model('Budget', budgetSchema);
