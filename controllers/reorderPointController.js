const ReorderPoint = require('../models/ReorderPoint');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');

// @desc    Get all reorder points
// @route   GET /api/stock/reorder-points
// @access  Private
exports.getReorderPoints = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, productId, supplierId, isActive } = req.query;

    const query = { company: companyId };

    if (productId) query.product = productId;
    if (supplierId) query.supplier = supplierId;
    if (isActive !== undefined) query.isActive = isActive === 'true';

    const total = await ReorderPoint.countDocuments(query);
    const reorderPoints = await ReorderPoint.find(query)
      .populate('product', 'name sku currentStock averageCost lowStockThreshold')
      .populate('supplier', 'name code contact')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Add current stock and status to each reorder point
    const reorderPointsWithStatus = await Promise.all(
      reorderPoints.map(async (rp) => {
        const product = await Product.findById(rp.product._id);
        const currentStock = product?.currentStock || 0;
        
        return {
          ...rp.toObject(),
          currentStock,
          needsReorder: currentStock <= rp.reorderPoint,
          belowSafetyStock: currentStock <= rp.safetyStock
        };
      })
    );

    res.json({
      success: true,
      count: reorderPoints.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: reorderPointsWithStatus
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single reorder point
// @route   GET /api/stock/reorder-points/:id
// @access  Private
exports.getReorderPoint = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const reorderPoint = await ReorderPoint.findOne({ _id: req.params.id, company: companyId })
      .populate('product', 'name sku currentStock averageCost lowStockThreshold')
      .populate('supplier', 'name code contact email phone');

    if (!reorderPoint) {
      return res.status(404).json({
        success: false,
        message: 'Reorder point not found'
      });
    }

    res.json({
      success: true,
      data: reorderPoint
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create reorder point
// @route   POST /api/stock/reorder-points
// @access  Private (admin, stock_manager)
exports.createReorderPoint = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      product: productId,
      supplier: supplierId,
      reorderPoint,
      reorderQuantity,
      safetyStock,
      maxStock,
      leadTimeDays,
      estimatedUnitCost,
      autoReorder,
      notes
    } = req.body;

    // Validate product exists
    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Validate supplier exists
    const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    // Check if reorder point already exists for this product
    const existing = await ReorderPoint.findOne({
      company: companyId,
      product: productId,
      isActive: true
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Active reorder point already exists for this product. Please update the existing one.'
      });
    }

    const reorder = await ReorderPoint.create({
      company: companyId,
      product: productId,
      supplier: supplierId,
      reorderPoint,
      reorderQuantity: reorderQuantity || reorderPoint * 2,
      safetyStock: safetyStock || 0,
      maxStock,
      leadTimeDays: leadTimeDays || 7,
      estimatedUnitCost: estimatedUnitCost || product.averageCost,
      autoReorder: autoReorder || false,
      notes,
      createdBy: req.user.id
    });

    // Update product with reorder settings
    product.reorderPoint = reorderPoint;
    product.reorderQuantity = reorderQuantity || reorderPoint * 2;
    product.preferredSupplier = supplierId;
    await product.save();

    // Link product to supplier
    if (!supplier.productsSupplied.includes(productId)) {
      supplier.productsSupplied.push(productId);
      await supplier.save();
    }

    await reorder.populate([
      { path: 'product', select: 'name sku' },
      { path: 'supplier', select: 'name code' }
    ]);

    res.status(201).json({
      success: true,
      message: 'Reorder point created successfully',
      data: reorder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update reorder point
// @route   PUT /api/stock/reorder-points/:id
// @access  Private (admin, stock_manager)
exports.updateReorderPoint = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let reorderPoint = await ReorderPoint.findOne({ _id: req.params.id, company: companyId });

    if (!reorderPoint) {
      return res.status(404).json({
        success: false,
        message: 'Reorder point not found'
      });
    }

    // If supplier changed, validate new supplier
    if (req.body.supplier && req.body.supplier !== reorderPoint.supplier.toString()) {
      const supplier = await Supplier.findOne({ 
        _id: req.body.supplier, 
        company: companyId 
      });
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
      }
    }

    const allowedFields = [
      'supplier', 'reorderPoint', 'reorderQuantity', 'safetyStock', 
      'maxStock', 'leadTimeDays', 'estimatedUnitCost', 'autoReorder', 
      'isActive', 'notes'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        reorderPoint[field] = req.body[field];
      }
    });

    await reorderPoint.save();

    res.json({
      success: true,
      data: reorderPoint
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete reorder point
// @route   DELETE /api/stock/reorder-points/:id
// @access  Private (admin)
exports.deleteReorderPoint = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const reorderPoint = await ReorderPoint.findOne({ _id: req.params.id, company: companyId });

    if (!reorderPoint) {
      return res.status(404).json({
        success: false,
        message: 'Reorder point not found'
      });
    }

    await reorderPoint.deleteOne();

    res.json({
      success: true,
      message: 'Reorder point deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get products needing reorder
// @route   GET /api/stock/reorder-points/needing-reorder
// @access  Private
exports.getProductsNeedingReorder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const reorderPoints = await ReorderPoint.find({ 
      company: companyId, 
      isActive: true 
    })
      .populate('product', 'name sku currentStock averageCost')
      .populate('supplier', 'name code contact email phone');

    const productsNeedingReorder = [];

    for (const rp of reorderPoints) {
      const currentStock = rp.product.currentStock || 0;
      
      if (currentStock <= rp.reorderPoint) {
        productsNeedingReorder.push({
          reorderPoint: rp._id,
          product: rp.product,
          supplier: rp.supplier,
          currentStock,
          reorderPoint: rp.reorderPoint,
          reorderQuantity: rp.reorderQuantity,
          safetyStock: rp.safetyStock,
          isBelowSafetyStock: currentStock <= rp.safetyStock,
          estimatedCost: rp.reorderQuantity * (rp.estimatedUnitCost || rp.product.averageCost || 0),
          leadTimeDays: rp.leadTimeDays,
          autoReorder: rp.autoReorder,
          suggestedOrderDate: new Date()
        });
      }
    }

    res.json({
      success: true,
      count: productsNeedingReorder.length,
      data: productsNeedingReorder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk create reorder points for products
// @route   POST /api/stock/reorder-points/bulk
// @access  Private (admin, stock_manager)
exports.bulkCreateReorderPoints = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { items } = req.body;

    const created = [];
    const errors = [];

    for (const item of items) {
      // Check if product already has active reorder point
      const existing = await ReorderPoint.findOne({
        company: companyId,
        product: item.product,
        isActive: true
      });

      if (existing) {
        errors.push({ product: item.product, message: 'Reorder point already exists' });
        continue;
      }

      try {
        const reorder = await ReorderPoint.create({
          company: companyId,
          product: item.product,
          supplier: item.supplier,
          reorderPoint: item.reorderPoint,
          reorderQuantity: item.reorderQuantity || item.reorderPoint * 2,
          safetyStock: item.safetyStock || 0,
          leadTimeDays: item.leadTimeDays || 7,
          estimatedUnitCost: item.estimatedUnitCost,
          createdBy: req.user.id
        });
        created.push(reorder);
      } catch (err) {
        errors.push({ product: item.product, message: err.message });
      }
    }

    res.status(201).json({
      success: true,
      message: `${created.length} reorder points created`,
      created: created.length,
      errors: errors.length > 0 ? errors : undefined,
      data: created
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Apply reorder point to product and optionally create auto PO
// @route   POST /api/stock/reorder-points/apply-to-product
// @access  Private (admin, stock_manager)
exports.applyReorderPointToProduct = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { 
      productId, 
      reorderPoint, 
      reorderQuantity, 
      safetyStock, 
      supplierId,
      estimatedUnitCost,
      autoReorder 
    } = req.body;

    // Validate product exists
    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Validate supplier exists if provided
    if (supplierId) {
      const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' });
      }
    }

    // Update product with reorder settings
    product.reorderPoint = reorderPoint;
    product.reorderQuantity = reorderQuantity || reorderPoint * 2;
    product.preferredSupplier = supplierId;
    product.lowStockThreshold = safetyStock || 0;
    await product.save();

    // Create or update reorder point
    const reorderQty = reorderQuantity || reorderPoint * 2;
    const reorderPointData = {
      company: companyId,
      product: productId,
      supplier: supplierId,
      reorderPoint,
      reorderQuantity: reorderQty,
      safetyStock: safetyStock || 0,
      estimatedUnitCost: estimatedUnitCost || product.averageCost || 0,
      autoReorder: autoReorder || false,
      isActive: true,
      createdBy: req.user.id
    };

    const rp = await ReorderPoint.findOneAndUpdate(
      { company: companyId, product: productId },
      reorderPointData,
      { upsert: true, new: true }
    ).populate('product', 'name sku').populate('supplier', 'name code');

    // If autoReorder is enabled and stock is below reorder point, create PO
    let autoPO = null;
    if (autoReorder && (product.currentStock || 0) <= reorderPoint && supplierId) {
      const autoReorderService = require('../services/autoReorderService');
      autoPO = await autoReorderService.createAutoPurchaseOrder(companyId, rp);
    }

    res.status(201).json({
      success: true,
      message: autoPO ? 'Reorder point applied and auto PO created' : 'Reorder point applied successfully',
      data: { reorderPoint: rp, autoPO },
      autoPOCreated: !!autoPO
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Trigger manual auto-reorder check
// @route   POST /api/stock/reorder-points/trigger-auto-check
// @access  Private (admin, stock_manager)
exports.triggerAutoReorderCheck = async (req, res, next) => {
  try {
    const autoReorderService = require('../services/autoReorderService');
    await autoReorderService.triggerManualReorder();
    
    res.json({
      success: true,
      message: 'Auto reorder check triggered successfully'
    });
  } catch (error) {
    next(error);
  }
};
