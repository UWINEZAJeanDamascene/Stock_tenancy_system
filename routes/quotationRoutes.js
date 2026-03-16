const express = require('express');
const router = express.Router();
const {
  getQuotations,
  getQuotation,
  createQuotation,
  updateQuotation,
  deleteQuotation,
  approveQuotation,
  convertToInvoice,
  getClientQuotations,
  getProductQuotations,
  generateQuotationPDF
} = require('../controllers/quotationController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(getQuotations)
  .post(authorize('admin', 'sales'), logAction('quotation'), createQuotation);

// PDF route must come BEFORE :id route
router.get('/:id/pdf', generateQuotationPDF);

router.route('/:id')
  .get(getQuotation)
  .put(authorize('admin', 'sales'), logAction('quotation'), updateQuotation)
  .delete(authorize('admin', 'sales'), logAction('quotation'), deleteQuotation);

router.put('/:id/approve', authorize('admin'), logAction('quotation'), approveQuotation);
router.post('/:id/convert-to-invoice', authorize('admin', 'sales'), logAction('quotation'), convertToInvoice);
router.get('/client/:clientId', getClientQuotations);
router.get('/product/:productId', getProductQuotations);

module.exports = router;
