const express = require('express');
const router = express.Router();
const taxController = require('../controllers/taxController');
const { protect, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(protect);

// Tax records CRUD
router.get('/', taxController.getTaxRecords);
router.get('/summary', taxController.getTaxSummary);
router.get('/calendar', taxController.getCalendar);
router.get('/filing-history', taxController.getFilingHistory);
router.get('/vat-return', taxController.prepareVATReturn);
router.post('/generate-calendar', taxController.generateCalendar);

router.get('/:id', taxController.getTaxById);
router.post('/', taxController.createTax);
router.put('/:id', taxController.updateTax);
router.delete('/:id', taxController.deleteTax);

// Payments and filings
router.post('/:id/payments', taxController.addPayment);
router.post('/:id/filings', taxController.addFiling);
router.post('/:id/calendar', taxController.addCalendarEntry);

module.exports = router;
