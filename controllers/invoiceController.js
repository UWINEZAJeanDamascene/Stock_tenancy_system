const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Client = require('../models/Client');
const StockMovement = require('../models/StockMovement');
const InvoiceReceiptMetadata = require('../models/InvoiceReceiptMetadata');
const PDFDocument = require('pdfkit');
const notificationService = require('../services/notificationHelper');
const emailService = require('../services/emailService');
const Company = require('../models/Company');
const cacheService = require('../services/cacheService');
const { BankAccount, BankTransaction } = require('../models/BankAccount');
const JournalService = require('../services/journalService');

const { notifyInvoiceCreated, notifyPaymentReceived, notifyPaymentOverdue, notifyInvoiceSent } = require('../services/notificationHelper');

// @desc    Get all invoices
// @route   GET /api/invoices
// @access  Private
exports.getInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, status, clientId, startDate, endDate } = req.query;
    const query = { company: companyId };

    if (status) {
      query.status = status;
    }

    if (clientId) {
      query.client = clientId;
    }

    if (startDate || endDate) {
      query.invoiceDate = {};
      if (startDate) query.invoiceDate.$gte = new Date(startDate);
      if (endDate) query.invoiceDate.$gte = new Date(endDate);
    }

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .populate('client', 'name code contact')
      .populate('items.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('quotation', 'quotationNumber')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: invoices.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: invoices
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single invoice
// @route   GET /api/invoices/:id
// @access  Private
exports.getInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId })
      .populate('client', 'name code contact type taxId')
      .populate('items.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('quotation', 'quotationNumber')
      .populate('payments.recordedBy', 'name email');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    // Get receipt metadata if exists
    const receiptMetadata = await InvoiceReceiptMetadata.findOne({ invoice: invoice._id, company: companyId });

    res.json({
      success: true,
      data: {
        ...invoice.toObject(),
        receiptMetadata
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new invoice (draft)
// @route   POST /api/invoices
// @access  Private (admin, stock_manager, sales)
exports.createInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { items, client: clientId, quotation, currency, paymentTerms, customerTin, customerAddress, customerName } = req.body;

    // Get client details for TIN and address
    const client = await Client.findOne({ _id: clientId, company: companyId });
    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    const productMap = {};
    for (const item of items) {
      const product = await Product.findOne({ _id: item.product, company: companyId });
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${item.product}`
        });
      }
      productMap[item.product.toString()] = product;
      if (product.currentStock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.currentStock}, Required: ${item.quantity}`
        });
      }
    }

    // Process items with tax codes
    const processedItems = items.map((item, index) => {
      const subtotal = item.quantity * item.unitPrice;
      const discount = item.discount || 0;
      const netAmount = subtotal - discount;
      const product = productMap[item.product.toString()];
      const taxRate = (item.taxRate != null) ? item.taxRate : (product?.taxRate != null ? product.taxRate : 0);
      const taxCode = item.taxCode || product?.taxCode || 'A';
      const taxAmount = netAmount * (taxRate / 100);
      const totalWithTax = netAmount + taxAmount;

      return {
        ...item,
        itemCode: item.itemCode || `ITEM-${index + 1}`,
        taxCode,
        taxRate,
        subtotal,
        taxAmount,
        totalWithTax
      };
    });

    const invoice = await Invoice.create({
      ...req.body,
      company: companyId,
      items: processedItems,
      customerTin: customerTin || client.taxId,
      customerName: customerName || client.name,
      customerAddress: customerAddress || client.contact?.address,
      createdBy: req.user.id
    });

    await invoice.populate('client items.product createdBy');

    // Auto-deduct stock immediately when invoice is created (sale happens)
    for (const item of invoice.items) {
      const product = await Product.findOne({ _id: item.product._id, company: companyId });
      
      if (product) {
        const previousStock = product.currentStock;
        const newStock = previousStock - item.quantity;

        // Create stock movement (ledger entry)
        await StockMovement.create({
          company: companyId,
          product: product._id,
          type: 'out',
          reason: 'sale',
          quantity: item.quantity,
          previousStock,
          newStock,
          unitCost: item.unitPrice,
          totalCost: item.totalWithTax,
          referenceType: 'invoice',
          referenceNumber: invoice.invoiceNumber,
          referenceDocument: invoice._id,
          referenceModel: 'Invoice',
          notes: `Invoice ${invoice.invoiceNumber} - Sale`,
          performedBy: req.user.id
        });

        // Update product stock
        product.currentStock = newStock;
        product.lastSaleDate = new Date();
        await product.save();
      }
    }

    // Mark invoice as stock deducted
    invoice.stockDeducted = true;
    invoice.status = 'confirmed';
    invoice.confirmedDate = new Date();
    invoice.confirmedBy = req.user.id;
    await invoice.save();

    // Update client outstanding balance
    client.outstandingBalance += invoice.roundedAmount;
    await client.save();

    // Create journal entry for the sale (Accounts Receivable Debit, Sales Revenue + VAT Credit)
    try {
      await JournalService.createInvoiceEntry(companyId, req.user.id, {
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        date: invoice.invoiceDate,
        total: invoice.roundedAmount,
        vatAmount: invoice.totalTax
      });
    } catch (journalError) {
      console.error('Error creating journal entry for invoice:', journalError);
      // Don't fail the invoice creation if journal entry fails
    }

    // Attempt to send invoice email to client if email exists
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      try {
        const company = await Company.findById(companyId);
        const clientData = await Client.findById(clientId);
        await emailService.sendInvoiceEmail(invoice, company, clientData);
        try { await notifyInvoiceSent(companyId, invoice); } catch (e) { console.error('notifyInvoiceSent failed', e); }
      } catch (emailErr) {
        console.error('Invoice email error:', emailErr);
      }
    }

    // Update client outstanding balance
    client.outstandingBalance += invoice.roundedAmount;
    await client.save();

    // Notify invoice created
    try {
      await notifyInvoiceCreated(companyId, invoice);
    } catch (e) {
      console.error('notifyInvoiceCreated failed', e);
    }

    res.status(201).json({
      success: true,
      data: invoice
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update invoice
// @route   PUT /api/invoices/:id
// @access  Private (admin, stock_manager, sales)
exports.updateInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let invoice = await Invoice.findOne({ _id: req.params.id, company: companyId });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    // Only draft invoices can be updated
    if (invoice.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft invoices can be updated'
      });
    }

    // If items are updated, validate stock
    if (req.body.items) {
      // build product map for provided items
      const updateProductMap = {};
      for (const item of req.body.items) {
        const product = await Product.findOne({ _id: item.product, company: companyId });
        if (!product) {
          return res.status(400).json({
            success: false,
            message: `Product not found: ${item.product}`
          });
        }
        updateProductMap[item.product.toString()] = product;
        if (product.currentStock < item.quantity) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for ${product.name}. Available: ${product.currentStock}, Required: ${item.quantity}`
          });
        }
      }

      // Recalculate item totals using product defaults when missing
      req.body.items = req.body.items.map((item, index) => {
        const subtotal = item.quantity * item.unitPrice;
        const discount = item.discount || 0;
        const netAmount = subtotal - discount;
        const product = updateProductMap[item.product.toString()];
        const taxRate = (item.taxRate != null) ? item.taxRate : (product?.taxRate != null ? product.taxRate : 0);
        const taxCode = item.taxCode || product?.taxCode || 'A';
        const taxAmount = netAmount * (taxRate / 100);
        const totalWithTax = netAmount + taxAmount;
        return {
          ...item,
          itemCode: item.itemCode || `ITEM-${index + 1}`,
          taxCode,
          taxRate,
          subtotal,
          taxAmount,
          totalWithTax
        };
      });
    }

    invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      { new: true, runValidators: true }
    )
      .populate('client items.product createdBy');

    res.json({
      success: true,
      data: invoice
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete invoice
// @route   DELETE /api/invoices/:id
// @access  Private (admin)
exports.deleteInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    // Only draft invoices can be deleted
    if (invoice.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft invoices can be deleted'
      });
    }

    await invoice.deleteOne();

    res.json({
      success: true,
      message: 'Invoice deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Confirm invoice (deduct stock)
// @route   PUT /api/invoices/:id/confirm
// @access  Private (admin, stock_manager)
exports.confirmInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId }).populate('items.product');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    if (invoice.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft invoices can be confirmed'
      });
    }

    // Validate stock and deduct
    for (const item of invoice.items) {
      const product = await Product.findOne({ _id: item.product._id, company: companyId });
      
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${item.product.name}`
        });
      }

      if (product.currentStock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.currentStock}, Required: ${item.quantity}`
        });
      }

      const previousStock = product.currentStock;
      const newStock = previousStock - item.quantity;

      // Create stock movement (ledger entry)
      await StockMovement.create({
        company: companyId,
        product: product._id,
        type: 'out',
        reason: 'sale',
        quantity: item.quantity,
        previousStock,
        newStock,
        unitCost: item.unitPrice,
        totalCost: item.totalWithTax,
        referenceType: 'invoice',
        referenceNumber: invoice.invoiceNumber,
        referenceDocument: invoice._id,
        referenceModel: 'Invoice',
        notes: `Invoice ${invoice.invoiceNumber} - Sale`,
        performedBy: req.user.id
      });

      // Update product stock
      product.currentStock = newStock;
      product.lastSaleDate = new Date();
      await product.save();
    }

    // Update invoice status
    invoice.status = 'confirmed';
    invoice.stockDeducted = true;
    invoice.confirmedDate = new Date();
    invoice.confirmedBy = req.user.id;
    await invoice.save();

    // Create journal entry for the sale (Accounts Receivable Debit, Sales Revenue + VAT Credit)
    try {
      await JournalService.createInvoiceEntry(companyId, req.user.id, {
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        date: invoice.invoiceDate,
        total: invoice.roundedAmount,
        vatAmount: invoice.totalTax
      });
    } catch (journalError) {
      console.error('Error creating journal entry for invoice:', journalError);
      // Don't fail the invoice confirmation if journal entry fails
    }

    // Notify payment received
    try {
      await notifyPaymentReceived(companyId, invoice, 0);
    } catch (e) {
      console.error('notifyPaymentReceived failed', e);
    }

    // Update linked quotation if exists
    if (invoice.quotation) {
      const Quotation = require('../models/Quotation');
      await Quotation.findByIdAndUpdate(invoice.quotation, {
        status: 'converted',
        convertedToInvoice: invoice._id,
        conversionDate: new Date()
      });
    }

    // Update client stats
    const client = await Client.findOne({ _id: invoice.client, company: companyId });
    if (client) {
      client.outstandingBalance += invoice.roundedAmount;
      await client.save();
    }

    // Invalidate report cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Invoice confirmed and stock deducted',
      data: invoice
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record payment for invoice
// @route   POST /api/invoices/:id/payment
// @access  Private (admin, stock_manager, sales)
exports.recordPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference, notes } = req.body;

    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId })
      .populate('items.product');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    if (invoice.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot record payment for cancelled invoice'
      });
    }

    if (amount > invoice.balance) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount exceeds invoice balance'
      });
    }

    // Add payment
    invoice.payments.push({
      amount,
      paymentMethod,
      reference,
      notes,
      recordedBy: req.user.id
    });

    invoice.amountPaid += amount;

    // Explicitly recalculate balance
    invoice.balance = invoice.roundedAmount - invoice.amountPaid;
    if (invoice.balance < 0) invoice.balance = 0;

    // Auto-confirm if stock not yet deducted and payment is made
    if (!invoice.stockDeducted && invoice.status === 'draft') {
      for (const item of invoice.items) {
        const product = await Product.findOne({ _id: item.product._id, company: companyId });
        
        if (product && product.currentStock >= item.quantity) {
          const previousStock = product.currentStock;
          const newStock = previousStock - item.quantity;

          await StockMovement.create({
            company: companyId,
            product: product._id,
            type: 'out',
            reason: 'sale',
            quantity: item.quantity,
            previousStock,
            newStock,
            unitCost: item.unitPrice,
            totalCost: item.totalWithTax,
            referenceType: 'invoice',
            referenceNumber: invoice.invoiceNumber,
            referenceDocument: invoice._id,
            referenceModel: 'Invoice',
            notes: `Sale via invoice ${invoice.invoiceNumber}`,
            performedBy: req.user.id
          });

          product.currentStock = newStock;
          product.lastSaleDate = new Date();
          await product.save();
        }
      }

      invoice.stockDeducted = true;
      invoice.status = 'confirmed';
      invoice.confirmedDate = new Date();
      invoice.confirmedBy = req.user.id;
    }

    // Update client stats
    const client = await Client.findOne({ _id: invoice.client, company: companyId });
    if (client) {
      client.totalPurchases += amount;
      client.outstandingBalance -= amount;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      client.lastPurchaseDate = new Date();
      await client.save();
    }

    await invoice.save();

    // Create journal entry for payment (Cash/Bank Debit, Accounts Receivable Credit)
    try {
      // Get bank account code if bank payment
      let bankAccountCode = null;
      if ((paymentMethod === 'bank_transfer' || paymentMethod === 'cheque' || paymentMethod === 'mobile_money') && req.body.bankAccountId) {
        const bankAccount = await BankAccount.findOne({
          _id: req.body.bankAccountId,
          company: companyId,
          isActive: true
        });
        if (bankAccount && bankAccount.accountCode) {
          bankAccountCode = bankAccount.accountCode;
        }
      }
      
      await JournalService.createInvoicePaymentEntry(companyId, req.user.id, {
        invoiceNumber: invoice.invoiceNumber,
        date: new Date(),
        amount: amount,
        paymentMethod: paymentMethod,
        bankAccountCode: bankAccountCode
      });
    } catch (journalError) {
      console.error('Error creating journal entry for payment:', journalError);
      // Don't fail the payment if journal entry fails
    }

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
          
          // Create deposit transaction
          const transaction = new BankTransaction({
            company: companyId,
            account: bankAccount._id,
            type: 'deposit',
            amount: amount,
            balanceAfter: currentBalance + amount,
            description: `Payment received: Invoice #${invoice.invoiceNumber}`,
            date: new Date(),
            referenceNumber: reference || invoice.invoiceNumber,
            paymentMethod: 'bank_transfer',
            status: 'completed',
            reference: invoice._id,
            referenceType: 'Invoice',
            createdBy: req.user._id,
            notes: notes || `Payment for invoice ${invoice.invoiceNumber} from ${invoice.client?.name || 'Customer'}`
          });
          
          await transaction.save();
          
          // Update bank account balance
          bankAccount.currentBalance = currentBalance + amount;
          await bankAccount.save();
          
          bankTransaction = transaction;
        }
      } catch (bankError) {
        console.error('Error creating bank transaction:', bankError);
        // Don't fail the payment if bank transaction fails
      }
    }

    // Notify payment recorded
    try {
      await notifyPaymentReceived(companyId, invoice, amount);
    } catch (e) {
      console.error('notifyPaymentReceived failed', e);
    }

    // Invalidate report cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      data: invoice,
      bankTransaction: bankTransaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel invoice (reverse stock)
