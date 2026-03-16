const FixedAsset = require('../models/FixedAsset');
const JournalService = require('../services/journalService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
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
        paymentMethod: asset.paymentMethod || 'cash',
        bankAccountCode: asset.bankAccountCode
      });
    } catch (journalError) {
      console.error('Error creating journal entry for asset purchase:', journalError);
      // Don't fail the asset creation if journal entry fails
    }

    // =====================================================
    // AUTOMATIC DEPRECIATION - Create depreciation for purchase month and all months until now
    // =====================================================
    try {
      // Check if asset has depreciation settings
      if (asset.usefulLifeYears && asset.usefulLifeYears > 0) {
        const annualDepreciation = asset.annualDepreciation || 0;
        const monthlyDepreciation = annualDepreciation / 12;
        
        if (monthlyDepreciation > 0) {
          const now = new Date();
          const purchaseDate = new Date(asset.purchaseDate);
          
          // Calculate depreciation start date (first of purchase month)
          const depStartDate = new Date(Date.UTC(purchaseDate.getUTCFullYear(), purchaseDate.getUTCMonth(), 1));
          const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
          
          let totalDepreciation = 0;
          let currentDepMonth = new Date(depStartDate);
          
          // Create depreciation for each month from purchase to current month
          while (currentDepMonth <= currentMonth) {
            const monthLabel = `${currentDepMonth.getUTCFullYear()}-${String(currentDepMonth.getUTCMonth() + 1).padStart(2, '0')}`;
            
            // Check if depreciation entry already exists for this period
            const existingEntry = await JournalEntry.findOne({
              company: companyId,
              sourceType: 'depreciation',
              sourceId: asset._id,
              description: { $regex: new RegExp(monthLabel, 'i') }
            });
            
            if (!existingEntry) {
              // Create depreciation journal entry
              // Debit: Depreciation Expense (5800)
              // Credit: Accumulated Depreciation (1800)
              await JournalService.createEntry(companyId, req.user.id, {
                date: new Date(currentDepMonth),
                description: `Depreciation - ${asset.name} - ${monthLabel}`,
                sourceType: 'depreciation',
                sourceId: asset._id,
                sourceReference: asset.assetCode,
                lines: [
                  JournalService.createDebitLine(
                    DEFAULT_ACCOUNTS.depreciation,
                    monthlyDepreciation,
                    `Depreciation: ${asset.name}`
                  ),
                  JournalService.createCreditLine(
                    DEFAULT_ACCOUNTS.accumulatedDepreciation,
                    monthlyDepreciation,
                    `Accumulated depreciation: ${asset.name}`
                  )
                ],
                isAutoGenerated: true
              });
              
              totalDepreciation += monthlyDepreciation;
            }
            
            // Move to next month
            currentDepMonth = new Date(Date.UTC(
              currentDepMonth.getUTCFullYear(),
              currentDepMonth.getUTCMonth() + 1,
              1
            ));
          }
          
          // Update asset's accumulated depreciation
          if (totalDepreciation > 0) {
            asset.accumulatedDepreciation = (asset.accumulatedDepreciation || 0) + totalDepreciation;
            await asset.save();
          }
          
          console.log(`✅ Automatic depreciation created for ${asset.name}: ${totalDepreciation}`);
        }
      }
    } catch (deprError) {
      console.error('Error creating automatic depreciation:', deprError);
      // Don't fail the asset creation if depreciation fails
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
