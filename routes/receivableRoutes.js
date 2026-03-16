const express = require('express');
const router = express.Router();
const {
  getReceivablesSummary,
  getReceivableAgingReport,
  getClientStatement,
  writeOffBadDebt,
  reverseBadDebt,
  getBadDebts
} = require('../controllers/receivableController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

// Dashboard Summary
router.get('/summary', getReceivablesSummary);

// Aging Report
router.get('/aging', getReceivableAgingReport);

// Bad Debts
router.get('/bad-debts', getBadDebts);

// Client Statement
router.get('/client/:clientId/statement', getClientStatement);

// Write off bad debt
router.post('/client/:clientId/bad-debt', authorize('admin'), logAction('receivable'), writeOffBadDebt);

// Reverse bad debt
router.post('/invoice/:invoiceId/reverse-bad-debt', authorize('admin'), logAction('receivable'), reverseBadDebt);

module.exports = router;
