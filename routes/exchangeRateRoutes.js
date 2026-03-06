const express = require('express');
const router = express.Router();
const {
  getExchangeRates,
  getCurrencies,
  convertCurrency,
  getExchangeRateHistory,
  manualUpdateRate
} = require('../controllers/exchangeRateController');
const { protect, authorize } = require('../middleware/auth');

// Public routes - no authentication required for exchange rates
router.get('/', getExchangeRates);
router.get('/currencies', getCurrencies);
router.post('/convert', convertCurrency);

// Protected routes
router.get('/history', protect, getExchangeRateHistory);

// Admin only routes
router.put('/manual', protect, authorize('admin'), manualUpdateRate);

module.exports = router;
