const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const controller = require('../controllers/subscriptionController');

router.use(protect);

router.route('/')
  .get(controller.getSubscriptions)
  .post(controller.createSubscription);

router.route('/:id')
  .get(controller.getSubscription)
  .put(controller.updateSubscription)
  .delete(controller.deleteSubscription);

module.exports = router;
