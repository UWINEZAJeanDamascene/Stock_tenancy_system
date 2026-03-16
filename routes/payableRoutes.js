const express = require('express');
const router = express.Router();
const {
  getPaymentSchedules,
  getPaymentSchedule,
  createPaymentSchedule,
  updatePaymentSchedule,
  deletePaymentSchedule,
  recordSchedulePayment,
  getSupplierStatement,
  reconcileSupplierStatement,
  getPayableAgingReport,
  getPayablesSummary,
  generateSchedulesFromPurchases
} = require('../controllers/payableController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

// Payment schedules CRUD
router.route('/schedules')
  .get(getPaymentSchedules)
  .post(authorize('admin'), logAction('payable'), createPaymentSchedule);

router.route('/schedules/:id')
  .get(getPaymentSchedule)
  .put(authorize('admin'), logAction('payable'), updatePaymentSchedule)
  .delete(authorize('admin'), logAction('payable'), deletePaymentSchedule);

// Record payment for a schedule
router.post('/schedules/:id/pay', authorize('admin', 'stock_manager'), logAction('payable'), recordSchedulePayment);

// Supplier statement reconciliation
router.get('/supplier/:supplierId/statement', getSupplierStatement);
router.post('/supplier/:supplierId/reconcile', authorize('admin'), logAction('payable'), reconcileSupplierStatement);

// Payable aging report (enhanced version)
router.get('/aging', getPayableAgingReport);

// Payables dashboard summary
router.get('/summary', getPayablesSummary);

// Auto-generate payment schedules
router.post('/generate-schedules', authorize('admin'), logAction('payable'), generateSchedulesFromPurchases);

module.exports = router;
