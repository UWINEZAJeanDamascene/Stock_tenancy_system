const express = require('express');
const router = express.Router();
const {
  getStockValuationReport,
  getSalesSummaryReport,
  getProductMovementReport,
  getClientSalesReport,
  getSupplierPurchaseReport,
  exportReportToExcel,
  exportReportToPDF
  ,
  
  // new reports
  getProfitAndLossReport,
  getAgingReport,
  getVATSummaryReport,
  getProductPerformanceReport,
  getCLVReport,
  getCashFlowStatement,
  getBudgetVsActualReport
} = require('../controllers/reportController');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware, sessionMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);
router.use(sessionMiddleware);

router.get('/stock-valuation', cacheMiddleware({ type: 'report', ttl: 900 }), getStockValuationReport);
router.get('/sales-summary', cacheMiddleware({ type: 'report', ttl: 900 }), getSalesSummaryReport);
router.get('/product-movement', cacheMiddleware({ type: 'report', ttl: 900 }), getProductMovementReport);
router.get('/client-sales', cacheMiddleware({ type: 'report', ttl: 900 }), getClientSalesReport);
router.get('/supplier-purchase', cacheMiddleware({ type: 'report', ttl: 900 }), getSupplierPurchaseReport);
router.get('/export/excel/:reportType', exportReportToExcel);
router.get('/export/pdf/:reportType', exportReportToPDF);
router.get('/profit-and-loss', cacheMiddleware({ type: 'report', ttl: 900 }), getProfitAndLossReport);
router.get('/aging', cacheMiddleware({ type: 'report', ttl: 900 }), getAgingReport);
router.get('/vat-summary', cacheMiddleware({ type: 'report', ttl: 900 }), getVATSummaryReport);
router.get('/product-performance', cacheMiddleware({ type: 'report', ttl: 900 }), getProductPerformanceReport);
router.get('/clv', cacheMiddleware({ type: 'report', ttl: 900 }), getCLVReport);
router.get('/cash-flow', cacheMiddleware({ type: 'report', ttl: 900 }), getCashFlowStatement);
router.get('/budget-vs-actual', cacheMiddleware({ type: 'report', ttl: 900 }), getBudgetVsActualReport);

module.exports = router;
