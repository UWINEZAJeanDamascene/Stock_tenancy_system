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
  getLowStockProducts
} = require('../controllers/productController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

// All routes require authentication
router.use(protect);

router.route('/')
  .get(getProducts)
  .post(authorize('admin'), logAction('product'), createProduct);

router.get('/low-stock', getLowStockProducts);

router.route('/:id')
  .get(getProduct)
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
