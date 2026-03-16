const FixedAsset = require('../models/FixedAsset');
const JournalService = require('../services/journalService');
const JournalEntry = require('../models/JournalEntry');

// @desc    Get all fixed assets for a company
// @route   GET /api/fixed-assets
// @access  Private
exports.getFixedAssets = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, category } = req.query;
    
    const query = { company: companyId };
    if (status) query.status = status;
    if (category) query.category = category;

    const assets = await FixedAsset.find(query)
      .populate('supplier', 'name code')
      .populate('createdBy', 'name email')
      .sort({ purchaseDate: -1 });

    // Calculate totals
    const totalCost = assets.reduce((sum, asset) => sum + (asset.purchaseCost || 0), 0);
    const totalDepreciation = assets.reduce((sum, asset) => sum + (asset.accumulatedDepreciation || 0), 0);
    const totalNetValue = assets.reduce((sum, asset) => sum + (asset.netBookValue || 0), 0);

    res.json({
      success: true,
      count: assets.length,
      data: assets,
      summary: {
        totalCost,
        totalDepreciation,
        totalNetValue
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single fixed asset
// @route   GET /api/fixed-assets/:id
// @access  Private
exports.getFixedAsset = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const asset = await FixedAsset.findOne({ _id: req.params.id, company: companyId })
      .populate('supplier', 'name code')
      .populate('createdBy', 'name email');

    if (!asset) {
      return res.status(404).json({ success: false, message: 'Fixed asset not found' });
    }

    res.json({ success: true, data: asset });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new fixed asset
// @route   POST /api/fixed-assets
// @access  Private
exports.createFixedAsset = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const asset = await FixedAsset.create({
      ...req.body,
      company: companyId,
      createdBy: req.user._id
    });

    // Create journal entry for asset purchase
    try {
      await JournalService.createAssetPurchaseEntry(companyId, req.user.id, {
        _id: asset._id,
        name: asset.name,
        assetCode: asset.assetCode,
        category: asset.category,
        purchaseDate: asset.purchaseDate,
        purchaseCost: asset.purchaseCost,
        paymentMethod: asset.paymentMethod || 'cash'
      });
    } catch (journalError) {
      console.error('Error creating journal entry for asset purchase:', journalError);
      // Don't fail the asset creation if journal entry fails
    }

    // Automatically create depreciation journal entry for the current month
    try {
      if (asset.usefulLifeYears && asset.usefulLifeYears > 0) {
        const depreciable = asset.purchaseCost - (asset.salvageValue || 0);
        const totalMonths = asset.usefulLifeYears * 12;
        const monthlyDepreciation = depreciable / totalMonths;
        
        if (monthlyDepreciation > 0) {
          // Get current period (YYYY-MM format)
          const now = new Date();
          const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
          
          // Create depreciation journal entry
          const journalEntry = await JournalService.createDepreciationEntry(
            companyId,
            req.user.id,
            {
              amount: monthlyDepreciation,
              period: periodKey,
              date: new Date(now.getUTCFullYear(), now.getUTCMonth(), 1)
            }
          );
          
          // Update asset with depreciation entry reference
          await FixedAsset.findByIdAndUpdate(asset._id, {
            $push: {
              depreciationEntries: {
                journalEntryId: journalEntry._id,
                period: periodKey,
                amount: monthlyDepreciation,
                date: new Date(now.getUTCFullYear(), now.getUTCMonth(), 1)
              }
            }
          });
        }
      }
    } catch (deprError) {
      console.error('Error creating depreciation journal entry:', deprError);
      // Don't fail the asset creation if depreciation entry fails
    }

    res.status(201).json({ success: true, data: asset });
  } catch (error) {
    next(error);
  }
};

// @desc    Update fixed asset
// @route   PUT /api/fixed-assets/:id
// @access  Private
exports.updateFixedAsset = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    let asset = await FixedAsset.findOne({ _id: req.params.id, company: companyId });

    if (!asset) {
      return res.status(404).json({ success: false, message: 'Fixed asset not found' });
    }

    asset = await FixedAsset.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    res.json({ success: true, data: asset });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete fixed asset
// @route   DELETE /api/fixed-assets/:id
// @access  Private
exports.deleteFixedAsset = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const asset = await FixedAsset.findOne({ _id: req.params.id, company: companyId });

    if (!asset) {
      return res.status(404).json({ success: false, message: 'Fixed asset not found' });
    }

    await FixedAsset.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: 'Fixed asset deleted' });
  } catch (error) {
    next(error);
  }
};

