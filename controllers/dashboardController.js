const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const Quotation = require('../models/Quotation');
const StockMovement = require('../models/StockMovement');
const Client = require('../models/Client');
const ActionLog = require('../models/ActionLog');
const CreditNote = require('../models/CreditNote');

// @desc    Get dashboard statistics
// @route   GET /api/dashboard/stats
// @access  Private
exports.getDashboardStats = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    // Product stats
    const totalProducts = await Product.countDocuments({ company: companyId, isArchived: false });
    
    // Get all non-archived products and calculate low stock in JavaScript
    const allProducts = await Product.find({ company: companyId, isArchived: false });
    const lowStockProducts = allProducts.filter(p => p.currentStock <= p.lowStockThreshold).length;
    const outOfStockProducts = allProducts.filter(p => p.currentStock === 0).length;

    // Previous month product stats for comparison
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
    const totalProductsLastMonth = await Product.countDocuments({
      company: companyId,
      isArchived: false,
      createdAt: { $lte: endOfLastMonth }
    });

    // Previous month client stats
    const totalClientsLastMonth = await Client.countDocuments({ 
      company: companyId,
      isActive: true,
      createdAt: { $lte: endOfLastMonth }
    });

    // Calculate total stock value (reuse allProducts)
    const totalStockValue = allProducts.reduce(
      (sum, product) => sum + (product.currentStock * product.averageCost),
      0
    );

    // Invoice stats
    const totalInvoices = await Invoice.countDocuments({ company: companyId });
    const pendingInvoices = await Invoice.countDocuments({ 
      company: companyId,
      status: { $in: ['pending', 'partial', 'overdue'] } 
    });
    
    const monthlyInvoices = await Invoice.aggregate([
      { $match: { company: companyId, invoiceDate: { $gte: startOfMonth } } },
      { $group: { 
        _id: null, 
        total: { $sum: '$grandTotal' },
        paid: { $sum: '$amountPaid' },
        count: { $sum: 1 }
      }}
    ]);

    // Subtract credit notes issued this month from sales totals to reflect net sales
    const monthlyCreditNotes = await CreditNote.aggregate([
      { $match: { company: companyId, issueDate: { $gte: startOfMonth }, status: { $ne: 'draft' } } },
      { $group: { _id: null, totalCredits: { $sum: '$grandTotal' } } }
    ]);

    const yearlyInvoices = await Invoice.aggregate([
      { $match: { company: companyId, invoiceDate: { $gte: startOfYear } } },
      { $group: { 
        _id: null, 
        total: { $sum: '$grandTotal' },
        paid: { $sum: '$amountPaid' },
        count: { $sum: 1 }
      }}
    ]);

    // Subtract credit notes for the year
    const yearlyCreditNotes = await CreditNote.aggregate([
      { $match: { company: companyId, issueDate: { $gte: startOfYear }, status: { $ne: 'draft' } } },
      { $group: { _id: null, totalCredits: { $sum: '$grandTotal' } } }
    ]);

    // Quotation stats
    const activeQuotations = await Quotation.countDocuments({ 
      company: companyId,
      status: { $in: ['draft', 'sent', 'approved'] } 
    });

    // Client stats
    const totalClients = await Client.countDocuments({ company: companyId, isActive: true });

    res.json({
      success: true,
      data: {
        products: {
          total: totalProducts,
          totalLastMonth: totalProductsLastMonth,
          lowStock: lowStockProducts,
          outOfStock: outOfStockProducts,
          totalValue: totalStockValue
        },
        invoices: {
          total: totalInvoices,
          pending: pendingInvoices,
          monthly: {
            count: monthlyInvoices[0]?.count || 0,
            // subtract credit notes to show net sales
            total: (monthlyInvoices[0]?.total || 0) - (monthlyCreditNotes[0]?.totalCredits || 0),
            paid: monthlyInvoices[0]?.paid || 0
          },
          yearly: {
            count: yearlyInvoices[0]?.count || 0,
            total: (yearlyInvoices[0]?.total || 0) - (yearlyCreditNotes[0]?.totalCredits || 0),
            paid: yearlyInvoices[0]?.paid || 0
          }
        },
        quotations: {
          active: activeQuotations
        },
        clients: {
          total: totalClients,
          totalLastMonth: totalClientsLastMonth
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get recent activities
// @route   GET /api/dashboard/recent-activities
// @access  Private
exports.getRecentActivities = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const limit = parseInt(req.query.limit) || 20;

    const activities = await ActionLog.find({ company: companyId })
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      success: true,
      count: activities.length,
      data: activities
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get low stock alerts
// @route   GET /api/dashboard/low-stock-alerts
// @access  Private
exports.getLowStockAlerts = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    
    const products = await Product.find({
      company: companyId,
      isArchived: false,
      $expr: { $lte: ['$currentStock', '$lowStockThreshold'] }
    })
      .populate('category', 'name')
      .sort({ currentStock: 1 })
      .limit(20);

    res.json({
      success: true,
      count: products.length,
      data: products
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get top selling products
// @route   GET /api/dashboard/top-selling-products
// @access  Private
exports.getTopSellingProducts = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const limit = parseInt(req.query.limit) || 10;
    const { startDate, endDate } = req.query;

    const matchStage = {
      company: companyId,
      type: 'out',
      reason: 'sale'
    };

    if (startDate || endDate) {
      matchStage.movementDate = {};
      if (startDate) matchStage.movementDate.$gte = new Date(startDate);
      if (endDate) matchStage.movementDate.$lte = new Date(endDate);
    }

    const topProducts = await StockMovement.aggregate([
      { $match: matchStage },
      { $group: {
        _id: '$product',
        totalQuantity: { $sum: '$quantity' },
        totalRevenue: { $sum: '$totalCost' },
        salesCount: { $sum: 1 }
      }},
      { $sort: { totalQuantity: -1 } },
      { $limit: limit }
    ]);

    // Populate product details
    await Product.populate(topProducts, { 
      path: '_id', 
      select: 'name sku unit category',
      match: { company: companyId },
      populate: { path: 'category', select: 'name' }
    });

    res.json({
      success: true,
      count: topProducts.length,
      data: topProducts
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get top clients
// @route   GET /api/dashboard/top-clients
// @access  Private
exports.getTopClients = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const limit = parseInt(req.query.limit) || 10;
    const { startDate, endDate } = req.query;

    const matchStage = {
      company: companyId,
      status: { $in: ['paid', 'partial'] }
    };

    if (startDate || endDate) {
      matchStage.invoiceDate = {};
      if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
      if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
    }

    const topClients = await Invoice.aggregate([
      { $match: matchStage },
      { $group: {
        _id: '$client',
        totalAmount: { $sum: '$grandTotal' },
        totalPaid: { $sum: '$amountPaid' },
        invoiceCount: { $sum: 1 }
      }},
      { $sort: { totalAmount: -1 } },
      { $limit: limit }
    ]);

    // Populate client details
    await Client.populate(topClients, { 
      path: '_id', 
      match: { company: companyId },
      select: 'name code contact type'
    });

    res.json({
      success: true,
      count: topClients.length,
      data: topClients
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales chart data
// @route   GET /api/dashboard/sales-chart
// @access  Private
exports.getSalesChart = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const { period = 'month' } = req.query; // 'week', 'month', 'year'
    
    let groupBy;
    let startDate = new Date();

    if (period === 'week') {
      startDate.setDate(startDate.getDate() - 7);
      groupBy = { 
        $dateToString: { format: '%Y-%m-%d', date: '$invoiceDate' }
      };
    } else if (period === 'month') {
      startDate.setMonth(startDate.getMonth() - 1);
      groupBy = { 
        $dateToString: { format: '%Y-%m-%d', date: '$invoiceDate' }
      };
    } else {
      startDate.setFullYear(startDate.getFullYear() - 1);
      groupBy = { 
        $dateToString: { format: '%Y-%m', date: '$invoiceDate' }
      };
    }

    const salesData = await Invoice.aggregate([
      { $match: { 
        company: companyId,
        invoiceDate: { $gte: startDate },
        status: { $ne: 'cancelled' }
      }},
      { $group: {
        _id: groupBy,
        sales: { $sum: '$grandTotal' },
        totalPaid: { $sum: '$amountPaid' },
        invoiceCount: { $sum: 1 }
      }},
      { $sort: { _id: 1 } }
    ]);

    // Transform data for frontend chart
    const formattedSalesData = salesData.map(item => ({
      month: item._id,
      sales: item.sales
    }));

    res.json({
      success: true,
      data: formattedSalesData
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get stock movement chart data
// @route   GET /api/dashboard/stock-movement-chart
// @access  Private
exports.getStockMovementChart = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const { period = 'month' } = req.query;
    
    let startDate = new Date();

    if (period === 'week') {
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === 'month') {
      startDate.setMonth(startDate.getMonth() - 1);
    } else {
      startDate.setFullYear(startDate.getFullYear() - 1);
    }

    const movementData = await StockMovement.aggregate([
      { $match: { company: companyId, movementDate: { $gte: startDate } } },
      { $group: {
        _id: '$type',
        quantity: { $sum: '$quantity' }
      }}
    ]);

    // Transform data for frontend chart
    const formattedStockData = movementData.map(item => ({
      type: item._id || 'unknown',
      quantity: item.quantity
    }));

    res.json({
      success: true,
      data: formattedStockData
    });
  } catch (error) {
    next(error);
  }
};
