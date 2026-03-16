const express = require('express');
const router = express.Router();
const {
  getFloats,
  getFloat,
  createFloat,
  updateFloat,
  deleteFloat,
  getExpenses,
  getExpense,
  createExpense,
  updateExpense,
  approveExpense,
  deleteExpense,
  getReplenishments,
  createReplenishment,
  approveReplenishment,
  completeReplenishment,
  rejectReplenishment,
  getReport,
  getSummary,
  getTransactions
} = require('../controllers/pettyCashController');

const { protect } = require('../middleware/auth');

// All routes require authentication
router.use(protect);

// Float routes
router.route('/floats')
  .get(getFloats)
  .post(createFloat);

router.route('/floats/:id')
  .get(getFloat)
  .put(updateFloat)
  .delete(deleteFloat);

// Expense routes
router.route('/expenses')
  .get(getExpenses)
  .post(createExpense);

router.route('/expenses/:id')
  .get(getExpense)
  .put(updateExpense)
  .delete(deleteExpense);

router.route('/expenses/:id/approve')
  .put(approveExpense);

// Replenishment routes
router.route('/replenishments')
  .get(getReplenishments)
  .post(createReplenishment);

router.route('/replenishments/:id/approve')
  .put(approveReplenishment);

router.route('/replenishments/:id/complete')
  .put(completeReplenishment);

router.route('/replenishments/:id/reject')
  .put(rejectReplenishment);

// Report & Summary routes
router.route('/report')
  .get(getReport);

router.route('/summary')
  .get(getSummary);

// Transactions history
router.route('/transactions')
  .get(getTransactions);

module.exports = router;
