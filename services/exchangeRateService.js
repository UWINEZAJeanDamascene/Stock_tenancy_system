const axios = require('axios');

// Static exchange rates - 1 USD = X currency
// These are accurate rates that will be used directly
const STATIC_RATES = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.79,
  FRW: 1400,      // 1 USD = 1230 Rwandan Franc
  LBP: 89500,     // 1 USD = 89500 Lebanese Pound
  SAR: 3.75,      // 1 USD = 3.75 Saudi Riyal
  AED: 3.67,      // 1 USD = 3.67 UAE Dirham
  TZS: 2500,      // 1 USD = 2500 Tanzanian Shilling
  UGX: 3850,      // 1 USD = 3850 Ugandan Shilling
  KES: 153,       // 1 USD = 153 Kenyan Shilling
  BIF: 2850,      // 1 USD = 2850 Burundian Franc
  ZMW: 26,        // 1 USD = 26 Zambian Kwacha
  MWK: 1680,      // 1 USD = 1680 Malawian Kwacha
  AOA: 830        // 1 USD = 830 Angolan Kwanza
};

// Cache for exchange rates
let rateCache = {
  rates: STATIC_RATES,
  lastFetch: Date.now(),
  source: 'static'
};

/**
 * Get cached rates
 */
async function getExchangeRates(forceRefresh = false) {
  return {
    success: true,
    rates: rateCache.rates,
    source: rateCache.source,
    timestamp: new Date()
  };
}

/**
 * Convert amount from one currency to another
 * All rates are based on 1 USD = X currency
 */
async function convertCurrency(amount, fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) {
    return amount;
  }
  
  const rates = rateCache.rates;
  
  if (!rates[fromCurrency] || !rates[toCurrency]) {
    console.error(`Unsupported currency: ${fromCurrency} or ${toCurrency}`);
    return amount;
  }
  
  // Convert: first to USD, then to target currency
  // Example: 1230 FRW -> 1 USD -> 0.92 EUR
  const amountInUSD = amount / rates[fromCurrency];
  const convertedAmount = amountInUSD * rates[toCurrency];
  
  return convertedAmount;
}

/**
 * Get rate for specific currency pair
 */
async function getRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) {
    return 1;
  }
  
  const rates = rateCache.rates;
  
  if (!rates[fromCurrency] || !rates[toCurrency]) {
    return 1;
  }
  
  // Calculate cross rate via USD
  return rates[toCurrency] / rates[fromCurrency];
}

/**
 * Get all available rates
 */
async function getAllRates() {
  return getExchangeRates();
}

/**
 * Get supported currencies list
 */
function getSupportedCurrencies() {
  return [
    { code: 'USD', name: 'US Dollar', symbol: '$' },
    { code: 'EUR', name: 'Euro', symbol: '€' },
    { code: 'GBP', name: 'British Pound', symbol: '£' },
    { code: 'FRW', name: 'Rwandan Franc', symbol: 'FRW' },
    { code: 'LBP', name: 'Lebanese Pound', symbol: 'LBP' },
    { code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR' },
    { code: 'AED', name: 'UAE Dirham', symbol: 'AED' },
    { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TZS' },
    { code: 'UGX', name: 'Ugandan Shilling', symbol: 'UGX' },
    { code: 'KES', name: 'Kenyan Shilling', symbol: 'KES' },
    { code: 'BIF', name: 'Burundian Franc', symbol: 'BIF' },
    { code: 'ZMW', name: 'Zambian Kwacha', symbol: 'ZMW' },
    { code: 'MWK', name: 'Malawian Kwacha', symbol: 'MWK' },
    { code: 'AOA', name: 'Angolan Kwanza', symbol: 'AOA' }
  ];
}

module.exports = {
  getExchangeRates,
  convertCurrency,
  getRate,
  getAllRates,
  getSupportedCurrencies,
  FALLBACK_RATES: STATIC_RATES
};
