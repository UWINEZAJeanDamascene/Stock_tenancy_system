const mongoose = require('mongoose');

const exchangeRateSchema = new mongoose.Schema({
  baseCurrency: {
    type: String,
    required: true,
    default: 'USD',
    uppercase: true,
    enum: ['USD', 'EUR', 'GBP', 'FRW', 'LBP', 'SAR', 'AED', 'TZS', 'UGX', 'KES', 'BIF', 'ZMW', 'MWK', 'AOA']
  },
  targetCurrency: {
    type: String,
    required: true,
    uppercase: true,
    enum: ['USD', 'EUR', 'GBP', 'FRW', 'LBP', 'SAR', 'AED', 'TZS', 'UGX', 'KES', 'BIF', 'ZMW', 'MWK', 'AOA']
  },
  rate: {
    type: Number,
    required: true,
    min: 0
  },
  // For tracking historical rates
  effectiveDate: {
    type: Date,
    default: Date.now
  },
  source: {
    type: String,
    enum: ['coingecko', 'manual', 'fallback'],
    default: 'coingecko'
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Compound index for fast lookups
exchangeRateSchema.index({ baseCurrency: 1, targetCurrency: 1, effectiveDate: -1 });

// Virtual for current rate (most recent)
exchangeRateSchema.virtual('isCurrent').get(function() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return this.effectiveDate >= oneDayAgo;
});

exchangeRateSchema.set('toJSON', { virtuals: true });
exchangeRateSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ExchangeRate', exchangeRateSchema);