// @desc    Get fixed assets summary for Balance Sheet
// @route   GET /api/fixed-assets/summary
// @access  Private
exports.getFixedAssetsSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Get all active assets
    const assets = await FixedAsset.find({ company: companyId, status: 'active' });

    // Group by category
    const byCategory = {
      equipment: { cost: 0, depreciation: 0, netValue: 0 },
      furniture: { cost: 0, depreciation: 0, netValue: 0 },
      vehicles: { cost: 0, depreciation: 0, netValue: 0 },
      buildings: { cost: 0, depreciation: 0, netValue: 0 },
      land: { cost: 0, depreciation: 0, netValue: 0 },
      computers: { cost: 0, depreciation: 0, netValue: 0 },
      machinery: { cost: 0, depreciation: 0, netValue: 0 },
      other: { cost: 0, depreciation: 0, netValue: 0 }
    };

    assets.forEach(asset => {
      const cat = asset.category || 'other';
      if (byCategory[cat]) {
        byCategory[cat].cost += asset.purchaseCost || 0;
        byCategory[cat].depreciation += asset.accumulatedDepreciation || 0;
        byCategory[cat].netValue += asset.netBookValue || 0;
      }
    });

    const totalCost = assets.reduce((sum, asset) => sum + (asset.purchaseCost || 0), 0);
    const totalDepreciation = assets.reduce((sum, asset) => sum + (asset.accumulatedDepreciation || 0), 0);
    const totalNetValue = assets.reduce((sum, asset) => sum + (asset.netBookValue || 0), 0);

    res.json({
      success: true,
      data: {
        byCategory,
        total: {
          cost: totalCost,
          depreciation: totalDepreciation,
          netValue: totalNetValue
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get depreciation preview for a period
// @route   GET /api/fixed-assets/depreciation-preview
// @access  Private
exports.getDepreciationPreview = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { period } = req.query;
    
    // Default to current month if not specified
    const periodDate = period ? new Date(period + '-01') : new Date();
    periodDate.setUTCDate(1); // First day of month
    
    const assetsData = await FixedAsset.getAssetsForDepreciation(companyId, periodDate);
    
    // Filter to only include assets that need depreciation and haven't been recorded
    const preview = assetsData
      .filter(item => item.monthlyDepreciation > 0)
      .map(item => ({
        assetId: item.asset._id,
        assetName: item.asset.name,
        assetCode: item.asset.assetCode,
        category: item.asset.category,
        monthlyDepreciation: item.monthlyDepreciation,
        alreadyRecorded: item.alreadyRecorded,
        accumulatedDepreciation: item.asset.accumulatedDepreciation,
        netBookValue: item.asset.netBookValue
      }));
    
    const totalDepreciation = preview.reduce((sum, item) => sum + item.monthlyDepreciation, 0);
    const alreadyRecordedCount = preview.filter(item => item.alreadyRecorded).length;
    
    res.json({
      success: true,
      data: {
        period: `${periodDate.getUTCFullYear()}-${String(periodDate.getUTCMonth() + 1).padStart(2, '0')}`,
        assets: preview,
        summary: {
          totalAssets: preview.length,
          alreadyRecorded: alreadyRecordedCount,
          pendingDepreciation: preview.length - alreadyRecordedCount,
          totalDepreciationAmount: totalDepreciation
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create monthly depreciation journal entries
// @route   POST /api/fixed-assets/run-depreciation
// @access  Private
exports.runDepreciation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { period, assetId } = req.body;
    
    // Default to current month if not specified
    const periodDate = period ? new Date(period + '-01') : new Date();
    periodDate.setUTCDate(1); // First day of month
    
    const periodKey = `${periodDate.getUTCFullYear()}-${String(periodDate.getUTCMonth() + 1).padStart(2, '0')}`;
    
    let assetsData;
    
    // If specific asset provided, only process that asset
    if (assetId) {
      const asset = await FixedAsset.findOne({ _id: assetId, company: companyId });
      if (!asset) {
        return res.status(404).json({ success: false, message: 'Asset not found' });
      }
      const monthlyAmount = asset.getMonthlyDepreciationAmount(periodDate);
      assetsData = [{
        asset,
        monthlyDepreciation: monthlyAmount,
        alreadyRecorded: (asset.depreciationEntries || []).some(entry => entry.period === periodKey)
      }];
    } else {
      // Get all assets for the company
      assetsData = await FixedAsset.getAssetsForDepreciation(companyId, periodDate);
    }
    
    const results = {
      created: [],
      skipped: [],
      errors: []
    };
    
    let totalDepreciation = 0;
    
    for (const item of assetsData) {
      // Skip if already recorded or no depreciation needed
      if (item.alreadyRecorded || item.monthlyDepreciation <= 0) {
        results.skipped.push({
          assetId: item.asset._id,
          assetName: item.asset.name,
          reason: item.alreadyRecorded ? 'Already recorded' : 'No depreciation needed'
        });
        continue;
      }
      
      try {
        // Create journal entry for depreciation
        const journalEntry = await JournalService.createDepreciationEntry(
          companyId,
          req.user.id,
          {
            amount: item.monthlyDepreciation,
            period: periodKey,
            date: periodDate
          }
        );
        
        // Update asset with depreciation entry reference
        await FixedAsset.findByIdAndUpdate(item.asset._id, {
          $push: {
            depreciationEntries: {
              journalEntryId: journalEntry._id,
              period: periodKey,
              amount: item.monthlyDepreciation,
              date: periodDate
            }
          }
        });
        
        results.created.push({
          assetId: item.asset._id,
          assetName: item.asset.name,
          amount: item.monthlyDepreciation,
          journalEntryId: journalEntry._id,
          entryNumber: journalEntry.entryNumber
        });
        
        totalDepreciation += item.monthlyDepreciation;
        
      } catch (err) {
        results.errors.push({
          assetId: item.asset._id,
          assetName: item.asset.name,
          error: err.message
        });
      }
    }
    
    res.json({
      success: true,
      data: {
        period: periodKey,
        results,
        summary: {
          createdCount: results.created.length,
          skippedCount: results.skipped.length,
          errorCount: results.errors.length,
          totalDepreciation
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get depreciation history for an asset
// @route   GET /api/fixed-assets/:id/depreciation-history
// @access  Private
exports.getDepreciationHistory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const asset = await FixedAsset.findOne({ _id: req.params.id, company: companyId });
    
    if (!asset) {
      return res.status(404).json({ success: false, message: 'Fixed asset not found' });
    }
    
    // Get journal entries for this asset's depreciation
    const journalEntries = await JournalEntry.find({
      company: companyId,
      sourceType: 'depreciation'
    }).sort({ date: -1 });
    
    // Filter and populate with journal entry details
    const depreciationHistory = (asset.depreciationEntries || []).map(entry => {
      const journalEntry = journalEntries.find(je => je._id.toString() === entry.journalEntryId?.toString());
      return {
        period: entry.period,
        amount: entry.amount,
        date: entry.date,
        journalEntryId: entry.journalEntryId,
        entryNumber: journalEntry?.entryNumber
      };
    });
    
    res.json({
      success: true,
      data: {
        asset: {
          _id: asset._id,
          name: asset.name,
          assetCode: asset.assetCode,
          purchaseCost: asset.purchaseCost,
          accumulatedDepreciation: asset.accumulatedDepreciation,
          netBookValue: asset.netBookValue
        },
        depreciationHistory: depreciationHistory.sort((a, b) => b.period.localeCompare(a.period))
      }
    });
  } catch (error) {
    next(error);
  }
};
