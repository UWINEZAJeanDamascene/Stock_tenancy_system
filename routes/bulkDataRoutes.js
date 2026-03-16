const express = require('express');
const router = express.Router();
const {
  exportProducts,
  exportClients,
  exportSuppliers,
  importProducts,
  importClients,
  importSuppliers,
  downloadTemplate,
  uploadCSV
} = require('../controllers/bulkDataController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

// Export routes
router.get('/export/products', exportProducts);
router.get('/export/clients', exportClients);
router.get('/export/suppliers', exportSuppliers);

// Template download
router.get('/template/:type', downloadTemplate);

// Import routes (with file upload)
router.post('/import/products', authorize('admin', 'stock_manager'), logAction('bulk_import'), uploadCSV, importProducts);
router.post('/import/clients', authorize('admin', 'sales'), logAction('bulk_import'), uploadCSV, importClients);
router.post('/import/suppliers', authorize('admin', 'stock_manager'), logAction('bulk_import'), uploadCSV, importSuppliers);

module.exports = router;
