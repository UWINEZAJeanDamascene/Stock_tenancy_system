const Client = require('../models/Client');
const Invoice = require('../models/Invoice');

// @desc    Get all clients
// @route   GET /api/clients
// @access  Private
exports.getClients = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, search, type, isActive } = req.query;
    const query = { company: companyId };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { 'contact.email': { $regex: search, $options: 'i' } }
      ];
    }

    if (type) {
      query.type = type;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const total = await Client.countDocuments(query);
    const clients = await Client.find(query)
      .populate('createdBy', 'name email')
      .sort({ name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: clients.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: clients
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single client
// @route   GET /api/clients/:id
// @access  Private
exports.getClient = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const client = await Client.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      data: client
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new client
// @route   POST /api/clients
// @access  Private (admin, stock_manager, sales)
exports.createClient = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    req.body.createdBy = req.user.id;
    req.body.company = companyId;

    const client = await Client.create(req.body);

    res.status(201).json({
      success: true,
      data: client
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update client
// @route   PUT /api/clients/:id
// @access  Private (admin, stock_manager, sales)
exports.updateClient = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      {
        new: true,
        runValidators: true
      }
    );

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      data: client
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete client
// @route   DELETE /api/clients/:id
// @access  Private (admin)
exports.deleteClient = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const client = await Client.findOneAndDelete({ _id: req.params.id, company: companyId });

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client purchase history
// @route   GET /api/clients/:id/purchase-history
// @access  Private
exports.getClientPurchaseHistory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, startDate, endDate } = req.query;
    const query = { 
      client: req.params.id,
      company: companyId,
      status: { $in: ['paid', 'partial'] }
    };

    if (startDate || endDate) {
      query.invoiceDate = {};
      if (startDate) query.invoiceDate.$gte = new Date(startDate);
      if (endDate) query.invoiceDate.$lte = new Date(endDate);
    }

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .populate('createdBy', 'name email')
      .sort({ invoiceDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Calculate totals
    const allInvoices = await Invoice.find(query);
    const totalAmount = allInvoices.reduce((sum, invoice) => sum + invoice.grandTotal, 0);
    const totalPaid = allInvoices.reduce((sum, invoice) => sum + invoice.amountPaid, 0);

    res.json({
      success: true,
      count: invoices.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      summary: {
        totalAmount,
        totalPaid,
        totalInvoices: total
      },
      data: invoices
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client outstanding invoices
// @route   GET /api/clients/:id/outstanding-invoices
// @access  Private
exports.getClientOutstandingInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoices = await Invoice.find({
      client: req.params.id,
      company: companyId,
      status: { $in: ['pending', 'partial', 'overdue'] }
    })
      .populate('createdBy', 'name email')
      .sort({ dueDate: 1 });

    const totalOutstanding = invoices.reduce((sum, invoice) => sum + invoice.balance, 0);

    res.json({
      success: true,
      count: invoices.length,
      totalOutstanding,
      data: invoices
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle client status (activate/deactivate)
// @route   PUT /api/clients/:id/toggle-status
// @access  Private (admin, stock_manager)
exports.toggleClientStatus = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const client = await Client.findOne({ _id: req.params.id, company: companyId });

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    client.isActive = !client.isActive;
    await client.save();

    res.json({
      success: true,
      data: client
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client with invoice stats (for list view)
// @route   GET /api/clients/with-stats
// @access  Private
exports.getClientsWithStats = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 50, search, type, isActive } = req.query;
    const query = { company: companyId };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { 'contact.email': { $regex: search, $options: 'i' } }
      ];
    }

    if (type) {
      query.type = type;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const total = await Client.countDocuments(query);
    const clients = await Client.find(query)
      .populate('createdBy', 'name email')
      .sort({ name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Get outstanding invoice counts for each client
    const clientIds = clients.map(c => c._id);
    const invoiceStats = await Invoice.aggregate([
      {
        $match: {
          client: { $in: clientIds },
          company: companyId,
          status: { $in: ['pending', 'partial', 'overdue'] }
        }
      },
      {
        $group: {
          _id: '$client',
          outstandingCount: { $sum: 1 },
          totalOutstanding: { $sum: '$balance' }
        }
      }
    ]);

    const statsMap = {};
    invoiceStats.forEach(stat => {
      statsMap[stat._id.toString()] = {
        outstandingCount: stat.outstandingCount,
        totalOutstanding: stat.totalOutstanding
      };
    });

    // Add outstanding count to each client
    const clientsWithStats = clients.map(client => {
      const stats = statsMap[client._id.toString()] || { outstandingCount: 0, totalOutstanding: 0 };
      return {
        ...client.toObject(),
        outstandingInvoices: stats.outstandingCount,
        totalOutstanding: stats.totalOutstanding
      };
    });

    res.json({
      success: true,
      count: clients.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: clientsWithStats
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Export clients to PDF
// @route   GET /api/clients/export/pdf
// @access  Private
exports.exportClientsToPDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const PDFDocument = require('pdfkit');
    const { type, isActive } = req.query;
    
    const query = { company: companyId };
    if (type) query.type = type;
    if (isActive !== undefined) query.isActive = isActive === 'true';

    const clients = await Client.find(query).sort({ name: 1 });

    // Get invoice stats
    const clientIds = clients.map(c => c._id);
    const invoiceStats = await Invoice.aggregate([
      {
        $match: {
          client: { $in: clientIds },
          company: companyId,
          status: { $in: ['paid', 'partial'] }
        }
      },
      {
        $group: {
          _id: '$client',
          totalPurchases: { $sum: '$grandTotal' }
        }
      }
    ]);

    const statsMap = {};
    invoiceStats.forEach(stat => {
      statsMap[stat._id.toString()] = stat.totalPurchases;
    });

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=clients-report.pdf');
    doc.pipe(res);

    doc.fontSize(20).text('CLIENTS REPORT', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    // Table headers
    const startX = 50;
    let y = 150;
    doc.fontSize(10).text('Code', startX, y);
    doc.text('Name', startX + 50, y);
    doc.text('Type', startX + 150, y);
    doc.text('Email', startX + 210, y);
    doc.text('Phone', startX + 320, y);
    doc.text('Total Purchases', startX + 410, y);
    doc.text('Status', startX + 510, y);

    y += 20;
    doc.fontSize(9);

    clients.forEach(client => {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      
      const totalPurchases = statsMap[client._id.toString()] || 0;
      
      doc.text(client.code || '-', startX, y);
      doc.text((client.name || '').substring(0, 25), startX + 50, y);
      doc.text(client.type || 'individual', startX + 150, y);
      doc.text((client.contact?.email || '-').substring(0, 20), startX + 210, y);
      doc.text(client.contact?.phone || '-', startX + 320, y);
      doc.text(`${totalPurchases.toFixed(2)}`, startX + 410, y);
      doc.text(client.isActive ? 'Active' : 'Inactive', startX + 510, y);
      
      y += 18;
    });

    doc.end();
  } catch (error) {
    next(error);
  }
};
