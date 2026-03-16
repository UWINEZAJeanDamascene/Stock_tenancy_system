const express = require('express');
const router = express.Router();
const {
  getJournalEntries,
  getJournalEntry,
  createJournalEntry,
  updateJournalEntry,
  voidJournalEntry,
  deleteJournalEntry,
  postJournalEntry,
  getAccounts,
  getTrialBalance,
  getGeneralLedger,
  runDepreciation
} = require('../controllers/journalController');
const { protect } = require('../middleware/auth');

router.use(protect);

// Routes
router.route('/')
  .get(getJournalEntries)
  .post(createJournalEntry);

// Utility routes (must come before parameterized routes)
router.get('/accounts', getAccounts);
router.get('/trial-balance', getTrialBalance);
router.get('/general-ledger', getGeneralLedger);
router.post('/run-depreciation', runDepreciation);

router.route('/:id')
  .get(getJournalEntry)
  .put(updateJournalEntry)
  .delete(voidJournalEntry);

// Permanent delete route (must come before parameterized routes with same method)
router.delete('/:id/permanent', deleteJournalEntry);

// Post (finalize) a journal entry
router.put('/:id/post', postJournalEntry);

module.exports = router;
