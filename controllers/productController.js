const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Quotation = require('../models/Quotation');
const Invoice = require('../models/Invoice');
const Supplier = require('../models/Supplier');
const bwipjs = require('bwip-js');
const QRCode = require('qrcode');

// @desc    Get all products
// @route   GET /api/products
// @access  Private
exports.getProducts = async (req, res, next) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      search, 
      category, 
      supplier,
      status,
      isArchived = false,
      sortBy = 'createdAt',
      order = 'desc'
    } = req.query;

    // Multi-tenancy: Filter by company
    const companyId = req.user.company._id;

    const query = { 
      company: companyId,
      isArchived 
    };

    if (search && search.trim()) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    if (category && category.trim()) {
      query.category = category;
    }

    if (supplier && supplier.trim()) {
      query.supplier = supplier;
    }

    // Status filtering: 'in_stock', 'low_stock', 'out_of_stock'
    if (status && status.trim()) {
      if (status === 'out_of_stock') {
        query.currentStock = 0;
      } else if (status === 'low_stock') {
        query.$expr = { $lte: ['$currentStock', '$lowStockThreshold'] };
        query.currentStock = { $gt: 0 };
      } else if (status === 'in_stock') {
        query.$expr = { $gt: ['$currentStock', '$lowStockThreshold'] };
      }
    }

    const total = await Product.countDocuments(query);
    const products = await Product.find(query)
      .populate('category', 'name')
      .populate('supplier', 'name code')
      .populate('createdBy', 'name email')
      .sort({ [sortBy]: order === 'desc' ? -1 : 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: products.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: products
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single product
// @route   GET /api/products/:id
// @access  Private
exports.getProduct = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId })
      .populate('category', 'name')
      .populate('supplier', 'name code email phone address')
      .populate('createdBy', 'name email')
      .populate('history.changedBy', 'name email');

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new product
// @route   POST /api/products
// @access  Private (admin, stock_manager)
exports.createProduct = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    req.body.company = companyId;
    req.body.createdBy = req.user.id;

    const product = await Product.create(req.body);

    // Link product to supplier if supplier is provided
    if (product.supplier) {
      const supplier = await Supplier.findOne({ _id: product.supplier, company: companyId });
      if (supplier) {
        const isProductAlreadyLinked = supplier.productsSupplied.some(
          (p) => p.toString() === product._id.toString()
        );
        
        if (!isProductAlreadyLinked) {
          supplier.productsSupplied.push(product._id);
          await supplier.save();
        }
      }
    }

    res.status(201).json({
      success: true,
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private (admin, stock_manager)
exports.updateProduct = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    let product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    // Store old values for history
    const oldValues = product.toObject();
    const oldSupplierId = product.supplier?.toString();
    const newSupplierId = req.body.supplier;

    // Update product
    Object.assign(product, req.body);

    // Add history entry
    product.history.push({
      action: 'updated',
      changedBy: req.user.id,
      changes: {
        old: oldValues,
        new: req.body
      }
    });

    await product.save();

    // Handle supplier linking
    // If supplier changed or newly assigned
    if (newSupplierId && newSupplierId !== oldSupplierId) {
      // Add to new supplier
      const newSupplier = await Supplier.findOne({ _id: newSupplierId, company: companyId });
      if (newSupplier) {
        const isProductAlreadyLinked = newSupplier.productsSupplied.some(
          (p) => p.toString() === product._id.toString()
        );
        
        if (!isProductAlreadyLinked) {
          newSupplier.productsSupplied.push(product._id);
          await newSupplier.save();
        }
      }
    }

    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Private (admin, stock_manager)
exports.deleteProduct = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    await Product.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Archive product
// @route   PUT /api/products/:id/archive
// @access  Private (admin, stock_manager)
exports.archiveProduct = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    product.isArchived = true;
    product.history.push({
      action: 'archived',
      changedBy: req.user.id,
      notes: req.body.notes
    });

    await product.save();

    res.json({
      success: true,
      message: 'Product archived successfully',
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Restore archived product
// @route   PUT /api/products/:id/restore
// @access  Private (admin, stock_manager)
exports.restoreProduct = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    product.isArchived = false;
    product.history.push({
      action: 'restored',
      changedBy: req.user.id,
      notes: req.body.notes
    });

    await product.save();

    res.json({
      success: true,
      message: 'Product restored successfully',
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get product history
// @route   GET /api/products/:id/history
// @access  Private
exports.getProductHistory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId })
      .populate('history.changedBy', 'name email');

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    res.json({
      success: true,
      data: product.history
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get product lifecycle (complete traceability)
// @route   GET /api/products/:id/lifecycle
// @access  Private
exports.getProductLifecycle = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId })
      .populate('category', 'name')
      .populate('history.changedBy', 'name email');

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    // Get all stock movements
    const stockMovements = await StockMovement.find({ product: req.params.id, company: companyId })
      .populate('supplier', 'name code')
      .populate('performedBy', 'name email')
      .sort({ movementDate: -1 });

    // Get all quotations containing this product
    const quotations = await Quotation.find({ 'items.product': req.params.id, company: companyId })
      .populate('client', 'name code')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    // Get all invoices containing this product
    const invoices = await Invoice.find({ 'items.product': req.params.id, company: companyId })
      .populate('client', 'name code')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: {
        product,
        stockMovements,
        quotations,
        invoices,
        timeline: buildTimeline(product, stockMovements, quotations, invoices)
      }
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to build timeline
const buildTimeline = (product, stockMovements, quotations, invoices) => {
  const timeline = [];

  // Add product creation
  timeline.push({
    type: 'product_created',
    date: product.createdAt,
    description: 'Product created',
    details: product
  });

  // Add stock movements
  stockMovements.forEach(movement => {
    timeline.push({
      type: 'stock_movement',
      date: movement.movementDate,
      description: `Stock ${movement.type} - ${movement.reason}`,
      details: movement
    });
  });

  // Add quotations
  quotations.forEach(quotation => {
    timeline.push({
      type: 'quotation',
      date: quotation.createdAt,
      description: `Quotation ${quotation.quotationNumber} - ${quotation.status}`,
      details: quotation
    });
  });

  // Add invoices
  invoices.forEach(invoice => {
    timeline.push({
      type: 'invoice',
      date: invoice.invoiceDate,
      description: `Invoice ${invoice.invoiceNumber} - ${invoice.status}`,
      details: invoice
    });
  });

  // Sort by date descending
  return timeline.sort((a, b) => new Date(b.date) - new Date(a.date));
};

// @desc    Get low stock products
// @route   GET /api/products/low-stock
// @access  Private
exports.getLowStockProducts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const products = await Product.find({
      company: companyId,
      isArchived: false,
      $expr: { $lte: ['$currentStock', '$lowStockThreshold'] }
    })
      .populate('category', 'name')
      .sort({ currentStock: 1 });

    res.json({
      success: true,
      count: products.length,
      data: products
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get product barcode image (PNG)
// @route   GET /api/products/:id/barcode
// @access  Private
exports.getProductBarcode = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const requestedType = (req.query.type || product.barcodeType || 'CODE128').toString().toUpperCase();
    let bcid = 'code128';
    if (requestedType === 'EAN13' || requestedType === 'EAN-13') {
      bcid = 'ean13';
    } else if (requestedType === 'EAN8' || requestedType === 'EAN-8') {
      bcid = 'ean8';
    } else if (requestedType === 'UPC') {
      bcid = 'upca';
    } else if (requestedType === 'CODE39') {
      bcid = 'code39';
    } else if (requestedType === 'ITF14') {
      bcid = 'itf14';
    }

    // Fallback text/value
    const text = product.barcode || product.sku || String(product._id);

    // For EAN13/EAN8/UPC ensure numeric; if not, use CODE128 as fallback
    let codeText = String(text);
    if (['ean13', 'ean8', 'upca'].includes(bcid)) {
      codeText = codeText.replace(/[^0-9]/g, '');
      if (bcid === 'ean13' || bcid === 'upca') {
        if (codeText.length < 12) codeText = codeText.padStart(12, '0');
        if (codeText.length > 12) codeText = codeText.slice(0, 12);
      } else if (bcid === 'ean8') {
        if (codeText.length < 7) codeText = codeText.padStart(7, '0');
        if (codeText.length > 7) codeText = codeText.slice(0, 7);
      }
    }

    const png = await bwipjs.toBuffer({
      bcid,
      text: bcid === 'ean13' ? codeText : String(text),
      scale: parseInt(req.query.scale || '3', 10),
      height: parseInt(req.query.height || '10', 10),
      includetext: true,
      textxalign: 'center'
    });

    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (error) {
    next(error);
  }
};

// @desc    Get product QR code image (PNG)
// @route   GET /api/products/:id/qrcode
// @access  Private
exports.getProductQRCode = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Build a default URL for product lookup. Prefer FRONTEND_BASE_URL env, else origin.
    const frontendBase = process.env.FRONTEND_BASE_URL || req.get('origin') || '';
    const payloadUrl = frontendBase ? `${frontendBase.replace(/\/$/, '')}/products/${product._id}` : `product:${product._id}`;

    const pngBuffer = await QRCode.toBuffer(payloadUrl, {
      type: 'png',
      width: parseInt(req.query.width || '300', 10),
      margin: 1
    });

    res.set('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (error) {
    next(error);
  }
};
