const express = require('express');
const router = express.Router();
const {
  getDeliveryNotes,
  getDeliveryNote,
  createDeliveryNote,
  updateDeliveryNote,
  deleteDeliveryNote,
  dispatchDeliveryNote,
  confirmDelivery,
  cancelDeliveryNote,
  createInvoiceFromDeliveryNote,
  getQuotationDeliveryNotes,
  generateDeliveryNotePDF,
  updateItemDeliveryQty
} = require('../controllers/deliveryNoteController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(getDeliveryNotes)
  .post(authorize('admin', 'sales', 'stock_manager'), logAction('delivery_note'), createDeliveryNote);

// PDF route must come BEFORE :id route
router.get('/:id/pdf', generateDeliveryNotePDF);

// Get delivery notes for a quotation
router.get('/quotation/:quotationId', getQuotationDeliveryNotes);

router.route('/:id')
  .get(getDeliveryNote)
  .put(authorize('admin', 'sales', 'stock_manager'), logAction('delivery_note'), updateDeliveryNote)
  .delete(authorize('admin', 'sales'), logAction('delivery_note'), deleteDeliveryNote);

// Update item delivery quantity
router.put('/:id/items/:itemId', authorize('admin', 'sales', 'stock_manager'), logAction('delivery_note'), updateItemDeliveryQty);

// Dispatch delivery note (goods leave warehouse)
router.put('/:id/dispatch', authorize('admin', 'sales', 'stock_manager'), logAction('delivery_note'), dispatchDeliveryNote);

// Confirm delivery (client received goods)
router.put('/:id/confirm', authorize('admin', 'sales', 'stock_manager'), logAction('delivery_note'), confirmDelivery);

// Cancel delivery note
router.put('/:id/cancel', authorize('admin'), logAction('delivery_note'), cancelDeliveryNote);

// Create invoice from delivery note
router.post('/:id/create-invoice', authorize('admin', 'sales'), logAction('delivery_note'), createInvoiceFromDeliveryNote);

module.exports = router;
