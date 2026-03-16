const StockMovement = require('../models/StockMovement');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Warehouse = require('../models/Warehouse');
const InventoryBatch = require('../models/InventoryBatch');
const JournalService = require('../services/journalService');

// @desc    Get all stock movements
// @route   GET /api/stock/movements
// @access  Private
exports.getStockMovements = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      page = 1,
      limit = 20,
      type,
      reason,
      productId,
      supplierId,
      startDate,
      endDate,
      search
    } = req.query;

    const query = { company: companyId };

    // Search by product name
    if (search && search.trim()) {
      const products = await Product.find({
        name: { $regex: search, $options: 'i' },
        company: companyId
      }).select('_id');
      
      if (products.length > 0) {
        const productIds = products.map(p => p._id);
        query.product = { $in: productIds };
      }
    }

    if (type) query.type = type;
    if (reason) query.reason = reason;
    if (productId) query.product = productId;
    if (supplierId) query.supplier = supplierId;

    if (startDate || endDate) {
      query.movementDate = {};
      if (startDate) query.movementDate.$gte = new Date(startDate);
      if (endDate) query.movementDate.$lte = new Date(endDate);
    }

    const total = await StockMovement.countDocuments(query);
    const movements = await StockMovement.find(query)
      .populate('product', 'name sku unit')
      .populate('supplier', 'name code')
      .populate('performedBy', 'name email')
      .sort({ movementDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: movements.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: movements
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single stock movement
// @route   GET /api/stock/movements/:id
// @access  Private
exports.getStockMovement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const movement = await StockMovement.findOne({ _id: req.params.id, company: companyId })
      .populate('product', 'name sku unit')
      .populate('supplier', 'name code contact')
      .populate('performedBy', 'name email');

    if (!movement) {
      return res.status(404).json({
        success: false,
        message: 'Stock movement not found'
      });
    }

    res.json({
      success: true,
      data: movement
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Receive stock from supplier
// @route   POST /api/stock/movements
// @access  Private (admin, stock_manager)
exports.receiveStock = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      product: productId,
      quantity,
      unitCost,
      supplier: supplierId,
      batchNumber,
      lotNumber,
      expiryDate,
      warehouse: warehouseId,
      notes
    } = req.body;

    // Get product
    const product = await Product.findOne({ _id: productId, company: companyId });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Get or create default warehouse if not specified
    let warehouse = null;
    if (warehouseId) {
      warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId });
      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: 'Warehouse not found'
        });
      }
    } else {
      // Try to get default warehouse
      warehouse = await Warehouse.findOne({ company: companyId, isDefault: true });
      // If no default, get first available
      if (!warehouse) {
        warehouse = await Warehouse.findOne({ company: companyId, isActive: true });
      }
    }

    // If product tracks batches, create or update batch
    let batch = null;
    if (product.trackBatch || batchNumber || lotNumber) {
      // Try to find existing batch
      const batchQuery = {
        company: companyId,
        product: productId,
        warehouse: warehouse?._id,
        status: { $nin: ['exhausted', 'expired'] }
      };
      
      if (batchNumber) batchQuery.batchNumber = batchNumber;
      if (lotNumber) batchQuery.lotNumber = lotNumber;
      
      batch = await InventoryBatch.findOne(batchQuery);
      
      if (batch) {
        // Add to existing batch
        batch.quantity += quantity;
        batch.availableQuantity += quantity;
        batch.unitCost = unitCost || batch.unitCost;
        batch.totalCost = batch.quantity * batch.unitCost;
        batch.updateStatus();
        await batch.save();
      } else {
        // Create new batch
        batch = await InventoryBatch.create({
          company: companyId,
          product: productId,
          warehouse: warehouse?._id,
          quantity,
          availableQuantity: quantity,
          batchNumber,
          lotNumber,
          expiryDate,
          unitCost: unitCost || 0,
          totalCost: quantity * (unitCost || 0),
          supplier: supplierId,
          status: 'active',
          createdBy: req.user.id
        });
      }
    }

    const previousStock = product.currentStock;
    const newStock = previousStock + quantity;

    // Create stock movement
    const movement = await StockMovement.create({
      company: companyId,
      product: productId,
      type: 'in',
      reason: 'purchase',
      quantity,
      previousStock,
      newStock,
      unitCost,
      totalCost: quantity * unitCost,
      supplier: supplierId,
      batchNumber,
      lotNumber,
      expiryDate,
      referenceType: 'purchase_order',
      warehouse: warehouse?._id,
      notes,
      performedBy: req.user.id,
      movementDate: new Date()
    });

    // Update product stock and average cost
    const totalValue = (product.currentStock * product.averageCost) + (quantity * unitCost);
    product.currentStock = newStock;
    product.averageCost = totalValue / newStock;
    product.lastSupplyDate = new Date();
    
    // Link product to supplier if supplier is provided
    if (supplierId) {
      product.supplier = supplierId;
    }

    await product.save();

    // Update supplier if provided
    if (supplierId) {
      const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
      if (supplier) {
        // Add product to supplier's productsSupplied if not already present
        const productObjId = product._id;
        const isProductAlreadyLinked = supplier.productsSupplied.some(
          (p) => p.toString() === productObjId.toString()
        );
        
        if (!isProductAlreadyLinked) {
          supplier.productsSupplied.push(productObjId);
        }
        
        // Update total purchases and last purchase date
        supplier.totalPurchases = (supplier.totalPurchases || 0) + (quantity * unitCost);
        supplier.lastPurchaseDate = new Date();
        
        await supplier.save();
      }
    }

    res.status(201).json({
      success: true,
      message: 'Stock received successfully',
      data: {
        ...movement.toObject(),
        warehouse: warehouse ? { _id: warehouse._id, name: warehouse.name } : null,
        batch: batch ? { _id: batch._id, batchNumber: batch.batchNumber } : null
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Adjust stock (damage, loss, correction)
// @route   POST /api/stock/adjust
// @access  Private (admin, stock_manager)
exports.adjustStock = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      product: productId,
      quantity,
      reason,
      type,
      notes
    } = req.body;

    // Validate reason
    const validReasons = ['damage', 'loss', 'theft', 'expired', 'correction', 'transfer'];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid adjustment reason'
      });
    }

    // Get product
    const product = await Product.findOne({ _id: productId, company: companyId });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const previousStock = product.currentStock;
    let newStock;

    console.log(`[STOCK ADJUSTMENT] Type: ${type}, Quantity: ${quantity}, Previous Stock: ${previousStock}`);

    if (type === 'in') {
      newStock = previousStock + quantity;
      console.log(`[STOCK ADJUSTMENT] Processing IN - adding ${quantity} to get ${newStock}`);
    } else if (type === 'out') {
      console.log(`[STOCK ADJUSTMENT] Processing OUT - checking quantity: ${quantity}`);
      if (quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Quantity must be greater than 0'
        });
      }
      if (quantity > previousStock) {
        return res.status(400).json({
          success: false,
          message: 'Adjustment quantity exceeds current stock'
        });
      }
      newStock = previousStock - quantity;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid adjustment type'
      });
    }

    console.log(`[STOCK ADJUSTMENT] New Stock calculated: ${newStock}`);

    // Create stock movement
    const movement = await StockMovement.create({
      company: companyId,
      product: productId,
      type: 'adjustment',
      reason,
      quantity,
      previousStock,
      newStock,
      referenceType: 'adjustment',
      notes,
      performedBy: req.user.id,
      movementDate: new Date()
    });

    // Update product stock
    product.currentStock = newStock;
    await product.save();

    console.log(`[STOCK ADJUSTMENT] Product stock updated to: ${newStock}`);

    // Create journal entry for stock adjustment
    try {
      const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
      const adjustmentValue = quantity * (product.averageCost || 0);
      
      // Skip journal entry if adjustment value is 0
      if (adjustmentValue <= 0) {
        console.warn(`Stock adjustment skipped: Product ${product.name} has no average cost (${product.averageCost}), journal entry not created`);
      } else {
        const lines = [];
        
        if (type === 'in') {
          // Stock surplus (found more than system): Debit Inventory, Credit Other Income
          lines.push(JournalService.createDebitLine(
            DEFAULT_ACCOUNTS.inventory,
            adjustmentValue,
            `Stock Adjustment IN - ${product.name} - ${reason}`
          ));
          lines.push(JournalService.createCreditLine(
            DEFAULT_ACCOUNTS.otherIncome,
            adjustmentValue,
            `Stock Adjustment IN - ${product.name} - ${reason}`
          ));
        } else {
          // Stock shortage (found less than system): Debit Stock Adjustment Loss, Credit Inventory
          lines.push(JournalService.createDebitLine(
            DEFAULT_ACCOUNTS.stockAdjustmentLoss,
            adjustmentValue,
            `Stock Adjustment OUT - ${product.name} - ${reason}`
          ));
          lines.push(JournalService.createCreditLine(
            DEFAULT_ACCOUNTS.inventory,
            adjustmentValue,
            `Stock Adjustment OUT - ${product.name} - ${reason}`
          ));
        }
        
        await JournalService.createEntry(companyId, req.user.id, {
          date: new Date(),
          description: `Stock Adjustment ${type === 'in' ? 'IN' : 'OUT'} - ${product.name} - ${reason}`,
          sourceType: 'stock_adjustment',
          sourceId: movement._id,
          lines,
          isAutoGenerated: true
        });
        console.log(`Stock adjustment journal entry created: ${type === 'in' ? 'Surplus' : 'Shortage'} - ${adjustmentValue}`);
      }
    } catch (journalError) {
      console.error('Error creating journal entry for stock adjustment:', journalError);
      // Don't fail the adjustment if journal entry fails
    }

    res.status(201).json({
      success: true,
      message: 'Stock adjusted successfully',
      data: movement
    });
    console.log(`[STOCK ADJUSTMENT] Response sent successfully`);
  } catch (error) {
    next(error);
  }
};

