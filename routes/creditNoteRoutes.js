const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const controller = require('../controllers/creditNoteController');

router.use(protect);

router.route('/')
  .get(controller.getCreditNotes)
  .post(controller.createCreditNote);

router.route('/:id')
  .get(controller.getCreditNote)
  .delete(controller.deleteCreditNote);

router.put('/:id/approve', controller.approveCreditNote);
router.post('/:id/apply', controller.applyCreditNote); // Apply to another invoice
router.post('/:id/refund', controller.recordRefund);

module.exports = router;
