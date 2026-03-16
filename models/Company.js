const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide a company name'],
    trim: true
  },
  tin: {
    type: String,
    trim: true,
    // TIN = Tax Identification Number
  },
  email: {
    type: String,
    required: [true, 'Please provide a company email'],
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
  },
  phone: {
    type: String,
    trim: true
  },
  address: {
    street: String,
    city: String,
    state: String,
    country: String,
    postalCode: String
  },
  logo: {
    type: String
  },
  // Company settings
  settings: {
    currency: {
      type: String,
      default: 'FRW'
    },
    taxRate: {
      type: Number,
      default: 18
    },
    lowStockThreshold: {
      type: Number,
      default: 10
    },
    dateFormat: {
      type: String,
      default: 'YYYY-MM-DD'
    }
  },
  // Equity settings for Balance Sheet
  equity: {
    shareCapital: {
      type: Number,
      default: 0,
      min: 0
    },
    ownerCapital: {
      type: Number,
      default: 0,
      min: 0
    },
    retainedEarnings: {
      type: Number,
      default: 0
    },
    // Track accumulated profit/loss from previous periods
    accumulatedProfit: {
      type: Number,
      default: 0
    },
    // Last year closing date for retained earnings calculation
    lastClosingDate: {
      type: Date
    }
  },
  // Additional assets for Balance Sheet (manual entries)
  assets: {
    // Current assets - prepaid expenses
    prepaidExpenses: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  // Additional liabilities for Balance Sheet (dynamic fields)
  liabilities: {
    // Current liabilities (due within 12 months)
    currentLiabilities: [{
      name: {
        type: String,
        required: true
      },
      amount: {
        type: Number,
        default: 0,
        min: 0
      },
      description: String,
      createdAt: {
        type: Date,
        default: Date.now
      }
    }],
    // Non-current liabilities (due after 12 months)
    nonCurrentLiabilities: [{
      name: {
        type: String,
        required: true
      },
      amount: {
        type: Number,
        default: 0,
        min: 0
      },
      description: String,
      dueDate: Date,
      createdAt: {
        type: Date,
        default: Date.now
      }
    }],
    // Accrued Expenses (current liability) - manual entry
    accruedExpenses: {
      type: Number,
      default: 0,
      min: 0
    },
    // Other Long-term Liabilities - manual entry
    otherLongTermLiabilities: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  // Subscription status
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'basic', 'professional', 'enterprise'],
      default: 'free'
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'cancelled'],
      default: 'active'
    },
    startDate: {
      type: Date
    },
    endDate: {
      type: Date
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Approval workflow
  approvalStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: {
    type: Date
  },
  rejectionReason: {
    type: String
  }
}, {
  timestamps: true
});

// Index for company lookup
companySchema.index({ email: 1 });
companySchema.index({ tin: 1 });

module.exports = mongoose.model('Company', companySchema);
