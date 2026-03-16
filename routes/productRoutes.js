const express = require('express');
const router = express.Router();
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  archiveProduct,
  restoreProduct,
  getProductHistory,
  getProductLifecycle,
  getLowStockProducts,
  checkLowStockAndNotify
} = require('../controllers/productController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, sessionMiddleware } = require('../middleware/cacheMiddleware');

// All routes require authentication
router.use(protect);
router.use(sessionMiddleware);

router.route('/')
  .get(cacheMiddleware({ type: 'product', ttl: 120 }), getProducts)
  .post(authorize('admin'), logAction('product'), createProduct);

router.get('/low-stock', getLowStockProducts);

// Check low stock and send notifications
router.post('/check-low-stock', authorize('admin'), checkLowStockAndNotify);

router.route('/:id')
  .get(cacheMiddleware({ type: 'product', ttl: 120, keyGenerator: (req) => cacheMiddlewareKey(req) }), getProduct)
  .put(authorize('admin'), logAction('product'), updateProduct)
  .delete(authorize('admin'), logAction('product'), deleteProduct);

router.put('/:id/archive', authorize('admin'), logAction('product'), archiveProduct);
router.put('/:id/restore', authorize('admin'), logAction('product'), restoreProduct);
router.get('/:id/history', getProductHistory);
router.get('/:id/lifecycle', getProductLifecycle);
// Barcode and QR code endpoints
router.get('/:id/barcode', require('../controllers/productController').getProductBarcode);
router.get('/:id/qrcode', require('../controllers/productController').getProductQRCode);

module.exports = router;

// Helper to generate cache key for single product routes
function cacheMiddlewareKey(req) {
  const params = { path: req.path, query: req.query, companyId: req.company?._id?.toString() || req.query.companyId };
  const cacheService = require('../services/cacheService');
  return cacheService.generateKey('product', params);
}
