/**
 * Pre-computed Aggregations Model
 * Stores nightly/daily pre-computed report data for fast retrieval
 */

const mongoose = require('mongoose');

const precomputedAggregationSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      'balance-sheet',
      'profit-and-loss',
      'inventory-valuation',
      'daily-summary',
      'monthly-summary',
      'vat-summary'
    ],
    required: true,
    index: true
  },
  period: {
    type: String, // 'daily', 'monthly', 'yearly', or date string '2024-01'
    required: true,
    index: true
  },
  asOfDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  // Pre-computed data fields
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  // Metadata
  computedAt: {
    type: Date,
    default: Date.now
  },
  computationTimeMs: {
    type: Number
  },
  status: {
    type: String,
    enum: ['success', 'failed', 'in-progress'],
    default: 'success'
  },
  errorMessage: {
    type: String
  }
}, {
  timestamps: true,
  capped: { size: 1073741824 } // 1GB capped collection
});

// Compound index for efficient queries
precomputedAggregationSchema.index({ company: 1, type: 1, period: -1 });
precomputedAggregationSchema.index({ company: 1, type: 1, asOfDate: -1 });

/**
 * Get the latest pre-computed data for a company and type
 */
precomputedAggregationSchema.statics.getLatest = async function(companyId, type, period = 'latest') {
  const query = { company: companyId, type, status: 'success' };
  
  if (period !== 'latest') {
    query.period = period;
  }
  
  return await this.findOne(query).sort({ asOfDate: -1 });
};

/**
 * Store pre-computed data
 */
precomputedAggregationSchema.statics.store = async function(companyId, type, period, data, computationTimeMs) {
  return await this.findOneAndUpdate(
    { company: companyId, type, period },
    {
      company: companyId,
      type,
      period,
      asOfDate: new Date(),
      data,
      computedAt: new Date(),
      computationTimeMs,
      status: 'success'
    },
    { upsert: true, new: true }
  );
};

/**
 * Get balance sheet data (from cache or compute)
 */
precomputedAggregationSchema.statics.getBalanceSheet = async function(companyId, options = {}) {
  const { useCache = true, cacheAge = 15 } = options; // cacheAge in minutes
  
  if (useCache) {
    const cached = await this.getLatest(companyId, 'balance-sheet');
    if (cached) {
      const age = (Date.now() - cached.computedAt.getTime()) / (1000 * 60);
      if (age < cacheAge) {
        return { data: cached.data, fromCache: true, computedAt: cached.computedAt };
      }
    }
  }
  
  return { fromCache: false };
};

/**
 * Clean old pre-computed data
 */
precomputedAggregationSchema.statics.cleanOld = async function(companyId, olderThanDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  
  return await this.deleteMany({
    company: companyId,
    computedAt: { $lt: cutoff }
  });
};

const PrecomputedAggregation = mongoose.model('PrecomputedAggregation', precomputedAggregationSchema);

module.exports = PrecomputedAggregation;
