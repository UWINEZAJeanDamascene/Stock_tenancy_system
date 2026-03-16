const express = require('express');
const router = express.Router();
const {
  getBudgets,
  getBudgetById,
  createBudget,
  updateBudget,
  deleteBudget,
  approveBudget,
  rejectBudget,
  getBudgetComparison,
  getAllBudgetsComparison,
  getBudgetSummary,
  cloneBudget,
  closeBudget,
  getRevenueForecast,
  getExpenseForecast,
  getCashFlowForecast
} = require('../controllers/budgetController');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware, sessionMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);
router.use(sessionMiddleware);

// CRUD routes
router.route('/')
  .get(cacheMiddleware({ type: 'budget', ttl: 300 }), getBudgets)
  .post(createBudget);

router.route('/summary')
  .get(getBudgetSummary);

router.route('/compare/all')
  .get(getAllBudgetsComparison);

// Forecast routes
router.route('/forecast/revenue')
  .get(getRevenueForecast);

router.route('/forecast/expense')
  .get(getExpenseForecast);

router.route('/forecast/cashflow')
  .get(getCashFlowForecast);

router.route('/:id')
  .get(getBudgetById)
  .put(updateBudget)
  .delete(deleteBudget);

router.route('/:id/compare')
  .get(getBudgetComparison);

router.route('/:id/approve')
  .post(authorize('admin', 'manager'), approveBudget);

router.route('/:id/reject')
  .post(authorize('admin', 'manager'), rejectBudget);

router.route('/:id/clone')
  .post(cloneBudget);

router.route('/:id/close')
  .post(closeBudget);

module.exports = router;