// @route   PUT /api/invoices/:id/cancel
// @access  Private (admin)
exports.cancelInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId }).populate('items.product');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel fully paid invoice. Please contact administrator'
      });
    }

    // Reverse stock if it was deducted
    if (invoice.stockDeducted) {
      for (const item of invoice.items) {
        const product = await Product.findOne({ _id: item.product._id, company: companyId });
        
        if (product) {
          const previousStock = product.currentStock;
          const newStock = previousStock + item.quantity;

          await StockMovement.create({
            company: companyId,
            product: product._id,
            type: 'in',
            reason: 'return',
            quantity: item.quantity,
            previousStock,
            newStock,
            unitCost: item.unitPrice,
            totalCost: item.totalWithTax,
            referenceType: 'invoice',
            referenceNumber: invoice.invoiceNumber,
            referenceDocument: invoice._id,
            referenceModel: 'Invoice',
            notes: `Invoice ${invoice.invoiceNumber} cancelled - Stock reversal`,
            performedBy: req.user.id
          });

          product.currentStock = newStock;
          await product.save();
        }
      }
    }

    // Update client outstanding balance
    const client = await Client.findOne({ _id: invoice.client, company: companyId });
    if (client) {
      const unpaidAmount = invoice.roundedAmount - invoice.amountPaid;
      client.outstandingBalance -= unpaidAmount;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      await client.save();
    }

    invoice.status = 'cancelled';
    invoice.cancelledDate = new Date();
    invoice.cancelledBy = req.user.id;
    invoice.cancellationReason = reason;

    await invoice.save();

    // Invalidate report cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Invoice cancelled and stock reversed',
      data: invoice
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Save receipt metadata
// @route   POST /api/invoices/:id/receipt-metadata
// @access  Private (admin)
exports.saveReceiptMetadata = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { sdcId, receiptNumber, receiptSignature, internalData, mrcCode, deviceId, fiscalDate } = req.body;

    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    let metadata = await InvoiceReceiptMetadata.findOne({ invoice: invoice._id, company: companyId });

    if (metadata) {
      metadata = await InvoiceReceiptMetadata.findByIdAndUpdate(
        metadata._id,
        { sdcId, receiptNumber, receiptSignature, internalData, mrcCode, deviceId, fiscalDate },
        { new: true }
      );
    } else {
      metadata = await InvoiceReceiptMetadata.create({
        invoice: invoice._id,
        company: companyId,
        sdcId,
        receiptNumber,
        receiptSignature,
        internalData,
        mrcCode,
        deviceId,
        fiscalDate: fiscalDate || new Date()
      });
    }

    res.json({
      success: true,
      data: metadata
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get invoices for a specific client
// @route   GET /api/invoices/client/:clientId
// @access  Private
exports.getClientInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoices = await Invoice.find({ client: req.params.clientId, company: companyId })
      .populate('items.product', 'name sku')
      .populate('createdBy', 'name email')
      .sort({ invoiceDate: -1 });

    res.json({
      success: true,
      count: invoices.length,
      data: invoices
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get invoices containing a specific product
// @route   GET /api/invoices/product/:productId
// @access  Private
exports.getProductInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoices = await Invoice.find({ 'items.product': req.params.productId, company: companyId })
      .populate('client', 'name code')
      .populate('createdBy', 'name email')
      .sort({ invoiceDate: -1 });

    res.json({
      success: true,
      count: invoices.length,
      data: invoices
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate invoice PDF
// @route   GET /api/invoices/:id/pdf
// @access  Private
exports.generateInvoicePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId })
      .populate('client')
      .populate('items.product')
      .populate('createdBy');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    // Get company info
    const company = await Company.findById(companyId);

    // Create PDF document with more breathable layout
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.invoiceNumber}.pdf`);

    // Pipe PDF to response
    doc.pipe(res);

    const currency = invoice.currency || 'FRW';
    const currencySymbol = currency === 'USD' ? '$' : '';

    // Helper to format money
    const fmt = (v) => (currencySymbol ? `${currencySymbol} ${Number(v || 0).toFixed(2)}` : Number(v || 0).toLocaleString());

    // Page counter
    let pageNumber = 1;

    // Draw header - reusable for first page and subsequent pages
    const drawHeader = () => {
      // Clear top area
      doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(20);
      doc.text(company?.name || 'Company', 50, 48);

      doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
      const contactX = 50;
      let contactY = 70;
      if (company?.address) { doc.text(company.address, contactX, contactY, { width: 260 }); contactY += 12; }
      if (company?.phone) { doc.text(`Phone: ${company.phone}`, contactX, contactY); contactY += 12; }
      if (company?.email) { doc.text(`Email: ${company.email}`, contactX, contactY); }

      // Invoice title block
      doc.fontSize(26).fillColor('#111827').font('Helvetica-Bold');
      doc.text('INVOICE', 0, 50, { align: 'right' });
      doc.fontSize(10).font('Helvetica').fillColor('#6b7280');
      doc.text(`# ${invoice.invoiceNumber}`, 0, 80, { align: 'right' });

      // Status badge
      const statusColors = {
        'draft': ['#6b7280', 'Draft'],
        'confirmed': ['#f59e0b', 'Confirmed'],
        'paid': ['#10b981', 'Paid'],
        'partial': ['#3b82f6', 'Partial'],
        'cancelled': ['#ef4444', 'Cancelled']
      };
      const statusInfo = statusColors[invoice.status] || ['#6b7280', invoice.status];
      doc.fillColor(statusInfo[0]).font('Helvetica-Bold').fontSize(10);
      doc.text(statusInfo[1].toUpperCase(), 0, 98, { align: 'right' });

      // Horizontal rule
      doc.moveTo(50, 120).lineTo(doc.page.width - 50, 120).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
    };

    // Footer: page numbers and timestamp
    const drawFooter = (pn) => {
      const bottom = doc.page.height - 40;
      doc.fontSize(8).fillColor('#9ca3af').font('Helvetica');
      doc.text(`Generated: ${new Date().toLocaleString()}`, 50, bottom, { align: 'left' });
      doc.text(`Page ${pn}`, 0, bottom, { align: 'right' });
    };

    // Draw invoice details and bill-to box
    const drawInvoiceDetails = (startY) => {
      // Dates box
      doc.rect(50, startY, 230, 80).fillAndStroke('#ffffff', '#e5e7eb');
      doc.fillColor('#374151').fontSize(10).font('Helvetica-Bold');
      doc.text('INVOICE DETAILS', 60, startY + 8);

      doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
      doc.text('Invoice Date:', 60, startY + 26);
      doc.fillColor('#111827').text(new Date(invoice.invoiceDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }), 140, startY + 26);

      doc.fillColor('#6b7280').text('Due Date:', 60, startY + 42);
      doc.fillColor('#111827').text(invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'On Delivery', 140, startY + 42);

      doc.fillColor('#6b7280').text('Currency:', 60, startY + 58);
      doc.fillColor('#111827').text(currency, 140, startY + 58);

      // Bill To
      doc.rect(300, startY, 250, 80).fillAndStroke('#ffffff', '#e5e7eb');
      doc.fillColor('#374151').fontSize(10).font('Helvetica-Bold');
      doc.text('BILL TO', 310, startY + 8);
      doc.font('Helvetica').fontSize(10).fillColor('#111827');
      doc.text(invoice.customerName || invoice.client?.name || 'N/A', 310, startY + 28);
      doc.fontSize(9).fillColor('#6b7280');
      if (invoice.customerTin) doc.text(`TIN: ${invoice.customerTin}`, 310, startY + 44);
      if (invoice.customerAddress) doc.text(invoice.customerAddress, 310, startY + 58, { width: 230 });
    };

    // Table header renderer (callable on new pages)
    const tableHeader = (y) => {
      doc.rect(50, y, doc.page.width - 100, 28).fill('#111827');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
      doc.text('#', 56, y + 8);
      doc.text('Item / Description', 80, y + 8);
      doc.text('Qty', 320, y + 8, { width: 30, align: 'right' });
      doc.text('Unit Price', 370, y + 8, { width: 70, align: 'right' });
      doc.text('Tax', 450, y + 8, { width: 50, align: 'right' });
      doc.text('Total', 510, y + 8, { width: 70, align: 'right' });
    };

    // Start first page
    drawHeader();
    drawInvoiceDetails(140);

    // Table
    let y = 230;
    tableHeader(y);
    y += 36;
    doc.font('Helvetica').fontSize(9).fillColor('#111827');

    // Rows with automatic page breaks and repeated header
    invoice.items.forEach((item, idx) => {
      // Page break if low space
      if (y > doc.page.height - 150) {
        // footer for the page
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140; // position after header
        tableHeader(y);
        y += 36;
        doc.font('Helvetica').fontSize(9).fillColor('#111827');
      }

      // Alternate background
      if (idx % 2 === 0) {
        doc.rect(50, y - 6, doc.page.width - 100, 18).fill('#f9fafb');
        doc.fillColor('#111827');
      }

      const productName = item.product?.name || item.description || 'N/A';
      doc.fillColor('#111827');
      doc.text(`${idx + 1}`, 56, y);
      doc.text(productName, 80, y, { width: 230 });
      doc.text((item.quantity || 0).toString(), 320, y, { width: 40, align: 'right' });
      doc.text(fmt(item.unitPrice), 370, y, { width: 70, align: 'right' });
      doc.text(`${item.taxCode || 'A'} (${item.taxRate}%)`, 450, y, { width: 50, align: 'right' });
      doc.text(fmt(item.totalWithTax), 510, y, { width: 70, align: 'right' });
      y += 20;
    });

    // Draw totals block (ensure space)
    if (y > doc.page.height - 200) {
      drawFooter(pageNumber);
      doc.addPage();
      pageNumber += 1;
      drawHeader();
      y = 140;
    }

    const totalsX = doc.page.width - 260;
    doc.rect(totalsX - 10, y, 230, 110).fill('#ffffff').stroke('#e5e7eb');
    let ty = y + 8;
    doc.fillColor('#6b7280').fontSize(10).font('Helvetica');
    doc.text('Subtotal', totalsX, ty, { width: 140, align: 'left' });
    doc.fillColor('#111827').text(fmt(invoice.subtotal), totalsX + 100, ty, { width: 120, align: 'right' });
    ty += 18;

    if (invoice.totalDiscount > 0) {
      doc.fillColor('#10b981').text('Discount', totalsX, ty);
      doc.fillColor('#10b981').text(`- ${fmt(invoice.totalDiscount)}`, totalsX + 100, ty, { width: 120, align: 'right' });
      ty += 18;
    }

    doc.fillColor('#6b7280').text('Tax', totalsX, ty);
    doc.fillColor('#111827').text(fmt(invoice.totalTax), totalsX + 100, ty, { width: 120, align: 'right' });
    ty += 18;

    if (invoice.roundedAmount && invoice.roundedAmount !== invoice.grandTotal) {
      doc.fillColor('#6b7280').text('Rounded', totalsX, ty);
      doc.fillColor('#111827').text(fmt(invoice.roundedAmount), totalsX + 100, ty, { width: 120, align: 'right' });
      ty += 18;
    }

    doc.rect(totalsX - 10, ty - 6, 230, 40).fill('#111827');
    doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold');
    doc.text('GRAND TOTAL', totalsX, ty, { width: 140, align: 'left' });
    doc.text(fmt(invoice.grandTotal), totalsX + 100, ty + 2, { width: 120, align: 'right' });
    ty += 52;

    if (invoice.amountPaid > 0) {
      doc.fillColor('#10b981').fontSize(10).font('Helvetica');
      doc.text('Paid', totalsX, ty - 8, { width: 140, align: 'left' });
      doc.text(`- ${fmt(invoice.amountPaid)}`, totalsX + 100, ty - 8, { width: 120, align: 'right' });
      ty += 18;

      doc.fillColor('#ef4444').fontSize(11).font('Helvetica-Bold');
      doc.text('BALANCE DUE', totalsX, ty - 8, { width: 140, align: 'left' });
      doc.text(fmt(invoice.balance), totalsX + 100, ty - 8, { width: 120, align: 'right' });
    }

    // Payment history
    y += 130;
    if (invoice.payments && invoice.payments.length > 0) {
      if (y > doc.page.height - 120) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }

      doc.rect(50, y, doc.page.width - 100, 20).fill('#f0fdf4');
      doc.fillColor('#166534').fontSize(10).font('Helvetica-Bold');
      doc.text('PAYMENT HISTORY', 56, y + 5);
      y += 28;

      doc.font('Helvetica').fontSize(9).fillColor('#111827');
      invoice.payments.forEach((payment, idx) => {
        if (y > doc.page.height - 100) {
          drawFooter(pageNumber);
          doc.addPage();
          pageNumber += 1;
          drawHeader();
          y = 140;
        }

        doc.text(`${idx + 1}. ${payment.paymentMethod?.replace(/_/g, ' ').toUpperCase() || 'Payment'}`, 56, y);
        doc.text(fmt(payment.amount), 510, y, { width: 70, align: 'right' });
        doc.text(`Ref: ${payment.reference || 'N/A'}`, 300, y);
        doc.text(`Date: ${payment.paidDate ? new Date(payment.paidDate).toLocaleDateString() : 'N/A'}`, 380, y);
        y += 16;
      });
    }

    // Terms and notes
    y += 18;
    if (invoice.terms) {
      if (y > doc.page.height - 120) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }
      doc.rect(50, y, doc.page.width - 100, 30).fill('#fffbeb');
      doc.fillColor('#92400e').fontSize(10).font('Helvetica-Bold');
      doc.text('TERMS & CONDITIONS', 56, y + 6);
      y += 20;
      doc.font('Helvetica').fontSize(9).fillColor('#111827');
      doc.text(invoice.terms, 56, y + 6, { width: doc.page.width - 120 });
      y += 40;
    }

    if (invoice.notes) {
      if (y > doc.page.height - 120) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }
      doc.fillColor('#374151').fontSize(10).font('Helvetica-Bold');
      doc.text('NOTES', 56, y);
      y += 14;
      doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
      doc.text(invoice.notes, 56, y, { width: doc.page.width - 120 });
    }

    // Finalize: draw footer on last page then end
    drawFooter(pageNumber);
    doc.end();
  } catch (error) {
    next(error);
  }
};

// @desc    Send invoice via email
// @route   POST /api/invoices/:id/send-email
// @access  Private (admin, stock_manager, sales)
exports.sendInvoiceEmail = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId })
      .populate('client');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    const company = await Company.findById(companyId);
    const clientData = await Client.findById(invoice.client);
    
    // Check if client has email
    const clientEmail = clientData?.contact?.email || invoice.customerEmail;
    if (!clientEmail) {
      return res.status(400).json({
        success: false,
        message: 'Client does not have an email address'
      });
    }

    // Send the invoice email
    await emailService.sendInvoiceEmail(invoice, company, clientData);
    
    // Notify invoice sent
    try { await notifyInvoiceSent(companyId, invoice); } catch (e) { console.error('notifyInvoiceSent failed', e); }
    
    res.json({
      success: true,
      message: 'Invoice sent to ' + clientEmail
    });
  } catch (error) {
    next(error);
  }
};
