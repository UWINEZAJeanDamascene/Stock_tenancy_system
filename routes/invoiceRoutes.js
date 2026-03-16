const express = require('express');
const router = express.Router();
const {
  getInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  confirmInvoice,
  recordPayment,
  cancelInvoice,
  saveReceiptMetadata,
  getClientInvoices,
  getProductInvoices,
  generateInvoicePDF,
  sendInvoiceEmail
} = require('../controllers/invoiceController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(getInvoices)
  .post(authorize('admin', 'sales'), logAction('invoice'), createInvoice);

router.route('/:id')
  .get(getInvoice)
  .put(authorize('admin', 'sales'), logAction('invoice'), updateInvoice)
  .delete(authorize('admin'), logAction('invoice'), deleteInvoice);

// Confirm invoice (deducts stock)
router.put('/:id/confirm', authorize('admin'), logAction('invoice'), confirmInvoice);

// Record payment
router.post('/:id/payment', authorize('admin', 'sales'), logAction('invoice'), recordPayment);

// Cancel invoice (reverses stock)
router.put('/:id/cancel', authorize('admin'), logAction('invoice'), cancelInvoice);

// Save receipt metadata (SDC/Receipt info)
router.post('/:id/receipt-metadata', authorize('admin', 'stock_manager'), saveReceiptMetadata);

// PDF generation
router.get('/:id/pdf', generateInvoicePDF);

// Send invoice via email
router.post('/:id/send-email', authorize('admin', 'sales'), logAction('invoice'), sendInvoiceEmail);

// Client and product specific routes
router.get('/client/:clientId', getClientInvoices);
router.get('/product/:productId', getProductInvoices);

module.exports = router;
