const DeliveryNote = require('../models/DeliveryNote');
const Quotation = require('../models/Quotation');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Company = require('../models/Company');
const PDFDocument = require('pdfkit');

// @desc    Get all delivery notes
// @route   GET /api/delivery-notes
// @access  Private
exports.getDeliveryNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, status, clientId, startDate, endDate, quotationId } = req.query;
    const query = { company: companyId };

    if (status) {
      query.status = status;
    }

    if (clientId) {
      query.client = clientId;
    }

    if (quotationId) {
      query.quotation = quotationId;
    }

    if (startDate || endDate) {
      query.deliveryDate = {};
      if (startDate) query.deliveryDate.$gte = new Date(startDate);
      if (endDate) query.deliveryDate.$lte = new Date(endDate);
    }

    const total = await DeliveryNote.countDocuments(query);
    const deliveryNotes = await DeliveryNote.find(query)
      .populate('client', 'name code contact taxId')
      .populate('quotation', 'quotationNumber')
      .populate('invoice', 'invoiceNumber')
      .populate('items.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('confirmedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: deliveryNotes.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: deliveryNotes
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single delivery note
// @route   GET /api/delivery-notes/:id
// @access  Private
exports.getDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId })
      .populate('client', 'name code contact type taxId address')
      .populate('quotation', 'quotationNumber status items')
      .populate('invoice', 'invoiceNumber status grandTotal')
      .populate('items.product', 'name sku unit')
      .populate('createdBy', 'name email')
      .populate('confirmedBy', 'name email');

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    res.json({
      success: true,
      data: deliveryNote
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new delivery note
// @route   POST /api/delivery-notes
// @access  Private
exports.createDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { quotation: quotationId } = req.body;

    // If from quotation, populate items from quotation
    let items = req.body.items || [];
    let client = req.body.client;
    let customerTin = req.body.customerTin;
    let customerName = req.body.customerName;
    let customerAddress = req.body.customerAddress;

    if (quotationId) {
      const quotation = await Quotation.findOne({ _id: quotationId, company: companyId })
        .populate('client')
        .populate('items.product');

      if (!quotation) {
        return res.status(404).json({
          success: false,
          message: 'Quotation not found'
        });
      }

      // Use quotation client if not provided
      if (!client) {
        client = quotation.client._id;
      }

      // Capture customer details from quotation
      if (!customerTin && quotation.client) {
        customerTin = quotation.client.taxId;
        customerName = quotation.client.name;
        customerAddress = quotation.client.contact?.address;
      }

      // If no items provided, use quotation items
      if (!items || items.length === 0) {
        items = quotation.items.map(item => ({
          product: item.product._id,
          productName: item.product.name,
          itemCode: item.itemCode || item.product.sku,
          unit: item.unit || item.product.unit,
          orderedQty: item.quantity,
          deliveredQty: 0,
          pendingQty: item.quantity,
          notes: ''
        }));
      }
    }

    const deliveryNote = await DeliveryNote.create({
      ...req.body,
      company: companyId,
      client,
      customerTin,
      customerName,
      customerAddress,
      items,
      createdBy: req.user.id
    });

    await deliveryNote.populate('client items.product createdBy');

    // If from quotation, update quotation status to 'delivering'
    if (quotationId) {
      await Quotation.findByIdAndUpdate(quotationId, { status: 'delivering' });
    }

    res.status(201).json({
      success: true,
      data: deliveryNote
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update delivery note
// @route   PUT /api/delivery-notes/:id
// @access  Private
exports.updateDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    // Only draft delivery notes can be fully updated
    if (deliveryNote.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: `Cannot update delivery note with status: ${deliveryNote.status}`
      });
    }

    deliveryNote = await DeliveryNote.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      { new: true, runValidators: true }
    )
      .populate('client items.product createdBy');

    res.json({
      success: true,
      data: deliveryNote
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete delivery note
// @route   DELETE /api/delivery-notes/:id
// @access  Private
exports.deleteDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    // Only draft delivery notes can be deleted
    if (deliveryNote.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft delivery notes can be deleted'
      });
    }

    await deliveryNote.deleteOne();

    // If linked to quotation, revert quotation status
    if (deliveryNote.quotation) {
      await Quotation.findByIdAndUpdate(deliveryNote.quotation, { status: 'approved' });
    }

    res.json({
      success: true,
      message: 'Delivery note deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Dispatch delivery note (goods leave warehouse)
// @route   PUT /api/delivery-notes/:id/dispatch
// @access  Private
exports.dispatchDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { deliveredBy, vehicle, deliveryAddress, deliveryDate } = req.body;

    let deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    if (deliveryNote.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft delivery notes can be dispatched'
      });
    }

    // Update delivery note
    deliveryNote = await DeliveryNote.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      {
        status: 'dispatched',
        deliveredBy,
        vehicle,
        deliveryAddress,
        deliveryDate: deliveryDate || new Date()
      },
      { new: true, runValidators: true }
    )
      .populate('client items.product createdBy');

    res.json({
      success: true,
      message: 'Delivery note dispatched successfully',
      data: deliveryNote
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Confirm delivery (client received goods)
// @route   PUT /api/delivery-notes/:id/confirm
// @access  Private
exports.confirmDelivery = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { receivedBy, receivedDate, clientSignature, clientStamp, notes } = req.body;

    let deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId })
      .populate('items.product');

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    if (!['draft', 'dispatched'].includes(deliveryNote.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot confirm delivery note with status: ${deliveryNote.status}`
      });
    }

    // Determine status based on delivery
    let newStatus = 'delivered';
    let hasPartial = false;

    // Check if any items are partially delivered
    deliveryNote.items.forEach(item => {
      if (item.deliveredQty < item.orderedQty) {
        hasPartial = true;
      }
    });

    if (hasPartial) {
      newStatus = 'partial';
    }

    // Update delivery note
    deliveryNote.status = newStatus;
    deliveryNote.receivedBy = receivedBy;
    deliveryNote.receivedDate = receivedDate || new Date();
    deliveryNote.clientSignature = clientSignature;
    deliveryNote.clientStamp = clientStamp || false;
    deliveryNote.notes = notes || deliveryNote.notes;
    deliveryNote.confirmedBy = req.user.id;
    deliveryNote.confirmedDate = new Date();
    deliveryNote.stockDeducted = false;

    await deliveryNote.save();

    // Deduct stock for delivered items
    try {
      for (const item of deliveryNote.items) {
        if (item.deliveredQty > 0) {
          // Get current stock
          const product = await Product.findOne({ _id: item.product._id, company: companyId });
          const previousStock = product.quantity || 0;
          const newStock = previousStock - item.deliveredQty;

          // Update product stock
          await Product.findByIdAndUpdate(item.product._id, { quantity: Math.max(0, newStock) });

          // Create stock movement
          await StockMovement.create({
            company: companyId,
            product: item.product._id,
            type: 'out',
            reason: 'sale',
            quantity: item.deliveredQty,
            previousStock,
            newStock: Math.max(0, newStock),
            referenceType: 'delivery_note',
            referenceNumber: deliveryNote.deliveryNumber,
            referenceDocument: deliveryNote._id,
            referenceModel: 'DeliveryNote',
            notes: `Delivery Note: ${deliveryNote.deliveryNumber}`,
            performedBy: req.user.id,
            movementDate: new Date()
          });
        }
      }
      deliveryNote.stockDeducted = true;
      await deliveryNote.save();
    } catch (stockError) {
      console.error('Error deducting stock:', stockError);
      // Continue even if stock deduction fails - can be manually fixed
    }

    // If linked to quotation, update quotation status
    if (deliveryNote.quotation) {
      // Check if all items are fully delivered
      let allDelivered = true;
      const quotation = await Quotation.findById(deliveryNote.quotation);
      if (quotation) {
        // For now mark as delivering, can be marked as delivered when all NDLs are complete
        quotation.status = 'delivering';
        await quotation.save();
      }
    }

    await deliveryNote.populate('client items.product createdBy confirmedBy');

    res.json({
      success: true,
      message: 'Delivery confirmed successfully',
      data: deliveryNote
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel delivery note
// @route   PUT /api/delivery-notes/:id/cancel
// @access  Private
exports.cancelDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { cancellationReason } = req.body;

    let deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    if (['delivered', 'partial'].includes(deliveryNote.status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel confirmed delivery notes. Create a credit note instead.'
      });
    }

    deliveryNote.status = 'cancelled';
    deliveryNote.cancellationReason = cancellationReason;
    deliveryNote.cancelledBy = req.user.id;
    deliveryNote.cancelledDate = new Date();

    await deliveryNote.save();

    // If linked to quotation, revert status
    if (deliveryNote.quotation) {
      await Quotation.findByIdAndUpdate(deliveryNote.quotation, { status: 'approved' });
    }

    res.json({
      success: true,
      message: 'Delivery note cancelled successfully',
      data: deliveryNote
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create invoice from delivery note
// @route   POST /api/delivery-notes/:id/create-invoice
// @access  Private
exports.createInvoiceFromDeliveryNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { dueDate, paymentTerms, notes, terms } = req.body;

    let deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId })
      .populate('items.product')
      .populate('client');

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    if (!['delivered', 'partial'].includes(deliveryNote.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only confirmed delivery notes can be converted to invoice'
      });
    }

    if (deliveryNote.invoice) {
      return res.status(400).json({
        success: false,
        message: 'Invoice has already been created from this delivery note'
      });
    }

    // Process items for invoice - use DELIVERED quantities, not ordered
    const processedItems = deliveryNote.items.map((item, idx) => {
      const quantity = item.deliveredQty || 0;
      const product = item.product;
      const unitPrice = product?.sellingPrice || 0;
      const subtotal = quantity * unitPrice;
      const discount = 0;
      const netAmount = subtotal - discount;
      const taxRate = product?.taxRate || 0;
      const taxCode = product?.taxCode || 'A';
      const taxAmount = netAmount * (taxRate / 100);
      const totalWithTax = netAmount + taxAmount;

      return {
        product: product._id,
        itemCode: item.itemCode || product?.sku || `ITEM-${idx + 1}`,
        description: item.productName || product?.name || '',
        quantity,
        unit: item.unit || product?.unit || '',
        unitPrice,
        discount,
        taxCode,
        taxRate,
        taxAmount,
        subtotal,
        totalWithTax
      };
    }).filter(item => item.quantity > 0); // Only include items with delivered quantity

    if (processedItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No items with delivery quantity to create invoice'
      });
    }

    // Create invoice
    const invoice = await Invoice.create({
      company: companyId,
      client: deliveryNote.client._id,
      quotation: deliveryNote.quotation,
      items: processedItems,
      terms: terms || '',
      notes: notes || deliveryNote.notes,
      createdBy: req.user.id,
      dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      paymentTerms: paymentTerms || 'credit_30'
    });

    // Update delivery note with invoice reference
    deliveryNote.invoice = invoice._id;
    await deliveryNote.save();

    await invoice.populate('client items.product createdBy');

    res.status(201).json({
      success: true,
      message: 'Invoice created successfully from delivery note',
      data: invoice
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get delivery notes for a specific quotation
// @route   GET /api/delivery-notes/quotation/:quotationId
// @access  Private
exports.getQuotationDeliveryNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNotes = await DeliveryNote.find({ 
      quotation: req.params.quotationId, 
      company: companyId 
    })
      .populate('client', 'name code')
      .populate('items.product', 'name sku')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: deliveryNotes.length,
      data: deliveryNotes
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate delivery note PDF
// @route   GET /api/delivery-notes/:id/pdf
// @access  Private
exports.generateDeliveryNotePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId })
      .populate('client')
      .populate('quotation')
      .populate('items.product')
      .populate('company');

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    // Create PDF document
    const doc = new PDFDocument({ margin: 50 });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=delivery-note-${deliveryNote.deliveryNumber}.pdf`);

    // Pipe PDF to response
    doc.pipe(res);

    // Layout helpers
    const left = 48;
    const right = 48;
    const availWidth = doc.page.width - left - right;
    const bottomLimit = doc.page.height - 80;

    let pageNum = 1;
    const drawFooter = (p) => {
      const bottom = doc.page.height - 40;
      doc.fontSize(8).fillColor('#9ca3af').font('Helvetica');
      doc.text(`Generated: ${new Date().toLocaleString()}`, left, bottom, { align: 'left' });
      doc.text(`Page ${p}`, 0, bottom, { align: 'right' });
    };

    const renderHeader = () => {
      // Header with logo area and title
      doc.fontSize(24).fillColor('#111827').text('NOTE DE LIVRAISON', { align: 'center' });
      doc.moveDown(0.3);
      
      doc.fontSize(14).fillColor('#6b7280').text(`N°: ${deliveryNote.deliveryNumber}`, { align: 'center' });
      doc.moveDown(0.8);

      // Company and Client info
      const startY = doc.y;
      const lineHeight = 14;
      
      // Left column - Supplier (You)
      doc.fontSize(10).fillColor('#111827').font('Helvetica-Bold');
      doc.text('FOURNISSEUR (You):', left, startY);
      doc.font('Helvetica').fontSize(10).fillColor('#374151');
      doc.text(deliveryNote.company?.name || 'Company Name', left, startY + lineHeight);
      doc.text(deliveryNote.company?.taxId ? `TIN: ${deliveryNote.company.taxId}` : '', left, startY + lineHeight * 2);
      doc.text(deliveryNote.company?.address || '', left, startY + lineHeight * 3);

      // Right column - Client
      const clientX = left + Math.floor(availWidth * 0.55);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827');
      doc.text('CLIENT:', clientX, startY);
      doc.font('Helvetica').fontSize(10).fillColor('#374151');
      doc.text(deliveryNote.client?.name || '', clientX, startY + lineHeight);
      doc.text(deliveryNote.client?.taxId ? `TIN: ${deliveryNote.client.taxId}` : '', clientX, startY + lineHeight * 2);
      doc.text(deliveryNote.client?.contact?.address || deliveryNote.customerAddress || '', clientX, startY + lineHeight * 3);

      doc.moveDown(3);

      // Date and Reference row
      doc.fontSize(10).fillColor('#111827');
      doc.text(`Date: ${new Date(deliveryNote.deliveryDate).toLocaleDateString()}`, left);
      if (deliveryNote.quotation) {
        doc.text(`Référence: ${deliveryNote.quotation.quotationNumber || 'N/A'}`, left + 200);
      }
      doc.moveDown(0.5);

      // Driver info
      if (deliveryNote.deliveredBy || deliveryNote.vehicle) {
        doc.text(`Chauffeur: ${deliveryNote.deliveredBy || '___'}    Véhicule: ${deliveryNote.vehicle || '___'}`);
        doc.moveDown(0.5);
      }
    };

    // Table columns: No, Product, Unit, Ordered, Delivered
    const colPercents = [0.08, 0.42, 0.12, 0.18, 0.20];
    const colWidths = colPercents.map(p => Math.floor(availWidth * p));
    const sumCols = colWidths.reduce((s, v) => s + v, 0);
    if (sumCols < availWidth) colWidths[colWidths.length - 1] += (availWidth - sumCols);

    const renderTableHeader = (y) => {
      doc.rect(left - 8, y, availWidth + 16, 28).fill('#111827');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
      let x = left;
      const headers = ['No.', 'Produit', 'Unité', 'Commandé', 'Livré'];
      headers.forEach((h, i) => {
        const align = (i >= 3) ? 'right' : 'left';
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
    for (let idx = 0; idx < deliveryNote.items.length; idx++) {
      const item = deliveryNote.items[idx];
      const productName = item.productName || item.product?.name || '';
      const unit = item.unit || item.product?.unit || '';
      const orderedQty = item.orderedQty || 0;
      const deliveredQty = item.deliveredQty || 0;

      // Measure heights
      const hNo = doc.heightOfString(String(idx + 1), { width: colWidths[0] });
      const hProduct = doc.heightOfString(productName, { width: colWidths[1] });
      const hUnit = doc.heightOfString(unit, { width: colWidths[2] });
      const hOrdered = doc.heightOfString(String(orderedQty), { width: colWidths[3] });
      const hDelivered = doc.heightOfString(String(deliveredQty), { width: colWidths[4] });
      const rowHeight = Math.max(hNo, hProduct, hUnit, hOrdered, hDelivered, 14);

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
        doc.rect(left - 8, y - 6, availWidth + 16, rowHeight + 8).fill('#f9fafb');
        doc.fillColor('#111827');
      }

      // Render cells
      let x = left;
      doc.text(String(idx + 1), x, y, { width: colWidths[0] }); x += colWidths[0];
      doc.text(productName, x, y, { width: colWidths[1] }); x += colWidths[1];
      doc.text(unit, x, y, { width: colWidths[2] }); x += colWidths[2];
      doc.text(String(orderedQty), x, y, { width: colWidths[3], align: 'right' }); x += colWidths[3];
      doc.text(String(deliveredQty), x, y, { width: colWidths[4], align: 'right' });

      y += rowHeight + 8;
    }

    // Notes section
    y += 10;
    const hasNotes = deliveryNote.notes || (deliveryNote.items && deliveryNote.items.some(i => i.notes));
    if (hasNotes) {
      if (y + 60 > bottomLimit) {
        drawFooter(pageNum);
        doc.addPage();
        pageNum += 1;
        y = 50;
      }
      
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827');
      doc.text('Notes:', left, y);
      doc.font('Helvetica').fontSize(9).fillColor('#374151');
      
      let notesText = deliveryNote.notes || '';
      
      // Add item-specific notes (backorders, etc.)
      deliveryNote.items.forEach(item => {
        if (item.notes) {
          notesText += `\n- ${item.productName}: ${item.notes}`;
        }
        if (item.pendingQty > 0) {
          notesText += `\n- ${item.productName}: ${item.pendingQty} en attente`;
        }
      });
      
      doc.text(notesText, left, y + 14, { width: availWidth });
      y += 40;
    }

    // Delivery confirmation section
    y += 10;
    if (y + 100 > bottomLimit) {
      drawFooter(pageNum);
      doc.addPage();
      pageNum += 1;
    }

    // Signature boxes
    const boxWidth = Math.floor(availWidth / 2) - 10;
    const boxHeight = 80;
    
    // Delivered by box
    doc.rect(left, y, boxWidth, boxHeight).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827');
    doc.text('LIVRÉ PAR:', left + 8, y + 8);
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    doc.text(`Nom: ${deliveryNote.deliveredBy || '_______________'}`, left + 8, y + 28);
    doc.text(`Signature: _______________`, left + 8, y + 42);
    doc.text(`Date: ${deliveryNote.deliveryDate ? new Date(deliveryNote.deliveryDate).toLocaleDateString() : '_______________'}`, left + 8, y + 56);

    // Received by client box
    doc.rect(left + boxWidth + 20, y, boxWidth, boxHeight).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827');
    doc.text('REÇU PAR LE CLIENT:', left + boxWidth + 28, y + 8);
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    doc.text(`Nom: ${deliveryNote.receivedBy || '_______________'}`, left + boxWidth + 28, y + 28);
    doc.text(`Signature: _______________`, left + boxWidth + 28, y + 42);
    doc.text(`Date: ${deliveryNote.receivedDate ? new Date(deliveryNote.receivedDate).toLocaleDateString() : '_______________'}`, left + boxWidth + 28, y + 56);
    if (deliveryNote.clientStamp) {
      doc.text(`Cachet: ✓`, left + boxWidth + 28, y + 70);
    }

    drawFooter(pageNum);
    doc.end();
  } catch (error) {
    next(error);
  }
};

// @desc    Update item delivery quantity
// @route   PUT /api/delivery-notes/:id/items/:itemId
// @access  Private
exports.updateItemDeliveryQty = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { deliveredQty, notes } = req.body;

    const deliveryNote = await DeliveryNote.findOne({ _id: req.params.id, company: companyId });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: 'Delivery note not found'
      });
    }

    if (!['draft', 'dispatched'].includes(deliveryNote.status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot update items on confirmed delivery note'
      });
    }

    const itemIndex = deliveryNote.items.findIndex(
      item => item._id.toString() === req.params.itemId
    );

    if (itemIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Item not found'
      });
    }

    // Validate quantity
    if (deliveredQty > deliveryNote.items[itemIndex].orderedQty) {
      return res.status(400).json({
        success: false,
        message: 'Delivered quantity cannot exceed ordered quantity'
      });
    }

    deliveryNote.items[itemIndex].deliveredQty = deliveredQty;
    deliveryNote.items[itemIndex].pendingQty = deliveryNote.items[itemIndex].orderedQty - deliveredQty;
    if (notes) {
      deliveryNote.items[itemIndex].notes = notes;
    }

    await deliveryNote.save();

    await deliveryNote.populate('client items.product createdBy');

    res.json({
      success: true,
      data: deliveryNote
    });
  } catch (error) {
    next(error);
  }
};
