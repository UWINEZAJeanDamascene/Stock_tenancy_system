const express = require('express');
const router = express.Router();

// Warehouse routes
const {
  getWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  getWarehouseInventory
} = require('../controllers/warehouseController');

// Inventory Batch routes
const {
  getInventoryBatches,
  getInventoryBatch,
  createInventoryBatch,
  updateInventoryBatch,
  consumeFromBatch,
  getExpiringBatches,
  getProductBatches
} = require('../controllers/inventoryBatchController');

// Serial Number routes
const {
  getSerialNumbers,
  getSerialNumber,
  createSerialNumber,
  updateSerialNumber,
  sellSerialNumber,
  returnSerialNumber,
  lookupSerialNumber,
  getAvailableSerials
} = require('../controllers/serialNumberController');

// Stock Transfer routes
const {
  getStockTransfers,
  getStockTransfer,
  createStockTransfer,
  approveStockTransfer,
  completeStockTransfer,
  cancelStockTransfer
} = require('../controllers/stockTransferController');

// Stock Audit routes
const {
  getStockAudits,
  getStockAudit,
  createStockAudit,
  updateAuditItem,
  completeStockAudit,
  cancelStockAudit,
  getAuditVariance
} = require('../controllers/stockAuditController');

// Reorder Point routes
const {
  getReorderPoints,
  getReorderPoint,
  createReorderPoint,
  updateReorderPoint,
  deleteReorderPoint,
  getProductsNeedingReorder,
  bulkCreateReorderPoints
} = require('../controllers/reorderPointController');

const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

// ========== WAREHOUSE ROUTES ==========
router.route('/warehouses')
  .get(getWarehouses)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createWarehouse);

router.route('/warehouses/:id')
  .get(getWarehouse)
  .put(authorize('admin', 'stock_manager'), logAction('stock'), updateWarehouse)
  .delete(authorize('admin'), logAction('stock'), deleteWarehouse);

router.get('/warehouses/:id/inventory', getWarehouseInventory);

// ========== INVENTORY BATCH ROUTES ==========
router.route('/batches')
  .get(getInventoryBatches)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createInventoryBatch);

router.route('/batches/:id')
  .get(getInventoryBatch)
  .put(authorize('admin', 'stock_manager'), logAction('stock'), updateInventoryBatch);

router.post('/batches/:id/consume', authorize('admin', 'stock_manager'), logAction('stock'), consumeFromBatch);

router.get('/batches/expiring', getExpiringBatches);
router.get('/batches/product/:productId', getProductBatches);

// ========== SERIAL NUMBER ROUTES ==========
router.route('/serial-numbers')
  .get(getSerialNumbers)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createSerialNumber);

router.route('/serial-numbers/:id')
  .get(getSerialNumber)
  .put(authorize('admin', 'stock_manager'), logAction('stock'), updateSerialNumber);

router.post('/serial-numbers/:id/sell', authorize('admin', 'stock_manager'), logAction('stock'), sellSerialNumber);
router.post('/serial-numbers/:id/return', authorize('admin', 'stock_manager'), logAction('stock'), returnSerialNumber);

router.get('/serial-numbers/lookup/:serial', lookupSerialNumber);
router.get('/serial-numbers/product/:productId/available', getAvailableSerials);

// ========== STOCK TRANSFER ROUTES ==========
router.route('/transfers')
  .get(getStockTransfers)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createStockTransfer);

router.route('/transfers/:id')
  .get(getStockTransfer)
  .post(authorize('admin'), approveStockTransfer);

router.post('/transfers/:id/approve', authorize('admin'), logAction('stock'), approveStockTransfer);
router.post('/transfers/:id/complete', authorize('admin', 'stock_manager'), logAction('stock'), completeStockTransfer);
router.post('/transfers/:id/cancel', authorize('admin'), logAction('stock'), cancelStockTransfer);

// ========== STOCK AUDIT ROUTES ==========
router.route('/audits')
  .get(getStockAudits)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createStockAudit);

router.route('/audits/:id')
  .get(getStockAudit)
  .put(authorize('admin', 'stock_manager'), updateAuditItem);

router.put('/audits/:id/items/:itemId', authorize('admin', 'stock_manager'), updateAuditItem);
router.post('/audits/:id/complete', authorize('admin'), logAction('stock'), completeStockAudit);
router.post('/audits/:id/cancel', authorize('admin'), logAction('stock'), cancelStockAudit);
router.get('/audits/:id/variance', getAuditVariance);

// ========== REORDER POINT ROUTES ==========
router.route('/reorder-points')
  .get(getReorderPoints)
  .post(authorize('admin', 'stock_manager'), logAction('stock'), createReorderPoint);

// Place static/specific routes before the parameterized :id route to avoid route conflicts
router.get('/reorder-points/needing-reorder', getProductsNeedingReorder);

router.route('/reorder-points/:id')
  .get(getReorderPoint)
  .put(authorize('admin', 'stock_manager'), logAction('stock'), updateReorderPoint)
  .delete(authorize('admin'), logAction('stock'), deleteReorderPoint);
router.post('/reorder-points/bulk', authorize('admin', 'stock_manager'), logAction('stock'), bulkCreateReorderPoints);

// Auto-reorder routes
const { 
  applyReorderPointToProduct, 
  triggerAutoReorderCheck 
} = require('../controllers/reorderPointController');

router.post('/reorder-points/apply-to-product', authorize('admin', 'stock_manager'), logAction('stock'), applyReorderPointToProduct);
router.post('/reorder-points/trigger-auto-check', authorize('admin', 'stock_manager'), triggerAutoReorderCheck);

module.exports = router;
