const NotificationSettings = require('../models/NotificationSettings');

// @desc    Get notification settings
// @route   GET /api/notifications/settings
// @access  Private (admin)
exports.getSettings = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    let settings = await NotificationSettings.findOne({ company: companyId });
    
    if (!settings) {
      // Create default settings
      settings = await NotificationSettings.create({
        company: companyId,
        emailNotifications: {
          enabled: true,
          invoiceDelivery: false,
          paymentReminders: true,
          lowStockAlerts: true,
          dailySummary: false,
          weeklySummary: true
        },
        smsNotifications: {
          enabled: false,
          criticalOnly: true,
          adminPhones: []
        }
      });
    }
    
    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update notification settings
// @route   PUT /api/notifications/settings
// @access  Private (admin)
exports.updateSettings = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      emailNotifications,
      smsNotifications,
      preferences,
      criticalAlertPhones
    } = req.body;
    
    let settings = await NotificationSettings.findOne({ company: companyId });
    
    if (!settings) {
      settings = await NotificationSettings.create({
        company: companyId
      });
    }
    
    // Update fields
    if (emailNotifications) {
      settings.emailNotifications = {
        ...settings.emailNotifications,
        ...emailNotifications
      };
    }
    
    if (smsNotifications) {
      settings.smsNotifications = {
        ...settings.smsNotifications,
        ...smsNotifications
      };
    }
    
    if (preferences) {
      settings.preferences = {
        ...settings.preferences,
        ...preferences
      };
    }
    
    if (criticalAlertPhones) {
      settings.criticalAlertPhones = criticalAlertPhones;
    }
    
    await settings.save();
    
    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Test email notification
// @route   POST /api/notifications/test-email
// @access  Private (admin)
exports.testEmail = async (req, res, next) => {
  try {
    const { email } = req.body;
    const emailService = require('../services/emailService');
    
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email address required'
      });
    }
    
    const result = await emailService.sendEmail(
      email,
      'Test Notification - Stock Management System',
      `
      <h2>Test Notification</h2>
      <p>This is a test email from your Stock Management System.</p>
      <p>If you received this, your email notifications are configured correctly!</p>
      `
    );
    
    if (result) {
      res.json({
        success: true,
        message: 'Test email sent successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send test email'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Test SMS notification
// @route   POST /api/notifications/test-sms
// @access  Private (admin)
exports.testSMS = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const smsService = require('../services/smsService');
    
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number required'
      });
    }
    
    const result = await smsService.sendSMS(
      phone,
      'This is a test SMS from your Stock Management System. If you received this, your SMS notifications are configured correctly!'
    );
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Test SMS sent successfully',
        messageId: result.messageId
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.error || 'Failed to send test SMS'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Trigger manual summary report
// @route   POST /api/notifications/send-summary
// @access  Private (admin)
exports.sendManualSummary = async (req, res, next) => {
  try {
    const { type } = req.body; // 'daily' or 'weekly'
    const companyId = req.user.company._id;
    const Company = require('../models/Company');
    const emailService = require('../services/emailService');
    
    const company = await Company.findById(companyId);
    
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }
    
    // Get stats based on type
    const Invoice = require('../models/Invoice');
    const Product = require('../models/Product');
    
    const days = type === 'weekly' ? 7 : 1;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const [
      totalInvoices,
      totalRevenue,
      lowStockCount,
      topProducts
    ] = await Promise.all([
      Invoice.countDocuments({ company: companyId, createdAt: { $gte: since } }),
      Invoice.aggregate([
        { $match: { company: companyId, status: 'confirmed', createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$total' } } }
      ]),
      Product.countDocuments({ company: companyId, currentStock: { $lte: Number(process.env.LOW_STOCK_THRESHOLD || 5) } }),
      Product.find({ company: companyId }).sort({ currentStock: 1 }).limit(5)
    ]);
    
    const stats = {
      newInvoices: totalInvoices,
      newSales: totalInvoices,
      lowStockCount,
      overdueInvoices: 0,
      topProducts: topProducts.map(p => ({ name: p.name, quantity: p.currentStock })),
      totalInvoices,
      totalRevenue: totalRevenue[0]?.total || 0,
      totalPurchases: 0
    };
    
    let result;
    if (type === 'weekly') {
      result = await emailService.sendWeeklySummaryEmail(company, stats);
    } else {
      result = await emailService.sendDailySummaryEmail(company, stats);
    }
    
    if (result) {
      res.json({
        success: true,
        message: `${type === 'weekly' ? 'Weekly' : 'Daily'} summary sent successfully`
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send summary report'
      });
    }
  } catch (error) {
    next(error);
  }
};
