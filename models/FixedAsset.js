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
  
  // Payment method for asset purchase
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'cheque', 'mobile_money'],
    default: 'cash'
  },
  
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
  
  // Depreciation tracking - stores journal entry IDs for monthly depreciation
  depreciationEntries: [
    {
      journalEntryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'JournalEntry'
      },
      period: String, // Format: YYYY-MM
      amount: Number,
      date: Date
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

// Helper: months elapsed from startDate to refDate, clamped to [0, totalMonths]
// Includes current month if we're in the same month as the purchase (depreciation starts immediately)
function _monthsUsed(startDate, endDate, refDate) {
  let monthsElapsed =
    (refDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    (refDate.getUTCMonth() - startDate.getUTCMonth());
  
  // If we're in the same month as purchase, count it as month 1 (depreciation starts immediately)
  if (refDate.getUTCFullYear() === startDate.getUTCFullYear() && 
      refDate.getUTCMonth() === startDate.getUTCMonth()) {
    monthsElapsed = 1;
  } else if (monthsElapsed > 0) {
    // Add 1 to include the starting month
    monthsElapsed += 1;
  }
  
  const totalMonths = (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
                      (endDate.getUTCMonth() - startDate.getUTCMonth());
  return Math.max(0, Math.min(monthsElapsed, totalMonths));
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCUMULATED DEPRECIATION (Balance Sheet)
//
// Accrues MONTHLY from the 1st of the purchase month up to the current month
// (or end of useful life if the asset is already fully depreciated).
// This means the Balance Sheet value changes at the start of each month.
// ─────────────────────────────────────────────────────────────────────────────
fixedAssetSchema.virtual('accumulatedDepreciation').get(function() {
  if (!this.purchaseDate || !this.purchaseCost) return 0;

  const now        = new Date();
  const startDate  = _depreciationStartDate(this.purchaseDate);
  const endDate    = _depreciationEndDate(startDate, this.usefulLifeYears);
  const totalMonths = this.usefulLifeYears * 12;

  if (totalMonths <= 0) return 0;

  const monthsUsed = _monthsUsed(startDate, endDate, now);
  if (monthsUsed <= 0) return 0;

  const depreciable = this.purchaseCost - (this.salvageValue || 0);
  if (depreciable <= 0) return 0;

  const monthsPerYear = totalMonths / this.usefulLifeYears;

  switch (this.depreciationMethod) {
    case 'straight-line': {
      // Constant monthly rate → linear accumulation
      return Math.min((depreciable / totalMonths) * monthsUsed, depreciable);
    }

    case 'sum-of-years': {
      const syd = (this.usefulLifeYears * (this.usefulLifeYears + 1)) / 2;
      const fullYears    = Math.floor(monthsUsed / monthsPerYear);
      const remainMonths = monthsUsed - fullYears * monthsPerYear;
      let accumulated    = 0;
      for (let i = 0; i < fullYears && i < this.usefulLifeYears; i++) {
        accumulated += (depreciable * (this.usefulLifeYears - i)) / syd;
      }
      if (remainMonths > 0 && fullYears < this.usefulLifeYears) {
        const yearlyDep = (depreciable * (this.usefulLifeYears - fullYears)) / syd;
        accumulated += (yearlyDep / monthsPerYear) * remainMonths;
      }
      return Math.min(accumulated, depreciable);
    }

    case 'declining-balance': {
      const rate      = _dbRate(this.purchaseCost, this.salvageValue || 0, this.usefulLifeYears);
      const fullYears = Math.floor(monthsUsed / monthsPerYear);
      const remainMonths = monthsUsed - fullYears * monthsPerYear;
      let accumulated  = 0;
      let bookValue    = this.purchaseCost;
      for (let i = 0; i < fullYears && bookValue > (this.salvageValue || 0); i++) {
        const dep = Math.min(bookValue * rate, Math.max(0, bookValue - (this.salvageValue || 0)));
        accumulated += dep;
        bookValue   -= dep;
      }
      if (remainMonths > 0 && bookValue > (this.salvageValue || 0)) {
        const yearlyDep = Math.min(bookValue * rate, Math.max(0, bookValue - (this.salvageValue || 0)));
        accumulated += (yearlyDep / monthsPerYear) * remainMonths;
      }
      return Math.min(accumulated, depreciable);
    }

    default:
      return Math.min((depreciable / totalMonths) * monthsUsed, depreciable);
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

// Static method: Calculate monthly depreciation for a specific period
// period: Date object representing the month to calculate depreciation for
fixedAssetSchema.statics.calculateMonthlyDepreciation = async function(assetId, period) {
  const asset = await this.findById(assetId);
  if (!asset || asset.status !== 'active') return 0;
  
  return asset.getMonthlyDepreciationAmount(period);
};

// Method: Get monthly depreciation amount for a specific period
fixedAssetSchema.methods.getMonthlyDepreciationAmount = function(period) {
  if (!this.purchaseDate || !this.purchaseCost || !this.usefulLifeYears) return 0;
  if (this.status !== 'active') return 0;
  
  const periodDate = new Date(period);
  const startDate = _depreciationStartDate(this.purchaseDate);
  const endDate = _depreciationEndDate(startDate, this.usefulLifeYears);
  
  // Check if period is within depreciation range
  if (periodDate < startDate || periodDate >= endDate) return 0;
  
  const depreciable = this.purchaseCost - (this.salvageValue || 0);
  if (depreciable <= 0) return 0;
  
  const totalMonths = this.usefulLifeYears * 12;
  
  switch (this.depreciationMethod) {
    case 'straight-line':
      return depreciable / totalMonths;
    
    case 'sum-of-years': {
      const syd = (this.usefulLifeYears * (this.usefulLifeYears + 1)) / 2;
      // Calculate which year we're in
      const monthsElapsed =
        (periodDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
        (periodDate.getUTCMonth() - startDate.getUTCMonth());
      const yearIndex = Math.floor(monthsElapsed / 12);
      const remainingLife = this.usefulLifeYears - yearIndex;
      return (depreciable * remainingLife) / syd / 12;
    }
    
    case 'declining-balance': {
      const rate = _dbRate(this.purchaseCost, this.salvageValue || 0, this.usefulLifeYears);
      const monthsElapsed =
        (periodDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
        (periodDate.getUTCMonth() - startDate.getUTCMonth());
      const yearIndex = Math.floor(monthsElapsed / 12);
      let bookValue = this.purchaseCost;
      for (let i = 0; i < yearIndex; i++) {
        const dep = Math.min(bookValue * rate, Math.max(0, bookValue - (this.salvageValue || 0)));
        bookValue -= dep;
      }
      // Prorate for the specific month
      const monthlyRate = Math.pow(1 - rate, 1/12);
      const monthInYear = monthsElapsed % 12;
      const startOfMonth = new Date(Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth() + monthsElapsed,
        1
      ));
      const daysInMonth = new Date(startOfMonth.getUTCFullYear(), startOfMonth.getUTCMonth() + 1, 0).getUTCDate();
      const dayOfMonth = periodDate.getUTCDate();
      const dailyPortion = dayOfMonth / daysInMonth;
      return Math.min(bookValue * rate, Math.max(0, bookValue - (this.salvageValue || 0))) / 12 * dailyPortion;
    }
    
    default:
      return depreciable / totalMonths;
  }
};

// Static method: Get all active assets that need depreciation for a period
fixedAssetSchema.statics.getAssetsForDepreciation = async function(companyId, period) {
  const periodDate = new Date(period);
  const assets = await this.find({
    company: companyId,
    status: 'active'
  });
  
  const result = [];
  for (const asset of assets) {
    const monthlyAmount = asset.getMonthlyDepreciationAmount(periodDate);
    if (monthlyAmount > 0) {
      // Check if depreciation already recorded for this period
      const periodKey = `${periodDate.getUTCFullYear()}-${String(periodDate.getUTCMonth() + 1).padStart(2, '0')}`;
      const alreadyRecorded = (asset.depreciationEntries || []).some(
        entry => entry.period === periodKey
      );
      
      result.push({
        asset: asset,
        monthlyDepreciation: monthlyAmount,
        alreadyRecorded
      });
    }
  }
  return result;
};

module.exports = mongoose.model('FixedAsset', fixedAssetSchema);
