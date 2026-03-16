const express = require('express');
const router = express.Router();
const {
  getClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  getClientPurchaseHistory,
  getClientOutstandingInvoices,
  toggleClientStatus,
  getClientsWithStats,
  exportClientsToPDF
} = require('../controllers/clientController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(getClients)
  .post(authorize('admin', 'sales'), logAction('client'), createClient);

// New route for clients with stats (for list view with outstanding invoice counts)
router.get('/with-stats', getClientsWithStats);

// Export route
router.get('/export/pdf', exportClientsToPDF);

router.route('/:id')
  .get(getClient)
  .put(authorize('admin', 'sales'), logAction('client'), updateClient)
  .delete(authorize('admin'), logAction('client'), deleteClient);

// Toggle status
router.put('/:id/toggle-status', authorize('admin'), toggleClientStatus);

router.get('/:id/purchase-history', getClientPurchaseHistory);
router.get('/:id/outstanding-invoices', getClientOutstandingInvoices);

module.exports = router;
