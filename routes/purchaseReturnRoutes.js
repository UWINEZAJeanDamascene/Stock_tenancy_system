const express = require('express');
const router = express.Router();
const { 
  getPurchaseReturns, 
  getPurchaseReturn, 
  createPurchaseReturn, 
  updatePurchaseReturn,
  approvePurchaseReturn,
  deletePurchaseReturn,
  getPurchaseReturnSummary,
  recordRefund
} = require('../controllers/purchaseReturnController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .get(getPurchaseReturns)
  .post(createPurchaseReturn);

router.route('/summary')
  .get(getPurchaseReturnSummary);

router.route('/:id')
  .get(getPurchaseReturn)
  .put(updatePurchaseReturn)
  .delete(deletePurchaseReturn);

router.route('/:id/approve')
  .put(approvePurchaseReturn);

router.route('/:id/refund')
  .put(recordRefund);

module.exports = router;
