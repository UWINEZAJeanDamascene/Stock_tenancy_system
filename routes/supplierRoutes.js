const express = require('express');
const router = express.Router();
const {
  getSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  getSupplierPurchaseHistory,
  toggleSupplierStatus
} = require('../controllers/supplierController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(getSuppliers)
  .post(authorize('admin'), logAction('supplier'), createSupplier);

router.route('/:id')
  .get(getSupplier)
  .put(authorize('admin'), logAction('supplier'), updateSupplier)
  .delete(authorize('admin'), logAction('supplier'), deleteSupplier);

router.get('/:id/purchase-history', getSupplierPurchaseHistory);

router.put('/:id/toggle-status', authorize('admin'), logAction('supplier'), toggleSupplierStatus);

module.exports = router;
