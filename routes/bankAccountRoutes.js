const express = require('express');
const router = express.Router();
const {
  getBankAccounts,
  getBankAccount,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
  getAccountTransactions,
  addTransaction,
  transfer,
  getCashPosition,
  reconcile,
  getAllTransactions,
  adjustBalance,
  getAccountStats,
  getBankStatement,
  importCSV,
  autoMatchTransactions,
  getReconciliationReport
} = require('../controllers/bankAccountController');

const { protect } = require('../middleware/auth');

// All routes require authentication
router.use(protect);

// Summary routes
router.route('/summary/position')
  .get(getCashPosition);

// Transfer route
router.route('/transfer')
  .post(transfer);

// All transactions across all accounts
router.route('/transactions')
  .get(getAllTransactions);

// CRUD routes for bank accounts
router.route('/')
  .get(getBankAccounts)
  .post(createBankAccount);

// Individual account routes
router.route('/:id')
  .get(getBankAccount)
  .put(updateBankAccount)
  .delete(deleteBankAccount);

// Account-specific routes
router.route('/:id/transactions')
  .get(getAccountTransactions)
  .post(addTransaction);

router.route('/:id/reconcile')
  .post(reconcile);

router.route('/:id/adjust')
  .post(adjustBalance);

router.route('/:id/stats')
  .get(getAccountStats);

router.route('/:id/statement')
  .get(getBankStatement);

// CSV Import
router.route('/:id/import-csv')
  .post(importCSV);


// Auto-match
router.route('/:id/auto-match')
  .post(autoMatchTransactions);

// Reconciliation Report
router.route('/:id/reconciliation-report')
  .get(getReconciliationReport);

module.exports = router;
