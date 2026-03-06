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

router.use(protect);

router.get('/stock-valuation', getStockValuationReport);
router.get('/sales-summary', getSalesSummaryReport);
router.get('/product-movement', getProductMovementReport);
router.get('/client-sales', getClientSalesReport);
router.get('/supplier-purchase', getSupplierPurchaseReport);
router.get('/export/excel/:reportType', exportReportToExcel);
router.get('/export/pdf/:reportType', exportReportToPDF);
router.get('/profit-and-loss', getProfitAndLossReport);
router.get('/aging', getAgingReport);
router.get('/vat-summary', getVATSummaryReport);
router.get('/product-performance', getProductPerformanceReport);
router.get('/clv', getCLVReport);
router.get('/cash-flow', getCashFlowStatement);
router.get('/budget-vs-actual', getBudgetVsActualReport);

module.exports = router;
