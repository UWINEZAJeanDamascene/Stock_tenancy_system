const express = require('express');
const router = express.Router();
const {
  getFixedAssets,
  getFixedAsset,
  createFixedAsset,
  updateFixedAsset,
  deleteFixedAsset,
  getFixedAssetsSummary,
  getDepreciationPreview,
  runDepreciation,
  getDepreciationHistory
} = require('../controllers/fixedAssetController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .get(getFixedAssets)
  .post(createFixedAsset);

router.route('/summary')
  .get(getFixedAssetsSummary);

// Depreciation routes
router.route('/depreciation-preview')
  .get(getDepreciationPreview);

router.route('/run-depreciation')
  .post(runDepreciation);

router.route('/:id')
  .get(getFixedAsset)
  .put(updateFixedAsset)
  .delete(deleteFixedAsset);

router.route('/:id/depreciation-history')
  .get(getDepreciationHistory);

module.exports = router;
