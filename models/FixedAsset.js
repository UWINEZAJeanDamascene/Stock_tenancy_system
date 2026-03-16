const mongoose = require('mongoose');

const fixedAssetSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Fixed asset must belong to a company']
  },
  name: {
    type: String,
    required: [true, 'Please provide asset name'],
    trim: true
  },
  assetCode: {
    type: String,
    uppercase: true,
    trim: true
  },
  category: {
    type: String,
    enum: ['equipment', 'furniture', 'vehicles', 'buildings', 'land', 'computers', 'machinery', 'other'],
    required: true
  },
  description: {
    type: String,
    trim: true
  },
  // Purchase/acquisition details
  purchaseDate: {
    type: Date,
    required: true
  },
  purchaseCost: {
    type: Number,
    required: true,
    min: 0
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  invoiceNumber: String,
  
  // Depreciation settings
  usefulLifeYears: {
    type: Number,
    required: true,
    min: 1
  },
  depreciationMethod: {
    type: String,
    enum: ['straight-line', 'declining-balance', 'sum-of-years'],
    default: 'straight-line'
  },
  salvageValue: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Current status
  status: {
    type: String,
    enum: ['active', 'disposed', 'fully-depreciated'],
    default: 'active'
  },
  location: String,
  serialNumber: String,
  notes: String,
  
  // Payment method for asset purchase (used for journal entry)
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'cheque', 'mobile_money', 'bank'],
    default: 'bank_transfer'
  },
  bankAccountCode: {
    type: String,
    default: ''
  },
  
  // Stored accumulated depreciation (updated when depreciation journal entries are created)
  accumulatedDepreciation: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Disposal details
  disposalDate: {
    type: Date
  },
  disposalAmount: {
    type: Number,
    default: 0
  },
  disposalMethod: {
    type: String,
    enum: ['sold', 'scrapped', 'donated', 'trade-in', 'other'],
  },
  disposalNotes: String,
  
  // Maintenance tracking
  maintenanceHistory: [
    {
      date: Date,
      type: {
        type: String,
        enum: ['preventive', 'corrective', 'inspection', 'upgrade', 'other']
      },
      description: String,
      cost: Number,
      vendor: String,
      nextMaintenanceDate: Date
    }
  ],
  
  // User tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Compound index for company + unique asset code
fixedAssetSchema.index({ company: 1, assetCode: 1 }, { unique: true });
fixedAssetSchema.index({ company: 1 });

// Helper: declining-balance rate
// Rate = 1 - (Salvage / Cost) ^ (1 / UsefulLife)
// Falls back to double-declining (2/n) when salvage = 0
function _dbRate(cost, salvage, years) {
  if (salvage > 0 && cost > 0) {
    return 1 - Math.pow(salvage / cost, 1 / years);
  }
  return 2 / years;
}

// Helper: return depreciation start as UTC Date snapped to the 1st of the purchase month.
// Uses UTC getters to avoid server timezone shifting a "YYYY-MM-01" string into the previous month.
function _depreciationStartDate(purchaseDate) {
  const d = new Date(purchaseDate);
  // Use UTC fields so a date stored as "2025-01-01T00:00:00.000Z" stays January, not December
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Helper: depreciation end date (exclusive) — startDate + usefulLifeYears months, UTC
function _depreciationEndDate(startDate, usefulLifeYears) {
  return new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth() + usefulLifeYears * 12,
    1
  ));
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Helper: total days in an asset's useful life (start → end, both UTC 1st-of-month)
function _totalDays(startDate, endDate) {
  return Math.round((endDate - startDate) / MS_PER_DAY);
}

