const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const StockMovement = require('../models/StockMovement');
const Company = require('../models/Company');
const PDFDocument = require('pdfkit');
const { notifyStockReceived, notifyLowStock, notifyOutOfStock } = require('../services/notificationHelper');
const cacheService = require('../services/cacheService');
const { BankAccount, BankTransaction } = require('../models/BankAccount');
const JournalService = require('../services/journalService');

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

    // Check if company has capital recorded (mandatory requirement)
    const company = await Company.findById(companyId);
    const ownerCapital = company.equity?.ownerCapital || 0;
    const shareCapital = company.equity?.shareCapital || 0;
    const totalCapital = ownerCapital + shareCapital;

    if (totalCapital <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot create purchase. No capital recorded. Please record Owner\'s Capital or Share Capital first in Journal Entries > Record Capital.'
      });
    }

    // Get supplier details
    const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Process items with tax codes - prefer product defaults when present
    const processedItems = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const product = await Product.findOne({ _id: item.product, company: companyId });
      const subtotal = item.quantity * item.unitCost;
      const discount = item.discount || 0;
      const netAmount = subtotal - discount;
      const taxRate = (item.taxRate != null) ? item.taxRate : (product?.taxRate != null ? product.taxRate : 0);
      const taxCode = item.taxCode || product?.taxCode || 'A';
      const taxAmount = netAmount * (taxRate / 100);
      const totalWithTax = netAmount + taxAmount;

      processedItems.push({
        ...item,
        itemCode: item.itemCode || `ITEM-${i + 1}`,
        taxCode,
        taxRate,
        subtotal,
        taxAmount,
        totalWithTax
      });
    }

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

    // Fetch supplier early (used in notifications) to avoid temporal-dead-zone errors
    const supplier = await Supplier.findOne({ _id: purchase.supplier, company: companyId });

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

        // Send stock received notification
        try {
          await notifyStockReceived(
            companyId,
            product,
            item.quantity,
            supplier
          );

          // Check if stock is now low or out after adding
          if (product.reorderPoint && newStock <= product.reorderPoint) {
            await notifyLowStock(companyId, product, newStock);
          }
          if (newStock === 0) {
            await notifyOutOfStock(companyId, product);
          }
        } catch (notifError) {
          console.error('Failed to send stock notification:', notifError);
        }
      }
    }

    // Update purchase status
    purchase.status = 'received';
    purchase.stockAdded = true;
    purchase.receivedDate = new Date();
    purchase.confirmedDate = new Date();
    purchase.confirmedBy = req.user.id;
    await purchase.save();

    // Create journal entry for the purchase (Inventory + VAT Debit, Accounts Payable Credit)
    try {
      await JournalService.createPurchaseEntry(companyId, req.user.id, {
        _id: purchase._id,
        purchaseNumber: purchase.purchaseNumber,
        date: purchase.purchaseDate,
        total: purchase.roundedAmount,
        vatAmount: purchase.totalTax
      });
    } catch (journalError) {
      console.error('Error creating journal entry for purchase:', journalError);
      // Don't fail the purchase receipt if journal entry fails
    }

    // Update supplier stats (supplier was fetched above)
    if (supplier) {
      supplier.totalPurchases += purchase.roundedAmount;
      supplier.outstandingBalance += purchase.roundedAmount;
      supplier.lastPurchaseDate = new Date();
      await supplier.save();
    }

    // Invalidate report cache - receiving purchase affects Balance Sheet (inventory, payables, VAT) and P&L
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
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
    const { amount, paymentMethod, reference, notes, capitalType } = req.body;

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

    // Check if capital has been recorded (mandatory requirement for all purchases)
    const companyCheck = await Company.findById(companyId);
    const ownerCapital = companyCheck.equity?.ownerCapital || 0;
    const shareCapital = companyCheck.equity?.shareCapital || 0;
    const totalCapital = ownerCapital + shareCapital;

    if (totalCapital <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot record payment. No capital recorded. Please record Owner\'s Capital or Share Capital first in Journal Entries > Record Capital.'
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

    // Explicitly recalculate balance to ensure it's correct
    purchase.balance = purchase.grandTotal - purchase.amountPaid;
    if (purchase.balance < 0) purchase.balance = 0;

    // Fetch supplier early (used in notifications and supplier updates)
    const supplier = await Supplier.findOne({ _id: purchase.supplier, company: companyId });

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

          // Send stock received notification
          try {
            await notifyStockReceived(
              companyId,
              product,
              item.quantity,
              supplier
            );

            // Check if stock is now low or out after adding
            if (product.reorderPoint && newStock <= product.reorderPoint) {
              await notifyLowStock(companyId, product, newStock);
            }
            if (newStock === 0) {
              await notifyOutOfStock(companyId, product);
            }
          } catch (notifError) {
            console.error('Failed to send stock notification:', notifError);
          }
        }
      }

      purchase.stockAdded = true;
      purchase.status = 'received';
      purchase.receivedDate = new Date();
    }

    // Update supplier stats (supplier was fetched earlier)
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

    // Create journal entry for payment (Accounts Payable Debit, Cash/Bank Credit)
    // Note: Capital is used for VALIDATION only - payment always goes through Cash/Bank
    try {
      await JournalService.createPurchasePaymentEntry(companyId, req.user.id, {
        purchaseNumber: purchase.purchaseNumber,
        date: new Date(),
        amount: amount,
        paymentMethod: paymentMethod
      });
    } catch (journalError) {
      console.error('Error creating journal entry for purchase payment:', journalError);
      // Don't fail the payment if journal entry fails
    }

    // Note: Capital is used for VALIDATION only - to ensure the business has enough owner's equity
    // Capital does NOT decrease when purchases are made. Capital only decreases when:
    // - Owner takes money OUT (dividend)
    // - Company makes losses
    // The actual payment still goes through Cash/Bank as normal.

    // Create bank transaction if payment method is bank transfer and bank account is specified
    let bankTransaction = null;
    if (paymentMethod === 'bank_transfer' && req.body.bankAccountId) {
      try {
        const bankAccount = await BankAccount.findOne({
          _id: req.body.bankAccountId,
          company: companyId,
          isActive: true
        });
        
        if (bankAccount) {
          // Get current balance
          const currentBalance = bankAccount.currentBalance;
          
          // Create withdrawal transaction (debit)
          const transaction = new BankTransaction({
            company: companyId,
            account: bankAccount._id,
            type: 'withdrawal',
            amount: amount,
            balanceAfter: currentBalance - amount,
            description: `Payment made: Purchase #${purchase.purchaseNumber}`,
            date: new Date(),
            referenceNumber: reference || purchase.purchaseNumber,
            paymentMethod: 'bank_transfer',
            status: 'completed',
            reference: purchase._id,
            referenceType: 'Purchase',
            createdBy: req.user._id,
            notes: notes || `Payment for purchase ${purchase.purchaseNumber} to ${supplier?.name || 'Supplier'}`
          });
          
          await transaction.save();
          
          // Update bank account balance
          bankAccount.currentBalance = currentBalance - amount;
          await bankAccount.save();
          
          bankTransaction = transaction;
        }
      } catch (bankError) {
        console.error('Error creating bank transaction:', bankError);
        // Don't fail the payment if bank transaction fails
      }
    }

    // Invalidate report cache - payment affects Balance Sheet (cash, payables) and P&L
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      data: purchase,
      bankTransaction: bankTransaction
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

    // Invalidate report cache - cancellation affects Balance Sheet and P&L
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

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

    // Create PDF document with pagination support
    const doc = new PDFDocument({ margin: 50, bufferPages: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=purchase-${purchase.purchaseNumber}.pdf`);

    doc.pipe(res);

    const currency = purchase.currency || 'FRW';
    const currencySymbol = currency === 'USD' ? '$' : '';
    const fmt = (v) => (currencySymbol ? `${currencySymbol} ${Number(v || 0).toFixed(2)}` : Number(v || 0).toLocaleString());

    let page = 1;

    const drawHeader = () => {
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#111827').text('PURCHASE ORDER', 50, 48);
      doc.fontSize(9).font('Helvetica').fillColor('#6b7280');
      doc.text(`Purchase Number: ${purchase.purchaseNumber}`, 50, 74);
      doc.text(`Purchase Date: ${new Date(purchase.purchaseDate).toLocaleDateString()}`, 50, 88);
      doc.text(`Status: ${purchase.status.toUpperCase()}`, 50, 102);
      doc.text(`Currency: ${currency}`, 50, 116);

      // Supplier box
      doc.rect(330, 74, 220, 70).fillAndStroke('#ffffff', '#e5e7eb');
      doc.fillColor('#374151').font('Helvetica-Bold').fontSize(10).text('SUPPLIER', 340, 78);
      doc.font('Helvetica').fontSize(10).fillColor('#111827');
      doc.text(purchase.supplierName || purchase.supplier?.name || 'N/A', 340, 96);
      if (purchase.supplierTin) doc.text(`TIN: ${purchase.supplierTin}`, 340, 110);
      if (purchase.supplierAddress) doc.text(purchase.supplierAddress, 340, 124, { width: 200 });

      // horizontal rule
      doc.moveTo(50, 150).lineTo(doc.page.width - 50, 150).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
    };

    const drawFooter = (p) => {
      const bottom = doc.page.height - 40;
      doc.fontSize(8).fillColor('#9ca3af').font('Helvetica');
      doc.text(`Generated: ${new Date().toLocaleString()}`, 50, bottom, { align: 'left' });
      doc.text(`Page ${p}`, 0, bottom, { align: 'right' });
    };

    const tableHeader = (y) => {
      doc.rect(50, y, doc.page.width - 100, 28).fill('#111827');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
      doc.text('#', 56, y + 8);
      doc.text('Item / Description', 80, y + 8);
      doc.text('Qty', 320, y + 8, { width: 30, align: 'right' });
      doc.text('Unit Cost', 370, y + 8, { width: 70, align: 'right' });
      doc.text('Tax', 450, y + 8, { width: 50, align: 'right' });
      doc.text('Total', 510, y + 8, { width: 70, align: 'right' });
    };

    // Begin page
    drawHeader();
    let y = 170;
    tableHeader(y);
    y += 36;
    doc.font('Helvetica').fontSize(9).fillColor('#111827');

    purchase.items.forEach((item, idx) => {
      if (y > doc.page.height - 150) {
        drawFooter(page);
        doc.addPage();
        page += 1;
        drawHeader();
        y = 170;
        tableHeader(y);
        y += 36;
        doc.font('Helvetica').fontSize(9).fillColor('#111827');
      }

      if (idx % 2 === 0) {
        doc.rect(50, y - 6, doc.page.width - 100, 18).fill('#f9fafb');
      }

      doc.fillColor('#111827');
      doc.text(`${idx + 1}`, 56, y);
      doc.text(item.product?.name || item.description || 'N/A', 80, y, { width: 230 });
      doc.text((item.quantity || 0).toString(), 320, y, { width: 40, align: 'right' });
      doc.text(fmt(item.unitCost), 370, y, { width: 70, align: 'right' });
      doc.text(`${item.taxCode || 'A'} (${item.taxRate}%)`, 450, y, { width: 50, align: 'right' });
      doc.text(fmt(item.totalWithTax), 510, y, { width: 70, align: 'right' });
      y += 20;
    });

    // Totals block
    if (y > doc.page.height - 200) {
      drawFooter(page);
      doc.addPage();
      page += 1;
      drawHeader();
      y = 170;
    }

    const totalsX = doc.page.width - 260;
    doc.rect(totalsX - 10, y, 230, 110).fill('#ffffff').stroke('#e5e7eb');
    let ty = y + 8;
    doc.fillColor('#6b7280').fontSize(10).font('Helvetica');
    doc.text('Subtotal', totalsX, ty, { width: 140, align: 'left' });
    doc.fillColor('#111827').text(fmt(purchase.subtotal), totalsX + 100, ty, { width: 120, align: 'right' });
    ty += 18;

    doc.fillColor('#6b7280').text('Tax', totalsX, ty);
    doc.fillColor('#111827').text(fmt(purchase.totalTax), totalsX + 100, ty, { width: 120, align: 'right' });
    ty += 18;

    doc.rect(totalsX - 10, ty - 6, 230, 40).fill('#111827');
    doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold');
    doc.text('TOTAL', totalsX, ty, { width: 140, align: 'left' });
    doc.text(fmt(purchase.grandTotal), totalsX + 100, ty + 2, { width: 120, align: 'right' });
    ty += 52;

    doc.fillColor('#10b981').fontSize(10).font('Helvetica');
    doc.text('Paid', totalsX, ty - 8, { width: 140, align: 'left' });
    doc.text(fmt(purchase.amountPaid), totalsX + 100, ty - 8, { width: 120, align: 'right' });
    ty += 18;

    doc.fillColor('#ef4444').fontSize(11).font('Helvetica-Bold');
    doc.text('BALANCE', totalsX, ty - 8, { width: 140, align: 'left' });
    doc.text(fmt(purchase.balance), totalsX + 100, ty - 8, { width: 120, align: 'right' });

    // Notes
    y += 140;
    if (purchase.notes) {
      if (y > doc.page.height - 120) {
        drawFooter(page);
        doc.addPage();
        page += 1;
        drawHeader();
        y = 170;
      }
      doc.moveDown(1);
      doc.fillColor('#374151').fontSize(10).font('Helvetica-Bold').text('NOTES', 56, y);
      y += 14;
      doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(purchase.notes, 56, y, { width: doc.page.width - 120 });
    }

    // Finalize
    drawFooter(page);
    doc.end();
  } catch (error) {
    next(error);
  }
};