// @desc    Get stock movements for a specific product
// @route   GET /api/stock/product/:productId/movements
// @access  Private
exports.getProductStockMovements = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { productId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const total = await StockMovement.countDocuments({ product: productId, company: companyId });
    const movements = await StockMovement.find({ product: productId, company: companyId })
      .populate('supplier', 'name code')
      .populate('performedBy', 'name email')
      .sort({ movementDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: movements.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: movements
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get stock summary
// @route   GET /api/stock/summary
// @access  Private
exports.getStockSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const products = await Product.find({ isArchived: false, company: companyId })
      .populate('category', 'name');

    const totalProducts = products.length;
    const totalStockValue = products.reduce(
      (sum, product) => sum + (product.currentStock * product.averageCost),
      0
    );
    const lowStockProducts = products.filter(
      product => product.currentStock <= product.lowStockThreshold
    ).length;
    const outOfStockProducts = products.filter(
      product => product.currentStock === 0
    ).length;

    // Stock by category
    const stockByCategory = products.reduce((acc, product) => {
      const categoryName = product.category?.name || 'Uncategorized';
      if (!acc[categoryName]) {
        acc[categoryName] = {
          count: 0,
          totalValue: 0,
          totalQuantity: 0
        };
      }
      acc[categoryName].count += 1;
      acc[categoryName].totalValue += product.currentStock * product.averageCost;
      acc[categoryName].totalQuantity += product.currentStock;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        totalProducts,
        totalStockValue,
        lowStockProducts,
        outOfStockProducts,
        stockByCategory
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a stock movement and revert product stock
// @route   DELETE /api/stock/movements/:id
// @access  Private (admin, stock_manager)
exports.deleteStockMovement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const movement = await StockMovement.findOne({ _id: req.params.id, company: companyId });

    if (!movement) {
      return res.status(404).json({ success: false, message: 'Stock movement not found' });
    }

    // Revert product stock if possible
    const product = await Product.findOne({ _id: movement.product, company: companyId });
    if (product) {
      product.currentStock = movement.previousStock;
      await product.save();
    }

    await movement.deleteOne();

    res.json({ success: true, message: 'Stock movement deleted and product stock reverted', data: movement });
  } catch (error) {
    next(error);
  }
};

// @desc    Update stock movement metadata
// @route   PUT /api/stock/movements/:id
// @access  Private (admin, stock_manager)
exports.updateStockMovement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const movement = await StockMovement.findOne({ _id: req.params.id, company: companyId });

    if (!movement) {
      return res.status(404).json({ success: false, message: 'Stock movement not found' });
    }

    // Only allow editing of safe metadata fields
    const allowed = [
      'notes', 'referenceNumber', 'referenceType', 'batchNumber', 'lotNumber', 'expiryDate', 'unitCost', 'totalCost', 'supplier', 'movementDate'
    ];

    allowed.forEach(field => {
      if (req.body[field] !== undefined) {
        movement[field] = req.body[field];
      }
    });

    await movement.save();

    res.json({ success: true, data: movement });
  } catch (error) {
    next(error);
  }
};