// Helper: days elapsed from startDate to refDate, clamped to [0, totalDays]
function _daysUsed(startDate, endDate, refDate) {
  const elapsed = Math.floor((refDate - startDate) / MS_PER_DAY);
  return Math.max(0, Math.min(elapsed, _totalDays(startDate, endDate)));
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCUMULATED DEPRECIATION (Balance Sheet)
//
// The stored accumulatedDepreciation field holds the value that has been
// posted via journal entries from "Run Depreciation". This is the source of
// truth for the balance sheet.
// ─────────────────────────────────────────────────────────────────────────────

// Virtual: calculated accumulated depreciation for reference (from purchase date to now)
fixedAssetSchema.virtual('calculatedAccumulatedDepreciation').get(function() {
  if (!this.purchaseDate || !this.purchaseCost) return 0;

  const now        = new Date();
  const startDate  = _depreciationStartDate(this.purchaseDate);
  const endDate    = _depreciationEndDate(startDate, this.usefulLifeYears);
  const totalDays  = _totalDays(startDate, endDate);

  if (totalDays <= 0) return 0;

  const daysUsed   = _daysUsed(startDate, endDate, now);
  if (daysUsed <= 0) return 0;

  const depreciable = this.purchaseCost - (this.salvageValue || 0);
  if (depreciable <= 0) return 0;

  const daysPerYear = totalDays / this.usefulLifeYears;

  switch (this.depreciationMethod) {
    case 'straight-line': {
      // Constant daily rate → linear accumulation
      return Math.min((depreciable / totalDays) * daysUsed, depreciable);
    }

    case 'sum-of-years': {
      const syd = (this.usefulLifeYears * (this.usefulLifeYears + 1)) / 2;
      const fullYears    = Math.floor(daysUsed / daysPerYear);
      const remainDays   = daysUsed - fullYears * daysPerYear;
      let accumulated    = 0;
      for (let i = 0; i < fullYears && i < this.usefulLifeYears; i++) {
        accumulated += (depreciable * (this.usefulLifeYears - i)) / syd;
      }
      if (remainDays > 0 && fullYears < this.usefulLifeYears) {
        const yearlyDep = (depreciable * (this.usefulLifeYears - fullYears)) / syd;
        accumulated += (yearlyDep / daysPerYear) * remainDays;
      }
      return Math.min(accumulated, depreciable);
    }

    case 'declining-balance': {
      const rate      = _dbRate(this.purchaseCost, this.salvageValue || 0, this.usefulLifeYears);
      const fullYears = Math.floor(daysUsed / daysPerYear);
      const remainDays = daysUsed - fullYears * daysPerYear;
      let accumulated  = 0;
      let bookValue    = this.purchaseCost;
      for (let i = 0; i < fullYears && bookValue > (this.salvageValue || 0); i++) {
        const dep = Math.min(bookValue * rate, Math.max(0, bookValue - (this.salvageValue || 0)));
        accumulated += dep;
        bookValue   -= dep;
      }
      if (remainDays > 0 && bookValue > (this.salvageValue || 0)) {
        const yearlyDep = Math.min(bookValue * rate, Math.max(0, bookValue - (this.salvageValue || 0)));
        accumulated += (yearlyDep / daysPerYear) * remainDays;
      }
      return Math.min(accumulated, depreciable);
    }

    default:
      return Math.min((depreciable / totalDays) * daysUsed, depreciable);
  }
});

// Virtual: Net Book Value = Cost − Accumulated Depreciation (Balance Sheet)
fixedAssetSchema.virtual('netBookValue').get(function() {
  return Math.max(0, this.purchaseCost - (this.accumulatedDepreciation || 0));
});

// Virtual: depreciation start date exposed to the API (always 1st of purchase month, UTC)
fixedAssetSchema.virtual('depreciationStartDate').get(function() {
  if (!this.purchaseDate) return null;
  return _depreciationStartDate(this.purchaseDate);
});

// Virtual: depreciation end date exposed to the API
fixedAssetSchema.virtual('depreciationEndDate').get(function() {
  if (!this.purchaseDate) return null;
  const start = _depreciationStartDate(this.purchaseDate);
  return _depreciationEndDate(start, this.usefulLifeYears);
});

// ─────────────────────────────────────────────────────────────────────────────
// ANNUAL DEPRECIATION (P&L)
//
// Returns the FULL annual depreciation amount for the CURRENT depreciation year.
// P&L uses: (annualDepreciation / 12) × periodMonths = period expense.
// For straight-line this is the same every year.
// Kicks in on the 1st of each calendar month (monthly boundary = accounting rule).
// ─────────────────────────────────────────────────────────────────────────────
fixedAssetSchema.virtual('annualDepreciation').get(function() {
  if (!this.purchaseDate || !this.purchaseCost || !this.usefulLifeYears) return 0;

  const now         = new Date();
  const startDate   = _depreciationStartDate(this.purchaseDate);
  const totalMonths = this.usefulLifeYears * 12;

  // Count complete months elapsed (UTC) so month boundary is consistent
  const monthsElapsed =
    (now.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    (now.getUTCMonth()   - startDate.getUTCMonth());

  if (monthsElapsed <= 0) return 0;           // hasn't started yet
  if (monthsElapsed >= totalMonths) return 0; // fully depreciated

  const currentYearIdx  = Math.floor(monthsElapsed / 12); // 0-indexed year in asset life
  const depreciable     = this.purchaseCost - (this.salvageValue || 0);

  switch (this.depreciationMethod) {
    case 'straight-line':
      return depreciable / this.usefulLifeYears;

    case 'sum-of-years': {
      const syd = (this.usefulLifeYears * (this.usefulLifeYears + 1)) / 2;
      const remainingLife = this.usefulLifeYears - currentYearIdx;
      return (depreciable * remainingLife) / syd;
    }

    case 'declining-balance': {
      const rate = _dbRate(this.purchaseCost, this.salvageValue || 0, this.usefulLifeYears);
      let bookValue = this.purchaseCost;
      for (let i = 0; i < currentYearIdx; i++) {
        const dep = Math.min(bookValue * rate, Math.max(0, bookValue - (this.salvageValue || 0)));
        bookValue -= dep;
      }
      return Math.min(bookValue * rate, Math.max(0, bookValue - (this.salvageValue || 0)));
    }

    default:
      return depreciable / this.usefulLifeYears;
  }
});

fixedAssetSchema.set('toJSON', { virtuals: true });
fixedAssetSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('FixedAsset', fixedAssetSchema);
