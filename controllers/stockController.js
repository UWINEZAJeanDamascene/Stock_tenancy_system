const StockMovement = require('../models/StockMovement');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');

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
      data: movement
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

    if (type === 'in') {
      newStock = previousStock + quantity;
    } else if (type === 'out') {
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

    res.status(201).json({
      success: true,
      message: 'Stock adjusted successfully',
      data: movement
    });
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
