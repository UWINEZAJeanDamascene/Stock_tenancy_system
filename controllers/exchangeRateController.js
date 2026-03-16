const ExchangeRate = require('../models/ExchangeRate');
const exchangeRateService = require('../services/exchangeRateService');

// @desc    Get all current exchange rates
// @route   GET /api/exchange-rates
// @access  Public
exports.getExchangeRates = async (req, res, next) => {
  try {
    const { forceRefresh } = req.query;
    const result = await exchangeRateService.getExchangeRates(forceRefresh === 'true');

    // Save rates to database for historical tracking
    if (result.success && result.source !== 'cache') {
      const currencies = ['USD', 'EUR', 'GBP', 'FRW', 'LBP', 'SAR', 'AED'];
      
      for (const currency of currencies) {
        if (result.rates[currency]) {
          await ExchangeRate.findOneAndUpdate(
            { baseCurrency: 'USD', targetCurrency: currency },
            {
              baseCurrency: 'USD',
              targetCurrency: currency,
              rate: result.rates[currency],
              effectiveDate: new Date(),
              source: result.source
            },
            { upsert: true, new: true }
          );
        }
      }
    }

    res.json({
      success: true,
      data: {
        rates: result.rates,
        source: result.source,
        timestamp: result.timestamp || new Date(),
        cached: result.cached || false
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get supported currencies
// @route   GET /api/exchange-rates/currencies
// @access  Public
exports.getCurrencies = async (req, res, next) => {
  try {
    const currencies = exchangeRateService.getSupportedCurrencies();
    
    res.json({
      success: true,
      data: currencies
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Convert amount between currencies
// @route   POST /api/exchange-rates/convert
// @access  Public
exports.convertCurrency = async (req, res, next) => {
  try {
    const { amount, from, to } = req.body;

    if (!amount || !from || !to) {
      return res.status(400).json({
        success: false,
        message: 'Please provide amount, from, and to currencies'
      });
    }

    const convertedAmount = await exchangeRateService.convertCurrency(
      parseFloat(amount),
      from.toUpperCase(),
      to.toUpperCase()
    );

    const rate = await exchangeRateService.getRate(
      from.toUpperCase(),
      to.toUpperCase()
    );

    res.json({
      success: true,
      data: {
        originalAmount: parseFloat(amount),
        convertedAmount: Math.round(convertedAmount * 100) / 100,
        from: from.toUpperCase(),
        to: to.toUpperCase(),
        rate: Math.round(rate * 10000) / 10000
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get exchange rate history
// @route   GET /api/exchange-rates/history
// @access  Private
exports.getExchangeRateHistory = async (req, res, next) => {
  try {
    const { baseCurrency = 'USD', targetCurrency, startDate, endDate, limit = 30 } = req.query;

    const query = { baseCurrency: baseCurrency.toUpperCase() };
    
    if (targetCurrency) {
      query.targetCurrency = targetCurrency.toUpperCase();
    }

    if (startDate || endDate) {
      query.effectiveDate = {};
      if (startDate) query.effectiveDate.$gte = new Date(startDate);
      if (endDate) query.effectiveDate.$lte = new Date(endDate);
    }

    const history = await ExchangeRate.find(query)
      .sort({ effectiveDate: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      count: history.length,
      data: history
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Manual update exchange rate (admin)
// @route   PUT /api/exchange-rates/manual
// @access  Private/Admin
exports.manualUpdateRate = async (req, res, next) => {
  try {
    const { baseCurrency, targetCurrency, rate } = req.body;

    if (!baseCurrency || !targetCurrency || !rate) {
      return res.status(400).json({
        success: false,
        message: 'Please provide baseCurrency, targetCurrency, and rate'
      });
    }

    const exchangeRate = await ExchangeRate.findOneAndUpdate(
      { 
        baseCurrency: baseCurrency.toUpperCase(), 
        targetCurrency: targetCurrency.toUpperCase() 
      },
      {
        baseCurrency: baseCurrency.toUpperCase(),
        targetCurrency: targetCurrency.toUpperCase(),
        rate: parseFloat(rate),
        effectiveDate: new Date(),
        source: 'manual'
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      data: exchangeRate
    });
  } catch (error) {
    next(error);
  }
};
