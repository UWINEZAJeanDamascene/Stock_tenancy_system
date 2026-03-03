const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const StockMovement = require('../models/StockMovement');
const PDFDocument = require('pdfkit');

// @desc    Get all purchases
// @route   GET /api/purchases
// @access  Private
exports.getPurchases = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, status, supplierId, startDate, endDate } = req.query;
    const query = { company: companyId };

    if (status) {
      query.status = status;
    }

    if (supplierId) {
      query.supplier = supplierId;
    }

    if (startDate || endDate) {
      query.purchaseDate = {};
      if (startDate) query.purchaseDate.$gte = new Date(startDate);
      if (endDate) query.purchaseDate.$gte = new Date(endDate);
    }

    const total = await Purchase.countDocuments(query);
    const purchases = await Purchase.find(query)
      .populate('supplier', 'name code contact')
      .populate('items.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: purchases.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: purchases
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single purchase
// @route   GET /api/purchases/:id
// @access  Private
exports.getPurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchase = await Purchase.findOne({ _id: req.params.id, company: companyId })
      .populate('supplier', 'name code contact type taxId')
      .populate('items.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('payments.recordedBy', 'name email');

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    res.json({
      success: true,
      data: purchase
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new purchase
// @route   POST /api/purchases
// @access  Private (admin, stock_manager, purchases)
exports.createPurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { items, supplier: supplierId, currency, paymentTerms, supplierTin, supplierAddress, supplierName, supplierInvoiceNumber, supplierInvoiceDate } = req.body;

    // Get supplier details
    const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Process items with tax codes
    const processedItems = items.map((item, index) => {
      const subtotal = item.quantity * item.unitCost;
      const discount = item.discount || 0;
      const netAmount = subtotal - discount;
      const taxRate = item.taxRate || 0;
      const taxAmount = netAmount * (taxRate / 100);
      const totalWithTax = netAmount + taxAmount;
      
      return {
        ...item,
        itemCode: item.itemCode || `ITEM-${index + 1}`,
        subtotal,
        taxAmount,
        totalWithTax
      };
    });

    const purchase = await Purchase.create({
      ...req.body,
      company: companyId,
      items: processedItems,
      supplierTin: supplierTin || supplier.taxId,
      supplierName: supplierName || supplier.name,
      supplierAddress: supplierAddress || supplier.contact?.address,
      createdBy: req.user.id
    });

    await purchase.populate('supplier items.product createdBy');

    res.status(201).json({
      success: true,
      data: purchase
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update purchase
// @route   PUT /api/purchases/:id
// @access  Private (admin, stock_manager)
exports.updatePurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let purchase = await Purchase.findOne({ _id: req.params.id, company: companyId });

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    // Only draft purchases can be updated
    if (purchase.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft purchases can be updated'
      });
    }

    // Recalculate item totals if items are updated
    if (req.body.items) {
      req.body.items = req.body.items.map((item, index) => {
        const subtotal = item.quantity * item.unitCost;
        const discount = item.discount || 0;
        const netAmount = subtotal - discount;
        const taxRate = item.taxRate || 0;
        const taxAmount = netAmount * (taxRate / 100);
        const totalWithTax = netAmount + taxAmount;
        return {
          ...item,
          itemCode: item.itemCode || `ITEM-${index + 1}`,
          subtotal,
          taxAmount,
          totalWithTax
        };
      });
    }

    purchase = await Purchase.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      { new: true, runValidators: true }
    )
      .populate('supplier items.product createdBy');

    res.json({
      success: true,
      data: purchase
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete purchase
// @route   DELETE /api/purchases/:id
// @access  Private (admin)
exports.deletePurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchase = await Purchase.findOne({ _id: req.params.id, company: companyId });

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    // Only draft purchases can be deleted
    if (purchase.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft purchases can be deleted'
      });
    }

    await purchase.deleteOne();

    res.json({
      success: true,
      message: 'Purchase deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Receive purchase (add stock)
// @route   PUT /api/purchases/:id/receive
// @access  Private (admin, stock_manager)
exports.receivePurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchase = await Purchase.findOne({ _id: req.params.id, company: companyId }).populate('items.product');

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    if (purchase.status !== 'draft' && purchase.status !== 'ordered') {
      return res.status(400).json({
        success: false,
        message: 'Only draft or ordered purchases can be received'
      });
    }

    // Add stock for each item
    for (const item of purchase.items) {
      const product = await Product.findOne({ _id: item.product._id, company: companyId });
      
      if (product) {
        const previousStock = product.currentStock || 0;
        const newStock = previousStock + item.quantity;

        // Create stock movement (ledger entry)
        await StockMovement.create({
          company: companyId,
          product: product._id,
          type: 'in',
          reason: 'purchase',
          quantity: item.quantity,
          previousStock,
          newStock,
          unitCost: item.unitCost,
          totalCost: item.totalWithTax,
          supplier: purchase.supplier,
          referenceType: 'purchase',
          referenceNumber: purchase.purchaseNumber,
          referenceDocument: purchase._id,
          referenceModel: 'Purchase',
          notes: `Purchase ${purchase.purchaseNumber} - ${product.name}`,
          performedBy: req.user.id
        });

        // Update product stock and cost
        product.currentStock = newStock;
        
        // Update average cost if needed
        if (product.averageCost === 0 || !product.averageCost) {
          product.averageCost = item.unitCost;
        } else {
          // Calculate new average cost
          const totalValue = (product.averageCost * previousStock) + (item.unitCost * item.quantity);
          product.averageCost = totalValue / newStock;
        }
        
        await product.save();
      }
    }

    // Update purchase status
    purchase.status = 'received';
    purchase.stockAdded = true;
    purchase.receivedDate = new Date();
    purchase.confirmedDate = new Date();
    purchase.confirmedBy = req.user.id;
    await purchase.save();

    // Update supplier stats
    const supplier = await Supplier.findOne({ _id: purchase.supplier, company: companyId });
    if (supplier) {
      supplier.totalPurchases += purchase.roundedAmount;
      supplier.outstandingBalance += purchase.roundedAmount;
      supplier.lastPurchaseDate = new Date();
      await supplier.save();
    }

    res.json({
      success: true,
      message: 'Purchase received and stock added',
      data: purchase
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record payment for purchase
// @route   POST /api/purchases/:id/payment
// @access  Private (admin, stock_manager, purchases)
exports.recordPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference, notes } = req.body;

    const purchase = await Purchase.findOne({ _id: req.params.id, company: companyId })
      .populate('items.product');

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    if (purchase.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot record payment for cancelled purchase'
      });
    }

    if (amount > purchase.balance) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount exceeds purchase balance'
      });
    }

    // Add payment
    purchase.payments.push({
      amount,
      paymentMethod,
      reference,
      notes,
      recordedBy: req.user.id
    });

    purchase.amountPaid += amount;

    // Auto-receive if stock not yet added and payment is made
    if (!purchase.stockAdded && purchase.status === 'draft' && (paymentMethod === 'cash' || paymentMethod === 'card')) {
      // Add stock
      for (const item of purchase.items) {
        const product = await Product.findOne({ _id: item.product._id, company: companyId });
        
        if (product) {
          const previousStock = product.currentStock || 0;
          const newStock = previousStock + item.quantity;

          await StockMovement.create({
            company: companyId,
            product: product._id,
            type: 'in',
            reason: 'purchase',
            quantity: item.quantity,
            previousStock,
            newStock,
            unitCost: item.unitCost,
            totalCost: item.totalWithTax,
            supplier: purchase.supplier,
            referenceType: 'purchase',
            referenceNumber: purchase.purchaseNumber,
            referenceDocument: purchase._id,
            referenceModel: 'Purchase',
            notes: `Purchase ${purchase.purchaseNumber}`,
            performedBy: req.user.id
          });

          product.currentStock = newStock;
          if (product.averageCost === 0 || !product.averageCost) {
            product.averageCost = item.unitCost;
          }
          await product.save();
        }
      }

      purchase.stockAdded = true;
      purchase.status = 'received';
      purchase.receivedDate = new Date();
    }

    // Update supplier stats
    const supplier = await Supplier.findOne({ _id: purchase.supplier, company: companyId });
    if (supplier) {
      supplier.outstandingBalance -= amount;
      if (supplier.outstandingBalance < 0) supplier.outstandingBalance = 0;
      // Update last purchase date if this is the first payment or auto-received
      if (purchase.stockAdded || (!purchase.stockAdded && purchase.status === 'draft' && (paymentMethod === 'cash' || paymentMethod === 'card'))) {
        supplier.lastPurchaseDate = new Date();
      }
      await supplier.save();
    }

    await purchase.save();

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      data: purchase
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel purchase (reverse stock if received)
// @route   PUT /api/purchases/:id/cancel
// @access  Private (admin)
exports.cancelPurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const purchase = await Purchase.findOne({ _id: req.params.id, company: companyId }).populate('items.product');

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    if (purchase.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel fully paid purchase. Please contact administrator'
      });
    }

    // Reverse stock if it was added
    if (purchase.stockAdded) {
      for (const item of purchase.items) {
        const product = await Product.findOne({ _id: item.product._id, company: companyId });
        
        if (product) {
          const previousStock = product.currentStock;
          const newStock = Math.max(0, previousStock - item.quantity);

          // Create reversal stock movement
          await StockMovement.create({
            company: companyId,
            product: product._id,
            type: 'out',
            reason: 'return',
            quantity: item.quantity,
            previousStock,
            newStock,
            unitCost: item.unitCost,
            totalCost: item.totalWithTax,
            referenceType: 'purchase',
            referenceNumber: purchase.purchaseNumber,
            referenceDocument: purchase._id,
            referenceModel: 'Purchase',
            notes: `Purchase ${purchase.purchaseNumber} cancelled - Stock reversal`,
            performedBy: req.user.id
          });

          product.currentStock = newStock;
          await product.save();
        }
      }
    }

    // Update supplier outstanding balance
    const supplier = await Supplier.findOne({ _id: purchase.supplier, company: companyId });
    if (supplier) {
      const unpaidAmount = purchase.roundedAmount - purchase.amountPaid;
      supplier.outstandingBalance -= unpaidAmount;
      if (supplier.outstandingBalance < 0) supplier.outstandingBalance = 0;
      await supplier.save();
    }

    purchase.status = 'cancelled';
    purchase.cancelledDate = new Date();
    purchase.cancelledBy = req.user.id;
    purchase.cancellationReason = reason;

    await purchase.save();

    res.json({
      success: true,
      message: 'Purchase cancelled and stock reversed',
      data: purchase
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get purchases for a specific supplier
// @route   GET /api/purchases/supplier/:supplierId
// @access  Private
exports.getSupplierPurchases = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchases = await Purchase.find({ supplier: req.params.supplierId, company: companyId })
      .populate('items.product', 'name sku')
      .populate('createdBy', 'name email')
      .sort({ purchaseDate: -1 });

    res.json({
      success: true,
      count: purchases.length,
      data: purchases
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate purchase PDF
// @route   GET /api/purchases/:id/pdf
// @access  Private
exports.generatePurchasePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchase = await Purchase.findOne({ _id: req.params.id, company: companyId })
      .populate('supplier')
      .populate('items.product')
      .populate('createdBy');

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    // Create PDF document
    const doc = new PDFDocument({ margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=purchase-${purchase.purchaseNumber}.pdf`);

    doc.pipe(res);

    // Header
    doc.fontSize(20).text('PURCHASE ORDER', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(12).text(`Purchase Number: ${purchase.purchaseNumber}`);
    doc.text(`Purchase Date: ${new Date(purchase.purchaseDate).toLocaleDateString()}`);
    doc.text(`Status: ${purchase.status.toUpperCase()}`);
    doc.text(`Currency: ${purchase.currency || 'FRW'}`);
    doc.moveDown();

    // Supplier info
    doc.text('Supplier:', { underline: true });
    doc.text(purchase.supplierName || purchase.supplier?.name || 'N/A');
    if (purchase.supplierTin) doc.text(`TIN: ${purchase.supplierTin}`);
    if (purchase.supplierAddress) doc.text(purchase.supplierAddress);
    doc.moveDown(2);

    // Items table
    const tableTop = doc.y;
    doc.fontSize(10);
    doc.text('Item', 50, tableTop);
    doc.text('Qty', 250, tableTop);
    doc.text('Cost', 300, tableTop);
    doc.text('Tax', 360, tableTop);
    doc.text('Total', 420, tableTop);

    let yPosition = tableTop + 20;
    purchase.items.forEach(item => {
      doc.text(item.product?.name || item.description || 'N/A', 50, yPosition);
      doc.text(item.quantity.toString(), 250, yPosition);
      doc.text(`$${item.unitCost.toFixed(2)}`, 300, yPosition);
      doc.text(`${item.taxCode}: ${item.taxRate}%`, 360, yPosition);
      doc.text(`$${item.totalWithTax.toFixed(2)}`, 420, yPosition);
      yPosition += 20;
    });

    yPosition += 20;
    doc.fontSize(12);
    doc.text(`Subtotal: $${purchase.subtotal.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.text(`Tax: $${purchase.totalTax.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.fontSize(14).text(`Total: $${purchase.grandTotal.toFixed(2)}`, 350, yPosition, { bold: true });
    yPosition += 18;
    doc.text(`Paid: $${purchase.amountPaid.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.text(`Balance: $${purchase.balance.toFixed(2)}`, 350, yPosition);

    if (purchase.notes) {
      doc.moveDown(2);
      doc.text('Notes:', { underline: true });
      doc.fontSize(10).text(purchase.notes);
    }

    doc.end();
  } catch (error) {
    next(error);
  }
};
