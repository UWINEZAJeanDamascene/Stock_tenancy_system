const Quotation = require('../models/Quotation');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const PDFDocument = require('pdfkit');
const {
  notifyQuotationCreated,
  notifyQuotationApproved,
  notifyQuotationExpired
} = require('../services/notificationHelper');

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
      .populate('client', 'name code contact taxId')
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
      .populate('client', 'name code contact type taxId')
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

    // Calculate item totals and prefer product tax defaults when available
    const processedItems = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const product = await Product.findOne({ _id: item.product, company: companyId });
      const subtotal = item.quantity * item.unitPrice;
      const discount = item.discount || 0;
      const netAmount = subtotal - discount;
      const taxRate = (item.taxRate != null) ? item.taxRate : (product?.taxRate != null ? product.taxRate : 0);
      const taxCode = item.taxCode || product?.taxCode || 'A';
      const taxAmount = netAmount * (taxRate / 100);
      const total = netAmount + taxAmount;
      processedItems.push({
        ...item,
        itemCode: item.itemCode || `ITEM-${i + 1}`,
        taxCode,
        taxRate,
        subtotal,
        taxAmount,
        total
      });
    }

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
    // Notify quotation created
    try {
      await notifyQuotationCreated(companyId, quotation);
    } catch (e) {
      console.error('notifyQuotationCreated failed', e);
    }
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
    // Notify quotation approved
    try {
      await notifyQuotationApproved(companyId, quotation, quotation.convertedToInvoice || null);
    } catch (e) {
      console.error('notifyQuotationApproved failed', e);
    }
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

    // Accept approved status case-insensitively and trim whitespace
    const status = (quotation.status || '').toString().trim().toLowerCase();
    if (status !== 'approved') {
      console.warn(`Attempt to convert quotation ${quotation._id} with status='${quotation.status}'`);
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
    // Ensure items include invoice's required fields (subtotal, taxAmount, totalWithTax)
    const processedItems = (quotation.items || []).map((item, idx) => {
      const quantity = item.quantity || 0;
      const unitPrice = item.unitPrice || item.unitPrice || 0;
      const discount = item.discount || 0;
      const subtotal = quantity * unitPrice;
      const netAmount = subtotal - discount;
      const taxRate = (item.taxRate != null) ? item.taxRate : (item.product?.taxRate != null ? item.product.taxRate : 0);
      const taxCode = item.taxCode || item.product?.taxCode || 'A';
      const taxAmount = netAmount * (taxRate / 100);
      const totalWithTax = netAmount + taxAmount;

      return {
        product: item.product,
        itemCode: item.itemCode || `ITEM-${idx + 1}`,
        description: item.description || (item.product && item.product.name) || '',
        quantity,
        unit: item.unit || (item.product && item.product.unit) || '',
        unitPrice,
        discount,
        taxCode,
        taxRate,
        taxAmount,
        subtotal,
        totalWithTax
      };
    });

    const invoicePayload = {
      company: companyId,
      client: quotation.client,
      quotation: quotation._id,
      items: processedItems,
      terms: quotation.terms,
      notes: quotation.notes,
      createdBy: req.user.id,
      dueDate: req.body.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days default
    };

    const invoice = await Invoice.create(invoicePayload);

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
    // Notify quotation approved/converted
    try {
      await notifyQuotationApproved(companyId, quotation, invoice.invoiceNumber);
    } catch (e) {
      console.error('notifyQuotationApproved (convert) failed', e);
    }
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

    // Layout helpers
    const left = 48;
    const right = 48;
    const availWidth = doc.page.width - left - right;
    const bottomLimit = doc.page.height - 80;
    // Column percents for: No, Description, Unit, Qty, Unit rate FRW, Total With VAT FRW
    // Tuned to avoid wrapping and keep totals column wide enough
    const colPercents = [0.06, 0.48, 0.08, 0.08, 0.16, 0.14];
    const colWidths = colPercents.map(p => Math.floor(availWidth * p));
    // adjust rounding to fill available width
    const sumCols = colWidths.reduce((s, v) => s + v, 0);
    if (sumCols < availWidth) colWidths[colWidths.length - 1] += (availWidth - sumCols);

    let pageNum = 1;
    const drawFooter = (p) => {
      const bottom = doc.page.height - 40;
      doc.fontSize(8).fillColor('#9ca3af').font('Helvetica');
      doc.text(`Generated: ${new Date().toLocaleString()}`, left, bottom, { align: 'left' });
      doc.text(`Page ${p}`, 0, bottom, { align: 'right' });
    };

    const renderHeader = () => {
      // Title
      doc.fontSize(20).fillColor('#111827').text('QUOTATION', { align: 'center' });
      doc.moveDown(0.6);

      // Prepare left and right columns and render line-by-line so they stay parallel
      const startY = doc.y;
      const lineHeight = 14;
      const leftLines = [
        `Quotation Number: ${quotation.quotationNumber}`,
        `Date: ${new Date(quotation.createdAt).toLocaleDateString()}`,
        `Valid Until: ${quotation.validUntil ? new Date(quotation.validUntil).toLocaleDateString() : 'N/A'}`,
        `Status: ${quotation.status?.toUpperCase() || 'N/A'}`
      ];

      const clientX = left + Math.floor(availWidth * 0.55);
      const rightLines = [];
      rightLines.push('Quotation To:');
      rightLines.push(quotation.client?.name || 'N/A');
      rightLines.push(quotation.client?.taxId ? `TIN: ${quotation.client.taxId}` : '');
      rightLines.push(quotation.client?.contact?.address || '');
      rightLines.push(quotation.client?.contact?.phone ? `Phone: ${quotation.client.contact.phone}` : '');
      rightLines.push(quotation.client?.contact?.email ? `Email: ${quotation.client.contact.email}` : '');

      const maxLines = Math.max(leftLines.length, rightLines.length);
      doc.fontSize(10).fillColor('#111827').font('Helvetica');
      for (let i = 0; i < maxLines; i++) {
        const yLine = startY + (i * lineHeight);
        // left column
        if (leftLines[i]) {
          doc.text(leftLines[i], left, yLine);
        }
        // right column (first line underlined label)
        if (rightLines[i]) {
          if (i === 0) {
            doc.text(rightLines[i], clientX, yLine, { underline: true });
          } else {
            doc.text(rightLines[i], clientX, yLine);
          }
        }
      }

      // Move doc.y below the taller column
      doc.y = startY + (maxLines * lineHeight) + 8;
    };

    const renderTableHeader = (y) => {
      doc.rect(left - 8, y, availWidth + 16, 28).fill('#111827');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
      let x = left;
      const headers = ['No.', 'Description', 'Unit', 'Qty', 'Unit rate FRW', 'Total With VAT FRW'];
      headers.forEach((h, i) => {
        const align = (i >= 2) ? 'right' : 'left';
        doc.text(h, x, y + 8, { width: colWidths[i], align });
        x += colWidths[i];
      });
      doc.fillColor('#111827').font('Helvetica');
    };

    // Print header and table header
    renderHeader();
    let y = doc.y;
    renderTableHeader(y);
    y += 34;

    // Items
    doc.fontSize(9).font('Helvetica');
    for (let idx = 0; idx < quotation.items.length; idx++) {
      const item = quotation.items[idx];
      const desc = item.product?.name || item.description || '';
      const unit = item.unit || (item.product?.unit || '');
      const qty = String(item.quantity || '');
      const unitPrice = `RWF ${Number(item.unitPrice || 0).toFixed(2)}`;
      const total = `RWF ${Number(item.total || item.totalWithTax || 0).toFixed(2)}`;

      // Measure heights for all cells (so rows expand for any wrapped column)
      const hNo = doc.heightOfString(String(idx + 1), { width: colWidths[0] });
      const hDesc = doc.heightOfString(String(desc), { width: colWidths[1] });
      const hUnit = doc.heightOfString(String(unit), { width: colWidths[2] });
      const hQty = doc.heightOfString(String(qty), { width: colWidths[3] });
      const hUnitPrice = doc.heightOfString(String(unitPrice), { width: colWidths[4] });
      const hTotal = doc.heightOfString(String(total), { width: colWidths[5] });
      const rowHeight = Math.max(hNo, hDesc, hUnit, hQty, hUnitPrice, hTotal, 12);

      // Page break if needed
      if (y + rowHeight > bottomLimit) {
        drawFooter(pageNum);
        doc.addPage();
        pageNum += 1;
        renderHeader();
        y = doc.y;
        renderTableHeader(y);
        y += 34;
      }

      // Alternating shading
      if (idx % 2 === 0) {
        doc.rect(left - 8, y - 6, availWidth + 16, rowHeight + 8).fill('#fbfbfc');
        doc.fillColor('#111827');
      }

      // Render cells
      let x = left;
      doc.text(String(idx + 1), x, y, { width: colWidths[0] }); x += colWidths[0];
      doc.text(String(desc), x, y, { width: colWidths[1] }); x += colWidths[1];
      doc.text(String(unit), x, y, { width: colWidths[2], align: 'right' }); x += colWidths[2];
      doc.text(qty, x, y, { width: colWidths[3], align: 'right' }); x += colWidths[3];
      doc.text(unitPrice, x, y, { width: colWidths[4], align: 'right' }); x += colWidths[4];
      doc.text(total, x, y, { width: colWidths[5], align: 'right' });

      y += rowHeight + 8;
    }

    // Totals block (right aligned)
    if (y + 100 > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
      renderHeader();
      y = doc.y;
      renderTableHeader(y);
      y += 34;
    }

    // Totals box placed below table, right-aligned, with fixed height to prevent overlap
    const totalsBoxWidth = Math.floor(availWidth * 0.36);
    const totalsX = left + availWidth - totalsBoxWidth;
    const totalsY = y;
    const totalsBoxHeight = 88;
    // Page break if totals box would overflow
    if (totalsY + totalsBoxHeight > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
      renderHeader();
      y = doc.y;
      renderTableHeader(y);
      y += 34;
    }

    // Draw totals box with left labels and right values
    doc.rect(totalsX - 6, totalsY - 6, totalsBoxWidth + 12, totalsBoxHeight).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    const innerPad = 8;
    let ty = totalsY + innerPad;
    doc.fontSize(10).text(`Total VAT Exclusive (RWF):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
    doc.text(`${Number(quotation.subtotal || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
    ty += 20;
    doc.text(`VAT (18%):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
    doc.text(`${Number(quotation.totalTax || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
    ty += 22;
    doc.font('Helvetica-Bold').fontSize(12).text(`Value Total Amount (RWF):`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'left' });
    doc.text(`${Number(quotation.grandTotal || 0).toFixed(2)}`, totalsX + innerPad, ty, { width: totalsBoxWidth - innerPad * 2, align: 'right' });
    doc.font('Helvetica').fontSize(10);
    // Advance y past totals box
    y = totalsY + totalsBoxHeight + 12;

    y += 28;
    // Terms & Notes
    if (quotation.terms || quotation.notes) {
      if (y + 120 > bottomLimit) {
        drawFooter(pageNum);
        doc.addPage();
        pageNum += 1;
        renderHeader();
        y = doc.y;
      }
      doc.moveDown(1);
      if (quotation.terms) {
        doc.font('Helvetica-Bold').fontSize(10).text('Terms & Conditions:', left);
        doc.font('Helvetica').fontSize(9).text(quotation.terms, { width: availWidth });
        doc.moveDown(0.5);
      }
      if (quotation.notes) {
        doc.font('Helvetica-Bold').fontSize(10).text('Notes:', left);
        doc.font('Helvetica').fontSize(9).text(quotation.notes, { width: availWidth });
      }
    }

    drawFooter(pageNum);
    doc.end();
  } catch (error) {
    next(error);
  }
};
