const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const controller = require('../controllers/recurringInvoiceController');

router.use(protect);

router.route('/')
  .get(controller.getRecurringInvoices)
  .post(controller.createRecurringInvoice);

router.post('/trigger', controller.triggerGeneration);

router.post('/:id/trigger', controller.triggerTemplate);

router.route('/:id')
  .get(controller.getRecurringInvoice)
  .put(controller.updateRecurringInvoice)
  .delete(controller.deleteRecurringInvoice);

module.exports = router;
