const Quotation = require('../models/Quotation');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const PDFDocument = require('pdfkit');

// @desc    Get all quotations
// @route   GET /api/quotations
// @access  Private
exports.getQuotations = async (req, res, next) => {
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
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const total = await Quotation.countDocuments(query);
    const quotations = await Quotation.find(query)
      .populate('client', 'name code contact')
      .populate('items.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: quotations.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: quotations
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single quotation
// @route   GET /api/quotations/:id
// @access  Private
exports.getQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId })
      .populate('client', 'name code contact type')
      .populate('items.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('convertedToInvoice');

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    res.json({
      success: true,
      data: quotation
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new quotation
// @route   POST /api/quotations
// @access  Private (admin, stock_manager, sales)
exports.createQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { items } = req.body;

    // Calculate item totals
    const processedItems = items.map(item => {
      const subtotal = item.quantity * item.unitPrice;
      const total = subtotal - (item.discount || 0) + (subtotal * (item.taxRate || 0) / 100);
      return {
        ...item,
        subtotal,
        total
      };
    });

    const quotation = await Quotation.create({
      ...req.body,
      company: companyId,
      items: processedItems,
      createdBy: req.user.id
    });

    await quotation.populate('client items.product createdBy');

    res.status(201).json({
      success: true,
      data: quotation
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update quotation
// @route   PUT /api/quotations/:id
// @access  Private (admin, stock_manager, sales)
exports.updateQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let quotation = await Quotation.findOne({ _id: req.params.id, company: companyId });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Only draft and sent quotations can be updated
    if (!['draft', 'sent'].includes(quotation.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot update quotation with status: ${quotation.status}`
      });
    }

    // Recalculate item totals if items are updated
    if (req.body.items) {
      req.body.items = req.body.items.map(item => {
        const subtotal = item.quantity * item.unitPrice;
        const total = subtotal - (item.discount || 0) + (subtotal * (item.taxRate || 0) / 100);
        return {
          ...item,
          subtotal,
          total
        };
      });
    }

    quotation = await Quotation.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      { new: true, runValidators: true }
    )
      .populate('client items.product createdBy');

    res.json({
      success: true,
      data: quotation
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete quotation
// @route   DELETE /api/quotations/:id
// @access  Private (admin, sales)
exports.deleteQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Only draft quotations can be deleted
    if (quotation.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft quotations can be deleted'
      });
    }

    await quotation.deleteOne();

    res.json({
      success: true,
      message: 'Quotation deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve quotation
// @route   PUT /api/quotations/:id/approve
// @access  Private (admin, stock_manager)
exports.approveQuotation = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    if (quotation.status !== 'sent') {
      return res.status(400).json({
        success: false,
        message: 'Only sent quotations can be approved'
      });
    }

    quotation.status = 'approved';
    quotation.approvedBy = req.user.id;
    quotation.approvedDate = new Date();

    await quotation.save();

    res.json({
      success: true,
      message: 'Quotation approved successfully',
      data: quotation
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Convert quotation to invoice
// @route   POST /api/quotations/:id/convert-to-invoice
// @access  Private (admin, stock_manager, sales)
exports.convertToInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId })
      .populate('items.product');

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    if (quotation.status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Only approved quotations can be converted to invoice'
      });
    }

    if (quotation.convertedToInvoice) {
      return res.status(400).json({
        success: false,
        message: 'Quotation has already been converted to invoice'
      });
    }

    // Create invoice from quotation
    const invoice = await Invoice.create({
      company: companyId,
      client: quotation.client,
      quotation: quotation._id,
      items: quotation.items,
      terms: quotation.terms,
      notes: quotation.notes,
      createdBy: req.user.id,
      dueDate: req.body.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days default
    });

    // Update quotation
    quotation.status = 'converted';
    quotation.convertedToInvoice = invoice._id;
    quotation.conversionDate = new Date();
    await quotation.save();

    await invoice.populate('client items.product createdBy');

    res.status(201).json({
      success: true,
      message: 'Quotation converted to invoice successfully',
      data: invoice
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get quotations for a specific client
// @route   GET /api/quotations/client/:clientId
// @access  Private
exports.getClientQuotations = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotations = await Quotation.find({ client: req.params.clientId, company: companyId })
      .populate('items.product', 'name sku')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: quotations.length,
      data: quotations
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get quotations containing a specific product
// @route   GET /api/quotations/product/:productId
// @access  Private
exports.getProductQuotations = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotations = await Quotation.find({ 'items.product': req.params.productId, company: companyId })
      .populate('client', 'name code')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: quotations.length,
      data: quotations
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate quotation PDF
// @route   GET /api/quotations/:id/pdf
// @access  Private
exports.generateQuotationPDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const quotation = await Quotation.findOne({ _id: req.params.id, company: companyId })
      .populate('client')
      .populate('items.product')
      .populate('createdBy');

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Create PDF document
    const doc = new PDFDocument({ margin: 50 });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=quotation-${quotation.quotationNumber}.pdf`);

    // Pipe PDF to response
    doc.pipe(res);

    // Header
    doc.fontSize(20).text('QUOTATION', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(12).text(`Quotation Number: ${quotation.quotationNumber}`);
    doc.text(`Date: ${new Date(quotation.createdAt).toLocaleDateString()}`);
    doc.text(`Valid Until: ${quotation.validUntil ? new Date(quotation.validUntil).toLocaleDateString() : 'N/A'}`);
    doc.text(`Status: ${quotation.status.toUpperCase()}`);
    doc.moveDown();

    // Client info
    doc.text('Quotation To:', { underline: true });
    doc.text(quotation.client?.name || 'N/A');
    if (quotation.client?.taxId) doc.text(`TIN: ${quotation.client.taxId}`);
    if (quotation.client?.contact?.address) doc.text(quotation.client.contact.address);
    if (quotation.client?.contact?.phone) doc.text(`Phone: ${quotation.client.contact.phone}`);
    if (quotation.client?.contact?.email) doc.text(`Email: ${quotation.client.contact.email}`);
    doc.moveDown(2);

    // Company TIN if provided
    if (quotation.companyTin) {
      doc.text(`Company TIN: ${quotation.companyTin}`);
      doc.moveDown();
    }

    // Items table header
    const tableTop = doc.y;
    doc.fontSize(10);
    doc.text('No.', 50, tableTop);
    doc.text('Description', 80, tableTop);
    doc.text('Qty', 230, tableTop);
    doc.text('Unit', 260, tableTop);
    doc.text('Unit Price', 310, tableTop);
    doc.text('Tax %', 380, tableTop);
    doc.text('Total', 430, tableTop);

    let yPosition = tableTop + 20;
    doc.fontSize(9);
    quotation.items.forEach((item, index) => {
      const description = item.product?.name || item.description || 'N/A';
      const qty = item.quantity.toString();
      const unit = item.unit || '';
      const unitPrice = `RWF ${item.unitPrice.toFixed(2)}`;
      const tax = `${item.taxRate}%`;
      const total = `RWF ${item.total.toFixed(2)}`;
      
      doc.text((index + 1).toString(), 50, yPosition);
      doc.text(description.substring(0, 30), 80, yPosition);
      doc.text(qty, 230, yPosition);
      doc.text(unit, 260, yPosition);
      doc.text(unitPrice, 310, yPosition);
      doc.text(tax, 380, yPosition);
      doc.text(total, 430, yPosition);
      yPosition += 18;
    });

    yPosition += 20;
    
    // Totals
    doc.fontSize(12);
    doc.text(`Subtotal: RWF ${quotation.subtotal.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.text(`Tax: RWF ${quotation.totalTax.toFixed(2)}`, 350, yPosition);
    yPosition += 18;
    doc.fontSize(14).text(`Grand Total: RWF ${quotation.grandTotal.toFixed(2)}`, 350, yPosition, { bold: true });

    if (quotation.terms || quotation.notes) {
      doc.moveDown(2);
      if (quotation.terms) {
        doc.text('Terms & Conditions:', { underline: true });
        doc.fontSize(10).text(quotation.terms);
        doc.moveDown();
      }
      if (quotation.notes) {
        doc.text('Notes:', { underline: true });
        doc.fontSize(10).text(quotation.notes);
      }
    }

    // Finalize PDF
    doc.end();
  } catch (error) {
    next(error);
  }
};
