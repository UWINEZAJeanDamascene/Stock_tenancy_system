const SerialNumber = require('../models/SerialNumber');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');

// @desc    Get all serial numbers
// @route   GET /api/stock/serial-numbers
// @access  Private
exports.getSerialNumbers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { 
      page = 1, 
      limit = 20, 
      productId, 
      warehouseId, 
      status, 
      search 
    } = req.query;

    const query = { company: companyId };

    // Only add to query if parameter is provided and not 'undefined' or empty string
    if (productId && productId !== 'undefined' && productId !== '') query.product = productId;
    if (warehouseId && warehouseId !== 'undefined' && warehouseId !== '') query.warehouse = warehouseId;
    if (status && status !== 'undefined' && status !== '') query.status = status;
    if (search) query.serialNumber = { $regex: search, $options: 'i' };

    const total = await SerialNumber.countDocuments(query);
    const serialNumbers = await SerialNumber.find(query)
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .populate('supplier', 'name code')
      .populate('client', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: serialNumbers.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: serialNumbers
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single serial number
// @route   GET /api/stock/serial-numbers/:id
// @access  Private
exports.getSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const serialNumber = await SerialNumber.findOne({ _id: req.params.id, company: companyId })
      .populate('product', 'name sku unit')
      .populate('warehouse', 'name code')
      .populate('supplier', 'name code contact')
      .populate('client', 'name contact')
      .populate('invoice', 'invoiceNumber date')
      .populate('createdBy', 'name');

    if (!serialNumber) {
      return res.status(404).json({
        success: false,
        message: 'Serial number not found'
      });
    }

    res.json({
      success: true,
      data: serialNumber
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create serial number(s)
// @route   POST /api/stock/serial-numbers
// @access  Private (admin, stock_manager)
exports.createSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { 
      product: productId,
      warehouse: warehouseId,
      serialNumbers, // Array of serial numbers or single string
      supplier: supplierId,
      purchaseDate,
      purchasePrice,
      stockMovementId,
      notes
    } = req.body;

    // Validate product exists and tracks serial numbers
    const product = await Product.findOne({ _id: productId, company: companyId });
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (!product.trackSerialNumbers) {
      return res.status(400).json({ 
        success: false, 
        message: 'Product does not track serial numbers' 
      });
    }

    // Normalize to array
    const serialArray = Array.isArray(serialNumbers) ? serialNumbers : [serialNumbers];
    const createdSerials = [];
    const errors = [];

    for (const serial of serialArray) {
      // Check if serial already exists
      const existing = await SerialNumber.findOne({
        company: companyId,
        serialNumber: serial.toUpperCase()
      });

      if (existing) {
        errors.push(`Serial ${serial} already exists`);
        continue;
      }

      const newSerial = await SerialNumber.create({
        company: companyId,
        product: productId,
        warehouse: warehouseId,
        serialNumber: serial.toUpperCase(),
        supplier: supplierId,
        purchaseDate: purchaseDate || new Date(),
        purchasePrice,
        stockMovement: stockMovementId,
        status: 'available',
        notes,
        createdBy: req.user.id
      });

      createdSerials.push(newSerial);
    }

    // Update product stock count
    if (createdSerials.length > 0) {
      product.currentStock += createdSerials.length;
      await product.save();
    }

    res.status(201).json({
      success: true,
      message: `${createdSerials.length} serial number(s) created`,
      created: createdSerials.length,
      errors: errors.length > 0 ? errors : undefined,
      data: createdSerials
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update serial number
// @route   PUT /api/stock/serial-numbers/:id
// @access  Private (admin, stock_manager)
exports.updateSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let serialNumber = await SerialNumber.findOne({ _id: req.params.id, company: companyId });

    if (!serialNumber) {
      return res.status(404).json({
        success: false,
        message: 'Serial number not found'
      });
    }

    // Prevent changing serial number if already sold
    if (serialNumber.status === 'sold' && req.body.status && req.body.status !== 'sold') {
      return res.status(400).json({
        success: false,
        message: 'Cannot change status of sold item'
      });
    }

    const allowedFields = [
      'warehouse', 'status', 'notes', 'warrantyStartDate', 
      'warrantyEndDate', 'warrantyDetails'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        serialNumber[field] = req.body[field];
      }
    });

    await serialNumber.save();

    res.json({
      success: true,
      data: serialNumber
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Sell/allocate serial number
// @route   POST /api/stock/serial-numbers/:id/sell
// @access  Private
exports.sellSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { 
      clientId, 
      saleDate, 
      salePrice, 
      invoiceId, 
      warrantyEndDate,
      notes 
    } = req.body;

    const serialNumber = await SerialNumber.findOne({ _id: req.params.id, company: companyId });

    if (!serialNumber) {
      return res.status(404).json({ success: false, message: 'Serial number not found' });
    }

    if (serialNumber.status !== 'available') {
      return res.status(400).json({ 
        success: false, 
        message: `Serial number is not available (status: ${serialNumber.status})` 
      });
    }

    // Update serial number
    serialNumber.status = 'sold';
    serialNumber.saleDate = saleDate || new Date();
    serialNumber.salePrice = salePrice;
    serialNumber.client = clientId;
    serialNumber.invoice = invoiceId;
    
    if (warrantyEndDate) {
      serialNumber.warrantyEndDate = warrantyEndDate;
      serialNumber.warrantyStartDate = serialNumber.saleDate;
      serialNumber.status = 'under_warranty';
    }

    if (notes) serialNumber.notes = notes;

    await serialNumber.save();

    // Update product stock
    const product = await Product.findOne({ _id: serialNumber.product, company: companyId });
    if (product) {
      product.currentStock = Math.max(0, product.currentStock - 1);
      product.lastSaleDate = new Date();
      await product.save();
    }

    // Create stock movement
    await StockMovement.create({
      company: companyId,
      product: serialNumber.product,
      type: 'out',
      reason: 'sale',
      quantity: 1,
      previousStock: (product?.currentStock || 0) + 1,
      newStock: product?.currentStock || 0,
      referenceType: 'invoice',
      referenceDocument: invoiceId,
      notes: `Serial: ${serialNumber.serialNumber}`,
      performedBy: req.user.id,
      movementDate: new Date()
    });

    res.json({
      success: true,
      message: 'Serial number sold successfully',
      data: serialNumber
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Return serial number
// @route   POST /api/stock/serial-numbers/:id/return
// @access  Private
exports.returnSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { warehouseId, notes } = req.body;

    const serialNumber = await SerialNumber.findOne({ _id: req.params.id, company: companyId });

    if (!serialNumber) {
      return res.status(404).json({ success: false, message: 'Serial number not found' });
    }

    if (serialNumber.status !== 'sold' && serialNumber.status !== 'under_warranty') {
      return res.status(400).json({ 
        success: false, 
        message: 'Can only return sold items' 
      });
    }

    const previousStatus = serialNumber.status;
    
    // Update serial number
    serialNumber.status = 'returned';
    serialNumber.warehouse = warehouseId;
    if (notes) serialNumber.notes = notes;
    
    // Clear warranty info
    serialNumber.warrantyEndDate = null;
    serialNumber.warrantyStartDate = null;

    await serialNumber.save();

    // Update product stock
    const product = await Product.findOne({ _id: serialNumber.product, company: companyId });
    if (product) {
      product.currentStock += 1;
      await product.save();
    }

    // Create stock movement
    await StockMovement.create({
      company: companyId,
      product: serialNumber.product,
      type: 'in',
      reason: 'return',
      quantity: 1,
      previousStock: (product?.currentStock || 0) - 1,
      newStock: product?.currentStock || 0,
      referenceType: 'return',
      notes: `Returned: ${serialNumber.serialNumber}. Previous status: ${previousStatus}`,
      performedBy: req.user.id,
      movementDate: new Date()
    });

    res.json({
      success: true,
      message: 'Serial number returned successfully',
      data: serialNumber
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get serial number by serial
// @route   GET /api/stock/serial-numbers/lookup/:serial
// @access  Private
exports.lookupSerialNumber = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { serial } = req.params;

    const serialNumber = await SerialNumber.findOne({
      company: companyId,
      serialNumber: serial.toUpperCase()
    })
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .populate('client', 'name contact');

    if (!serialNumber) {
      return res.status(404).json({
        success: false,
        message: 'Serial number not found'
      });
    }

    res.json({
      success: true,
      data: serialNumber
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get available serials for product
// @route   GET /api/stock/serial-numbers/product/:productId/available
// @access  Private
exports.getAvailableSerials = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { productId } = req.params;

    const serials = await SerialNumber.find({
      company: companyId,
      product: productId,
      status: 'available'
    })
      .select('serialNumber warehouse')
      .populate('warehouse', 'name code');

    res.json({
      success: true,
      count: serials.length,
      data: serials
    });
  } catch (error) {
    next(error);
  }
};
