const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const {
  createSale,
  addPayment,
  openDrawer,
  closeDrawer,
  getDrawer,
  getReceipt
} = require('../controllers/posController');

// All POS routes require authentication
router.use(protect);

router.post('/sale', logAction('pos_sale'), createSale);
router.post('/sale/:id/pay', logAction('pos_payment'), addPayment);
router.get('/sale/:id/receipt', getReceipt);

router.post('/drawer/open', logAction('drawer_open'), openDrawer);
router.post('/drawer/close', logAction('drawer_close'), closeDrawer);
router.get('/drawer/:drawerId', getDrawer);

module.exports = router;
