const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Client = require('../models/Client');
const StockMovement = require('../models/StockMovement');
const InvoiceReceiptMetadata = require('../models/InvoiceReceiptMetadata');
const PDFDocument = require('pdfkit');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const Company = require('../models/Company');

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

    // Validate stock availability for all items BEFORE creating
    for (const item of items) {
      const product = await Product.findOne({ _id: item.product, company: companyId });
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${item.product}`
        });
      }
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

    // Attempt to send invoice email to client if email exists
    // Only send if explicitly requested or if client email exists
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      try {
        const company = await Company.findById(companyId);
        const clientData = await Client.findById(clientId);
        await emailService.sendInvoiceEmail(invoice, company, clientData);
      } catch (emailErr) {
        console.error('Invoice email error:', emailErr);
      }
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
      for (const item of req.body.items) {
        const product = await Product.findOne({ _id: item.product, company: companyId });
        if (!product) {
          return res.status(400).json({
            success: false,
            message: `Product not found: ${item.product}`
          });
        }
        if (product.currentStock < item.quantity) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for ${product.name}. Available: ${product.currentStock}, Required: ${item.quantity}`
          });
        }
      }
      
      // Recalculate item totals
      req.body.items = req.body.items.map((item, index) => {
        const subtotal = item.quantity * item.unitPrice;
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

    // Explicitly recalculate balance to ensure it's correct
    invoice.balance = invoice.roundedAmount - invoice.amountPaid;
    if (invoice.balance < 0) invoice.balance = 0;

    // Auto-confirm if stock not yet deducted and payment is made
    if (!invoice.stockDeducted && invoice.status === 'draft') {
      // Deduct stock on first payment
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

    // Update client stats whenever a payment is recorded
    const client = await Client.findOne({ _id: invoice.client, company: companyId });
    if (client) {
      client.totalPurchases += amount;
      client.outstandingBalance -= amount;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      client.lastPurchaseDate = new Date();
      await client.save();
    }

    await invoice.save();

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      data: invoice
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

          // Create reversal stock movement
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

          // Update product stock
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

    // Check if metadata already exists
    let metadata = await InvoiceReceiptMetadata.findOne({ invoice: invoice._id, company: companyId });

    if (metadata) {
      // Update existing
      metadata = await InvoiceReceiptMetadata.findByIdAndUpdate(
        metadata._id,
        { sdcId, receiptNumber, receiptSignature, internalData, mrcCode, deviceId, fiscalDate },
        { new: true }
      );
    } else {
      // Create new
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

    // Create PDF document
    const doc = new PDFDocument({ margin: 50 });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.invoiceNumber}.pdf`);

    // Pipe PDF to response
    doc.pipe(res);

    // Header
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(12).text(`Invoice Number: ${invoice.invoiceNumber}`);
    doc.text(`Invoice Date: ${new Date(invoice.invoiceDate).toLocaleDateString()}`);
    doc.text(`Due Date: ${invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : 'N/A'}`);
    doc.text(`Status: ${invoice.status.toUpperCase()}`);
    doc.text(`Currency: ${invoice.currency || 'FRW'}`);
    doc.moveDown();

    // Client info
    doc.text('Bill To:', { underline: true });
    doc.text(invoice.customerName || invoice.client?.name || 'N/A');
    if (invoice.customerTin) doc.text(`TIN: ${invoice.customerTin}`);
    if (invoice.customerAddress) doc.text(invoice.customerAddress);
    if (invoice.client?.contact?.phone) doc.text(`Phone: ${invoice.client.contact.phone}`);
    if (invoice.client?.contact?.email) doc.text(`Email: ${invoice.client.contact.email}`);
    doc.moveDown(2);

    // Items table header
    const tableTop = doc.y;
    doc.fontSize(10);
    doc.text('Item', 50, tableTop);
    doc.text('Code', 180, tableTop);
    doc.text('Qty', 230, tableTop);
    doc.text('Price', 270, tableTop);
    doc.text('Tax', 330, tableTop);
    doc.text('Total', 400, tableTop);

    let yPosition = tableTop + 20;
    doc.fontSize(9);
    invoice.items.forEach(item => {
      const productName = item.product?.name || item.description || 'N/A';
      const code = item.itemCode || '-';
      const qty = `${item.quantity} ${item.unit || ''}`;
      const price = `$${item.unitPrice.toFixed(2)}`;
      const tax = `${item.taxCode || 'A'}: ${item.taxRate}%`;
      const total = `$${item.totalWithTax.toFixed(2)}`;
      
      doc.text(productName.substring(0, 25), 50, yPosition);
      doc.text(code, 180, yPosition);
      doc.text(qty, 230, yPosition);
      doc.text(price, 270, yPosition);
      doc.text(tax, 330, yPosition);
      doc.text(total, 400, yPosition);
      yPosition += 18;
    });

    yPosition += 20;
    
    // Tax breakdown
    doc.fontSize(11);
    doc.text('Tax Breakdown:', 300, yPosition);
    yPosition += 18;
    doc.fontSize(10);
    doc.text(`Total A-Ex (0%): $${invoice.totalAEx?.toFixed(2) || '0.00'}`, 300, yPosition);
    yPosition += 15;
    doc.text(`Total B (18%): $${invoice.totalB18?.toFixed(2) || '0.00'}`, 300, yPosition);
    yPosition += 15;
    doc.text(`Tax A: $${invoice.totalTaxA?.toFixed(2) || '0.00'}`, 300, yPosition);
    yPosition += 15;
    doc.text(`Tax B: $${invoice.totalTaxB?.toFixed(2) || '0.00'}`, 300, yPosition);
    yPosition += 25;

    // Totals
    doc.fontSize(12);
    doc.text(`Subtotal: $${invoice.subtotal.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.text(`Tax: $${invoice.totalTax.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.fontSize(14).text(`Grand Total: $${invoice.grandTotal.toFixed(2)}`, 350, yPosition, { bold: true });
    yPosition += 18;
    doc.fontSize(12).text(`Rounded: $${invoice.roundedAmount?.toFixed(2) || invoice.grandTotal.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.text(`Paid: $${invoice.amountPaid.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.text(`Balance: $${invoice.balance.toFixed(2)}`, 350, yPosition);

    if (invoice.terms || invoice.notes) {
      doc.moveDown(2);
      if (invoice.terms) {
        doc.text('Terms:', { underline: true });
        doc.fontSize(10).text(invoice.terms);
        doc.moveDown();
      }
      if (invoice.notes) {
        doc.text('Notes:', { underline: true });
        doc.fontSize(10).text(invoice.notes);
      }
    }

    // Finalize PDF
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

    res.json({
      success: true,
      message: 'Invoice sent to ' + clientEmail
    });
  } catch (error) {
    next(error);
  }
};
