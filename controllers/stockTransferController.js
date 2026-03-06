const StockTransfer = require('../models/StockTransfer');
const InventoryBatch = require('../models/InventoryBatch');
const SerialNumber = require('../models/SerialNumber');
const StockMovement = require('../models/StockMovement');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');

// @desc    Get all stock transfers
// @route   GET /api/stock/transfers
// @access  Private
exports.getStockTransfers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { 
      page = 1, 
      limit = 20, 
      status, 
      fromWarehouse, 
      toWarehouse,
      search 
    } = req.query;

    const query = { company: companyId };

    if (status) query.status = status;
    if (fromWarehouse) query.fromWarehouse = fromWarehouse;
    if (toWarehouse) query.toWarehouse = toWarehouse;

    const total = await StockTransfer.countDocuments(query);
    const transfers = await StockTransfer.find(query)
      .populate('fromWarehouse', 'name code')
      .populate('toWarehouse', 'name code')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .populate('receivedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: transfers.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: transfers
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single stock transfer
// @route   GET /api/stock/transfers/:id
// @access  Private
exports.getStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const transfer = await StockTransfer.findOne({ _id: req.params.id, company: companyId })
      .populate('fromWarehouse', 'name code')
      .populate('toWarehouse', 'name code')
      .populate('items.product', 'name sku')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .populate('receivedBy', 'name');

    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: 'Stock transfer not found'
      });
    }

    res.json({
      success: true,
      data: transfer
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create stock transfer
// @route   POST /api/stock/transfers
// @access  Private (admin, stock_manager)
exports.createStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      fromWarehouse: fromWarehouseId,
      toWarehouse: toWarehouseId,
      items,
      reason,
      transferDate,
      notes,
      referenceNumber
    } = req.body;

    // Validate warehouses exist
    const [fromWarehouse, toWarehouse] = await Promise.all([
      Warehouse.findOne({ _id: fromWarehouseId, company: companyId }),
      Warehouse.findOne({ _id: toWarehouseId, company: companyId })
    ]);

    if (!fromWarehouse || !toWarehouse) {
      return res.status(404).json({
        success: false,
        message: 'One or both warehouses not found'
      });
    }

    if (fromWarehouseId === toWarehouseId) {
      return res.status(400).json({
        success: false,
        message: 'Source and destination warehouses must be different'
      });
    }

    // Validate items and check stock availability
    for (const item of items) {
      const product = await Product.findOne({ _id: item.product, company: companyId });
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product ${item.product} not found`
        });
      }

      // Check available stock in source warehouse - first try InventoryBatch, then fall back to Product
      let availableQty = 0;
      
      // Check if there are inventory batches in the source warehouse
      const batches = await InventoryBatch.find({
        company: companyId,
        product: item.product,
        warehouse: fromWarehouseId,
        status: { $nin: ['exhausted'] },
        availableQuantity: { $gt: 0 }
      });

      if (batches.length > 0) {
        // Use batch-based inventory
        availableQty = batches.reduce((sum, b) => sum + b.availableQuantity, 0);
      } else {
        // Fall back to Product.currentStock (legacy system)
        // Assume all stock is in the source warehouse
        availableQty = product.currentStock || 0;
      }

      if (availableQty < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for product ${product.name}. Available: ${availableQty}, Requested: ${item.quantity}`
        });
      }
    }

    // Create transfer
    const transfer = await StockTransfer.create({
      company: companyId,
      fromWarehouse: fromWarehouseId,
      toWarehouse: toWarehouseId,
      items,
      reason: reason || 'rebalance',
      transferDate: transferDate || new Date(),
      notes,
      referenceNumber,
      status: 'pending',
      createdBy: req.user.id
    });

    await transfer.populate([
      { path: 'fromWarehouse', select: 'name code' },
      { path: 'toWarehouse', select: 'name code' },
      { path: 'items.product', select: 'name sku' }
    ]);

    res.status(201).json({
      success: true,
      message: 'Stock transfer created successfully',
      data: transfer
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve stock transfer
// @route   POST /api/stock/transfers/:id/approve
// @access  Private (admin)
exports.approveStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const transfer = await StockTransfer.findOne({ _id: req.params.id, company: companyId });

    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Stock transfer not found' });
    }

    if (transfer.status !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        message: 'Only pending transfers can be approved' 
      });
    }

    transfer.status = 'in_transit';
    transfer.approvedBy = req.user.id;
    transfer.approvedDate = new Date();
    await transfer.save();

    res.json({
      success: true,
      message: 'Stock transfer approved',
      data: transfer
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Complete stock transfer (receive)
// @route   POST /api/stock/transfers/:id/complete
// @access  Private (admin, stock_manager)
exports.completeStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { receivedNotes } = req.body;

    const transfer = await StockTransfer.findOne({ _id: req.params.id, company: companyId });

    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Stock transfer not found' });
    }

    if (transfer.status !== 'in_transit') {
      return res.status(400).json({ 
        success: false, 
        message: 'Only in-transit transfers can be completed' 
      });
    }

    // Process each item
    for (const item of transfer.items) {
      const product = await Product.findOne({ _id: item.product, company: companyId });
      
      // Handle batch-tracked products
      if (product?.trackBatch) {
        // Deduct from source warehouse
        const sourceBatches = await InventoryBatch.find({
          company: companyId,
          product: item.product,
          warehouse: transfer.fromWarehouse,
          status: { $nin: ['exhausted'] },
          availableQuantity: { $gt: 0 }
        }).sort({ expiryDate: 1 });

        let remainingQty = item.quantity;
        for (const batch of sourceBatches) {
          if (remainingQty <= 0) break;
          
          const deductQty = Math.min(batch.availableQuantity, remainingQty);
          batch.availableQuantity -= deductQty;
          batch.updateStatus();
          await batch.save();
          remainingQty -= deductQty;
        }

        // Add to destination warehouse (check if batch exists)
        const destBatchNumber = item.batchNumber || null;
        let destBatch = await InventoryBatch.findOne({
          company: companyId,
          product: item.product,
          warehouse: transfer.toWarehouse,
          batchNumber: destBatchNumber,
          status: { $nin: ['exhausted'] }
        });

        if (destBatch) {
          destBatch.quantity += item.quantity;
          destBatch.availableQuantity += item.quantity;
          destBatch.updateStatus();
          await destBatch.save();
        } else if (remainingQty > 0 || item.quantity > 0) {
          // Create new batch for remaining quantity
          destBatch = await InventoryBatch.create({
            company: companyId,
            product: item.product,
            warehouse: transfer.toWarehouse,
            batchNumber: item.batchNumber,
            quantity: item.quantity,
            availableQuantity: item.quantity,
            unitCost: sourceBatches[0]?.unitCost || product?.averageCost || 0,
            totalCost: item.quantity * (sourceBatches[0]?.unitCost || product?.averageCost || 0),
            status: 'active'
          });
        }
      }
      // Handle serial-tracked products
      else if (product?.trackSerialNumbers && item.serialNumbers) {
        for (const serialNum of item.serialNumbers) {
          const serial = await SerialNumber.findOne({
            company: companyId,
            product: item.product,
            serialNumber: serialNum.toUpperCase(),
            warehouse: transfer.fromWarehouse
          });

          if (serial) {
            serial.warehouse = transfer.toWarehouse;
            serial.status = 'available';
            await serial.save();
          }
        }
      }
      // Handle regular products (non-batch, non-serial) - use legacy Product.currentStock
      else {
        // Deduct from source - just update Product.currentStock
        if (product) {
          product.currentStock = Math.max(0, product.currentStock - item.quantity);
          await product.save();
        }

        // Add to destination - update Product.currentStock at destination
        const destProduct = await Product.findOne({ _id: item.product, company: companyId });
        if (destProduct) {
          destProduct.currentStock = (destProduct.currentStock || 0) + item.quantity;
          await destProduct.save();
        }
      }
    }

    // Update transfer status
    transfer.status = 'completed';
    transfer.completedDate = new Date();
    transfer.receivedBy = req.user.id;
    transfer.receivedDate = new Date();
    transfer.receivedNotes = receivedNotes;
    await transfer.save();

    res.json({
      success: true,
      message: 'Stock transfer completed successfully',
      data: transfer
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel stock transfer
// @route   POST /api/stock/transfers/:id/cancel
// @access  Private (admin)
exports.cancelStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const transfer = await StockTransfer.findOne({ _id: req.params.id, company: companyId });

    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Stock transfer not found' });
    }

    if (transfer.status === 'completed') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot cancel completed transfer' 
      });
    }

    transfer.status = 'cancelled';
    transfer.notes = `${transfer.notes || ''}\nCancellation reason: ${reason || 'Not specified'}`;
    await transfer.save();

    res.json({
      success: true,
      message: 'Stock transfer cancelled',
      data: transfer
    });
  } catch (error) {
    next(error);
  }
};
