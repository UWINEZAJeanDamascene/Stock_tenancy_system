const InventoryBatch = require('../models/InventoryBatch');
const StockMovement = require('../models/StockMovement');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');

// @desc    Get all inventory batches
// @route   GET /api/stock/batches
// @access  Private
exports.getInventoryBatches = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { 
      page = 1, 
      limit = 20, 
      productId, 
      warehouseId, 
      status, 
      search,
      expiring,
      lowStock 
    } = req.query;

    const query = { company: companyId };

    // Only add to query if parameter is provided and not 'undefined' or empty string
    if (productId && productId !== 'undefined' && productId !== '') query.product = productId;
    if (warehouseId && warehouseId !== 'undefined' && warehouseId !== '') query.warehouse = warehouseId;
    if (status && status !== 'undefined' && status !== '') query.status = status;
    
    if (expiring === 'true') {
      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
      query.expiryDate = { $lte: thirtyDaysFromNow, $gte: new Date() };
    }

    if (lowStock === 'true') {
      query.availableQuantity = { $gt: 0, $lte: 10 };
    }

    // Search by product name or batch/lot number
    if (search) {
      const products = await Product.find({
        company: companyId,
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { sku: { $regex: search, $options: 'i' } }
        ]
      }).select('_id');

      const productIds = products.map(p => p._id);
      
      query.$or = [
        { product: { $in: productIds } },
        { batchNumber: { $regex: search, $options: 'i' } },
        { lotNumber: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await InventoryBatch.countDocuments(query);
    const batches = await InventoryBatch.find(query)
      .populate('product', 'name sku unit')
      .populate('warehouse', 'name code')
      .populate('supplier', 'name code')
      .sort({ expiryDate: 1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: batches.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: batches
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single inventory batch
// @route   GET /api/stock/batches/:id
// @access  Private
exports.getInventoryBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const batch = await InventoryBatch.findOne({ _id: req.params.id, company: companyId })
      .populate('product', 'name sku unit currentStock averageCost')
      .populate('warehouse', 'name code')
      .populate('supplier', 'name code contact')
      .populate('stockMovement');

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: 'Inventory batch not found'
      });
    }

    res.json({
      success: true,
      data: batch
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create inventory batch (receive stock)
// @route   POST /api/stock/batches
// @access  Private (admin, stock_manager)
exports.createInventoryBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      product: productId,
      warehouse: warehouseId,
      quantity,
      batchNumber,
      lotNumber,
      expiryDate,
      unitCost,
      supplier: supplierId,
      manufacturingDate,
      notes
    } = req.body;

    // Validate product exists
    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Validate warehouse exists
    const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId });
    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Check if batch with same batch/lot number already exists
    if (batchNumber || lotNumber) {
      const existingBatch = await InventoryBatch.findOne({
        company: companyId,
        product: productId,
        warehouse: warehouseId,
        batchNumber: batchNumber || { $exists: false },
        lotNumber: lotNumber || { $exists: false },
        status: { $nin: ['exhausted'] }
      });

      if (existingBatch) {
        // Add to existing batch
        existingBatch.quantity += quantity;
        existingBatch.availableQuantity += quantity;
        existingBatch.unitCost = unitCost || existingBatch.unitCost;
        existingBatch.totalCost = existingBatch.quantity * existingBatch.unitCost;
        existingBatch.updateStatus();
        await existingBatch.save();

        return res.status(200).json({
          success: true,
          message: 'Quantity added to existing batch',
          data: existingBatch
        });
      }
    }

    // Create new batch
    const batch = await InventoryBatch.create({
      company: companyId,
      product: productId,
      warehouse: warehouseId,
      quantity,
      availableQuantity: quantity,
      batchNumber,
      lotNumber,
      expiryDate,
      unitCost: unitCost || 0,
      totalCost: quantity * (unitCost || 0),
      supplier: supplierId,
      manufacturingDate,
      notes,
      status: 'active',
      createdBy: req.user.id
    });

    // Update product stock
    product.currentStock += quantity;
    if (unitCost) {
      const totalValue = (product.currentStock * product.averageCost) + (quantity * unitCost);
      product.averageCost = totalValue / product.currentStock;
    }
    product.lastSupplyDate = new Date();
    await product.save();

    // Create stock movement
    await StockMovement.create({
      company: companyId,
      product: productId,
      type: 'in',
      reason: 'purchase',
      quantity,
      previousStock: product.currentStock - quantity,
      newStock: product.currentStock,
      unitCost,
      totalCost: quantity * (unitCost || 0),
      supplier: supplierId,
      batchNumber,
      lotNumber,
      expiryDate,
      referenceType: 'purchase',
      notes: `Batch: ${batchNumber || 'N/A'}`,
      performedBy: req.user.id,
      movementDate: new Date()
    });

    await batch.populate([
      { path: 'product', select: 'name sku' },
      { path: 'warehouse', select: 'name code' }
    ]);

    res.status(201).json({
      success: true,
      message: 'Inventory batch created successfully',
      data: batch
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update inventory batch
// @route   PUT /api/stock/batches/:id
// @access  Private (admin, stock_manager)
exports.updateInventoryBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let batch = await InventoryBatch.findOne({ _id: req.params.id, company: companyId });

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: 'Inventory batch not found'
      });
    }

    // Prevent changing quantity through update (use consume/receive methods)
    const allowedFields = ['batchNumber', 'lotNumber', 'expiryDate', 'manufacturingDate', 'notes', 'status'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        batch[field] = req.body[field];
      }
    });

    await batch.save();

    res.json({
      success: true,
      data: batch
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Consume from inventory batch
// @route   POST /api/stock/batches/:id/consume
// @access  Private
exports.consumeFromBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { quantity, notes, referenceType, referenceNumber } = req.body;

    const batch = await InventoryBatch.findOne({ _id: req.params.id, company: companyId });

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: 'Inventory batch not found'
      });
    }

    if (batch.availableQuantity < quantity) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient quantity in batch',
        available: batch.availableQuantity,
        requested: quantity
      });
    }

    const product = await Product.findOne({ _id: batch.product, company: companyId });

    // Update batch
    batch.availableQuantity -= quantity;
    batch.updateStatus();
    await batch.save();

    // Update product stock
    if (product) {
      product.currentStock -= quantity;
      await product.save();
    }

    // Create stock movement
    await StockMovement.create({
      company: companyId,
      product: batch.product,
      type: 'out',
      reason: referenceType === 'sale' ? 'sale' : 'transfer',
      quantity,
      previousStock: (product?.currentStock || 0) + quantity,
      newStock: product?.currentStock || 0,
      unitCost: batch.unitCost,
      totalCost: quantity * batch.unitCost,
      batchNumber: batch.batchNumber,
      lotNumber: batch.lotNumber,
      expiryDate: batch.expiryDate,
      referenceType,
      referenceNumber,
      notes,
      performedBy: req.user.id,
      movementDate: new Date()
    });

    res.json({
      success: true,
      message: 'Stock consumed successfully',
      data: batch
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get expiring batches
// @route   GET /api/stock/batches/expiring
// @access  Private
exports.getExpiringBatches = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { days = 30 } = req.query;

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(days));

    const batches = await InventoryBatch.find({
      company: companyId,
      expiryDate: { $gte: new Date(), $lte: futureDate },
      status: { $nin: ['exhausted'] },
      availableQuantity: { $gt: 0 }
    })
      .populate('product', 'name sku unit')
      .populate('warehouse', 'name code')
      .sort({ expiryDate: 1 });

    res.json({
      success: true,
      count: batches.length,
      data: batches
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get batch history for product
// @route   GET /api/stock/batches/product/:productId
// @access  Private
exports.getProductBatches = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { productId } = req.params;
    const { warehouseId } = req.query;

    const query = {
      company: companyId,
      product: productId,
      status: { $nin: ['exhausted'] },
      availableQuantity: { $gt: 0 }
    };

    if (warehouseId) {
      query.warehouse = warehouseId;
    }

    const batches = await InventoryBatch.find(query)
      .populate('warehouse', 'name code')
      .populate('supplier', 'name code')
      .sort({ expiryDate: 1, receivedDate: -1 });

    res.json({
      success: true,
      count: batches.length,
      data: batches
    });
  } catch (error) {
    next(error);
  }
};
