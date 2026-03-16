const StockAudit = require('../models/StockAudit');
const InventoryBatch = require('../models/InventoryBatch');
const SerialNumber = require('../models/SerialNumber');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Warehouse = require('../models/Warehouse');
const StockMovement = require('../models/StockMovement');
const JournalService = require('../services/journalService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');

// @desc    Get all stock audits
// @route   GET /api/stock/audits
// @access  Private
exports.getStockAudits = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, status, type, warehouseId } = req.query;

    const query = { company: companyId };

    if (status) query.status = status;
    if (type) query.type = type;
    if (warehouseId) query.warehouse = warehouseId;

    const total = await StockAudit.countDocuments(query);
    const audits = await StockAudit.find(query)
      .populate('warehouse', 'name code')
      .populate('category', 'name')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: audits.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: audits
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single stock audit
// @route   GET /api/stock/audits/:id
// @access  Private
exports.getStockAudit = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const audit = await StockAudit.findOne({ _id: req.params.id, company: companyId })
      .populate('warehouse', 'name code')
      .populate('category', 'name')
      .populate('items.product', 'name sku unit')
      .populate('items.countedBy', 'name')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    if (!audit) {
      return res.status(404).json({
        success: false,
        message: 'Stock audit not found'
      });
    }

    res.json({
      success: true,
      data: audit
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create stock audit
// @route   POST /api/stock/audits
// @access  Private (admin, stock_manager)
exports.createStockAudit = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      warehouse: warehouseId,
      category: categoryId,
      type,
      startDate,
      dueDate,
      notes
    } = req.body;

    // Validate warehouse if provided
    if (warehouseId) {
      const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId });
      if (!warehouse) {
        return res.status(404).json({ success: false, message: 'Warehouse not found' });
      }
    }

    // Validate category if provided
    if (categoryId) {
      const category = await Category.findOne({ _id: categoryId, company: companyId });
      if (!category) {
        return res.status(404).json({ success: false, message: 'Category not found' });
      }
    }

    // Get products to audit
    const productQuery = { company: companyId, isArchived: false };
    if (categoryId) productQuery.category = categoryId;

    const products = await Product.find(productQuery).select('_id name sku currentStock');
    
    // Get current stock for each product in the warehouse
    const auditItems = [];
    
    for (const product of products) {
      let systemQuantity = 0;
      
      if (warehouseId) {
        // Get stock from specific warehouse
        const batches = await InventoryBatch.find({
          company: companyId,
          product: product._id,
          warehouse: warehouseId,
          status: { $nin: ['exhausted'] }
        });
        systemQuantity = batches.reduce((sum, b) => sum + b.availableQuantity, 0);
      } else {
        // Get total stock across all warehouses
        systemQuantity = product.currentStock || 0;
      }

      auditItems.push({
        product: product._id,
        systemQuantity,
        countedQuantity: 0, // To be filled during audit
        variance: 0,
        status: 'pending'
      });
    }

    // Ensure auditNumber is present before creation (some mongoose setups may validate before pre-save hooks)
    const count = await StockAudit.countDocuments({ company: companyId });
    const auditNumber = `AUD-${String(count + 1).padStart(6, '0')}`;

    const audit = await StockAudit.create({
      company: companyId,
      auditNumber,
      warehouse: warehouseId,
      category: categoryId,
      type: type || 'cycle_count',
      startDate: startDate || new Date(),
      dueDate,
      notes,
      items: auditItems,
      status: 'draft',
      createdBy: req.user.id
    });

    // Calculate and persist summary statistics so listing endpoints show totals immediately
    audit.calculateSummary();
    await audit.save();

    await audit.populate([
      { path: 'warehouse', select: 'name code' },
      { path: 'category', select: 'name' },
      { path: 'items.product', select: 'name sku' }
    ]);

    res.status(201).json({
      success: true,
      message: `Stock audit created with ${auditItems.length} products`,
      data: audit
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update audit item (record count)
// @route   PUT /api/stock/audits/:id/items/:itemId
// @access  Private
exports.updateAuditItem = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { countedQuantity, notes } = req.body;

    const audit = await StockAudit.findOne({ _id: req.params.id, company: companyId });

    if (!audit) {
      return res.status(404).json({ success: false, message: 'Stock audit not found' });
    }

    if (audit.status === 'completed' || audit.status === 'cancelled') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot modify completed or cancelled audit' 
      });
    }

    const item = audit.items.id(req.params.itemId);

    if (!item) {
      return res.status(404).json({ success: false, message: 'Audit item not found' });
    }

    item.countedQuantity = countedQuantity;
    item.variance = countedQuantity - item.systemQuantity;
    item.countedBy = req.user.id;
    item.countedDate = new Date();
    item.notes = notes;
    item.status = 'verified';

    // Update audit status to in_progress
    if (audit.status === 'draft') {
      audit.status = 'in_progress';
    }

    audit.calculateSummary();
    await audit.save();

    res.json({
      success: true,
      message: 'Audit item updated',
      data: audit
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Complete stock audit and adjust stock
// @route   POST /api/stock/audits/:id/complete
// @access  Private (admin)
exports.completeStockAudit = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { adjustStock = true, approvedNotes } = req.body;

    const audit = await StockAudit.findOne({ _id: req.params.id, company: companyId });

    if (!audit) {
      return res.status(404).json({ success: false, message: 'Stock audit not found' });
    }

    if (audit.status === 'completed' || audit.status === 'cancelled') {
      return res.status(400).json({ 
        success: false, 
        message: 'Audit already completed or cancelled' 
      });
    }

    // Check if all items are counted
    const pendingItems = audit.items.filter(item => item.status === 'pending');
    if (pendingItems.length > 0 && adjustStock) {
      return res.status(400).json({
        success: false,
        message: `Please count all ${pendingItems.length} remaining items before completing`,
        pendingCount: pendingItems.length
      });
    }

    // Adjust stock if requested
    if (adjustStock) {
      // Collect all adjustments for journal entries
      const positiveAdjustments = []; // surplus
      const negativeAdjustments = []; // shortage
      
      for (const item of audit.items) {
        if (item.variance === 0) continue;

        const product = await Product.findOne({ _id: item.product, company: companyId });
        if (!product) continue;

        const previousStock = product.currentStock;
        product.currentStock = item.countedQuantity;
        
        // Calculate new average cost based on existing batches
        const batches = await InventoryBatch.find({
          company: companyId,
          product: item.product,
          status: { $nin: ['exhausted'] }
        });
        
        if (batches.length > 0) {
          const totalValue = batches.reduce((sum, b) => sum + (b.availableQuantity * b.unitCost), 0);
          product.averageCost = totalValue / item.countedQuantity;
        }
        
        await product.save();

        // Create stock movement for adjustment
        await StockMovement.create({
          company: companyId,
          product: item.product,
          type: item.variance > 0 ? 'in' : 'out',
          reason: 'correction',
          quantity: Math.abs(item.variance),
          previousStock,
          newStock: item.countedQuantity,
          referenceType: 'adjustment',
          notes: `Audit #${audit.auditNumber}: Counted: ${item.countedQuantity}, System: ${item.systemQuantity}, Variance: ${item.variance}`,
          performedBy: req.user.id,
          movementDate: new Date()
        });

        // Calculate adjustment value
        const adjustmentValue = Math.abs(item.variance) * (product.averageCost || 0);
        
        if (item.variance > 0) {
          // Surplus: found more than system - DR Inventory, CR Other Income
          positiveAdjustments.push({
            productName: product.name,
            value: adjustmentValue
          });
        } else {
          // Shortage: found less than system - DR Stock Adjustment Loss, CR Inventory
          negativeAdjustments.push({
            productName: product.name,
            value: adjustmentValue
          });
        }

        // Update batch quantities if warehouse specified
        if (audit.warehouse) {
          const batches = await InventoryBatch.find({
            company: companyId,
            product: item.product,
            warehouse: audit.warehouse,
            status: { $nin: ['exhausted'] }
          });

          // Adjust first batch (simplified - in production, would need more sophisticated logic)
          if (batches.length > 0) {
            batches[0].availableQuantity = item.countedQuantity;
            batches[0].quantity = item.countedQuantity;
            batches[0].updateStatus();
            await batches[0].save();
          }
        }

        // Update item status
        item.status = 'adjusted';
      }

      // Create journal entry for surplus (positive variance)
      if (positiveAdjustments.length > 0) {
        const totalPositiveValue = positiveAdjustments.reduce((sum, adj) => sum + adj.value, 0);
        const lines = [];
        
        lines.push(JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.inventory,
          totalPositiveValue,
          `Stock Audit #${audit.auditNumber} - Surplus adjustment`
        ));
        lines.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.otherIncome,
          totalPositiveValue,
          `Stock Audit #${audit.auditNumber} - Surplus adjustment`
        ));

        try {
          await JournalService.createEntry(companyId, req.user.id, {
            date: new Date(),
            description: `Stock Audit #${audit.auditNumber} - Surplus adjustment`,
            sourceType: 'stock_adjustment',
            sourceId: audit._id,
            lines,
            isAutoGenerated: true
          });
        } catch (journalError) {
          console.error('Error creating journal entry for audit surplus:', journalError);
        }
      }

      // Create journal entry for shortage (negative variance)
      if (negativeAdjustments.length > 0) {
        const totalNegativeValue = negativeAdjustments.reduce((sum, adj) => sum + adj.value, 0);
        const lines = [];
        
        lines.push(JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.stockAdjustmentLoss,
          totalNegativeValue,
          `Stock Audit #${audit.auditNumber} - Shortage adjustment`
        ));
        lines.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.inventory,
          totalNegativeValue,
          `Stock Audit #${audit.auditNumber} - Shortage adjustment`
        ));

        try {
          await JournalService.createEntry(companyId, req.user.id, {
            date: new Date(),
            description: `Stock Audit #${audit.auditNumber} - Shortage adjustment`,
            sourceType: 'stock_adjustment',
            sourceId: audit._id,
            lines,
            isAutoGenerated: true
          });
        } catch (journalError) {
          console.error('Error creating journal entry for audit shortage:', journalError);
        }
      }
    }

    audit.status = 'completed';
    audit.completedDate = new Date();
    audit.approvedBy = req.user.id;
    audit.approvedDate = new Date();
    audit.notes = `${audit.notes || ''}\nCompletion notes: ${approvedNotes || 'None'}`;
    audit.calculateSummary();
    await audit.save();

    res.json({
      success: true,
      message: 'Stock audit completed and stock adjusted',
      data: audit
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel stock audit
// @route   POST /api/stock/audits/:id/cancel
// @access  Private (admin)
exports.cancelStockAudit = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const audit = await StockAudit.findOne({ _id: req.params.id, company: companyId });

    if (!audit) {
      return res.status(404).json({ success: false, message: 'Stock audit not found' });
    }

    if (audit.status === 'completed') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot cancel completed audit' 
      });
    }

    audit.status = 'cancelled';
    audit.notes = `${audit.notes || ''}\nCancellation reason: ${reason || 'Not specified'}`;
    await audit.save();

    res.json({
      success: true,
      message: 'Stock audit cancelled',
      data: audit
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get audit variance summary
// @route   GET /api/stock/audits/:id/variance
// @access  Private
exports.getAuditVariance = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const audit = await StockAudit.findOne({ _id: req.params.id, company: companyId })
      .populate('items.product', 'name sku averageCost');

    if (!audit) {
      return res.status(404).json({ success: false, message: 'Stock audit not found' });
    }

    // Calculate variance summary
    const positiveVariance = audit.items.filter(i => i.variance > 0);
    const negativeVariance = audit.items.filter(i => i.variance < 0);
    const noVariance = audit.items.filter(i => i.variance === 0);

    const varianceSummary = {
      totalItems: audit.items.length,
      positiveVarianceCount: positiveVariance.length,
      negativeVarianceCount: negativeVariance.length,
      noVarianceCount: noVariance.length,
      totalPositiveValue: 0,
      totalNegativeValue: 0,
      items: audit.items.map(item => ({
        product: item.product,
        systemQuantity: item.systemQuantity,
        countedQuantity: item.countedQuantity,
        variance: item.variance,
        estimatedValue: item.variance * (item.product?.averageCost || 0)
      }))
    };

    // Calculate values
    for (const item of positiveVariance) {
      const cost = item.product?.averageCost || 0;
      varianceSummary.totalPositiveValue += item.variance * cost;
    }

    for (const item of negativeVariance) {
      const cost = item.product?.averageCost || 0;
      varianceSummary.totalNegativeValue += Math.abs(item.variance) * cost;
    }

    res.json({
      success: true,
      data: varianceSummary
    });
  } catch (error) {
    next(error);
  }
};
