const express = require('express');
const router = express.Router();
const {
  getLoans,
  getLoan,
  createLoan,
  updateLoan,
  deleteLoan,
  recordPayment,
  getLoansSummary
} = require('../controllers/loanController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .get(getLoans)
  .post(createLoan);

router.route('/summary')
  .get(getLoansSummary);

router.route('/:id')
  .get(getLoan)
  .put(updateLoan)
  .delete(deleteLoan);

router.route('/:id/payment')
  .post(recordPayment);

module.exports = router;
