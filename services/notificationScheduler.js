const cron = require('node-cron');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Company = require('../models/Company');
const User = require('../models/User');
const NotificationSettings = require('../models/NotificationSettings');
const emailService = require('./emailService');
const smsService = require('./smsService');

// ============================================
// HELPER FUNCTIONS
// ============================================

// Get notification settings for a company
const getNotificationSettings = async (companyId) => {
  try {
    let settings = await NotificationSettings.findOne({ company: companyId });
    
    // Create default settings if none exist
    if (!settings) {
      settings = await NotificationSettings.create({
        company: companyId,
        emailNotifications: {
          enabled: true,
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
    
    return settings;
  } catch (err) {
    console.error('Error getting notification settings:', err);
    return null;
  }
};

// Get admin users with phones for SMS
const getAdminPhones = async (companyId) => {
  const admins = await User.find({ 
    company: companyId, 
    role: 'admin', 
    isActive: true 
  }).select('phone');
  
  const phones = admins.map(a => a.phone).filter(Boolean);
  const settings = await getNotificationSettings(companyId);
  
  if (settings?.smsNotifications?.adminPhones?.length > 0) {
    return [...new Set([...phones, ...settings.smsNotifications.adminPhones])];
  }
  
  return phones;
};

// ============================================
// PAYMENT REMINDERS
// ============================================

async function sendPaymentReminders() {
  console.log('🔔 Running payment reminder job...');
  
  try {
    const companies = await Company.find({});
    
    for (const company of companies) {
      const settings = await getNotificationSettings(company._id);
      
      // Check if email notifications enabled
      if (!settings?.emailNotifications?.enabled || 
          !settings?.emailNotifications?.paymentReminders) {
        continue;
      }

      const daysBefore = settings?.preferences?.paymentReminderDays || 3;
      const now = new Date();
      const target = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);

      // Find due invoices
      const invoices = await Invoice.find({
        company: company._id,
        dueDate: { $lte: target },
        status: { $in: ['draft', 'confirmed'] },
        balance: { $gt: 0 }
      }).populate('client company');

      for (const inv of invoices) {
        const clientEmail = inv.client?.contact?.email || inv.customerEmail;
        if (!clientEmail) continue;

        try {
          await emailService.sendPaymentReminderEmail(inv, company, inv.client);
          console.log(`📧 Payment reminder sent for invoice ${inv.invoiceNumber}`);
        } catch (err) {
          console.error('Failed to send payment reminder for invoice', inv._id, err);
        }
      }
      
      // Check for overdue invoices - send SMS for critical
      const overdueInvoices = await Invoice.find({
        company: company._id,
        dueDate: { $lt: now },
        status: { $in: ['draft', 'confirmed'] },
        balance: { $gt: 0 }
      });
      
      if (settings?.smsNotifications?.enabled && overdueInvoices.length > 0) {
        const phones = await getAdminPhones(company._id);
        if (phones.length > 0) {
          for (const inv of overdueInvoices.slice(0, 3)) { // Limit to 3 SMS
            await smsService.sendPaymentOverdueSMS(inv, company, phones);
          }
        }
      }
    }
  } catch (err) {
    console.error('Payment reminder job failed', err);
  }
}

// ============================================
// LOW STOCK CHECKS
// ============================================

async function checkLowStock() {
  console.log('🔔 Running low stock check job...');
  
  try {
    const companies = await Company.find({});
    const threshold = process.env.LOW_STOCK_THRESHOLD || 10;

    for (const company of companies) {
      const settings = await getNotificationSettings(company._id);
      const companyThreshold = settings?.preferences?.lowStockThreshold || threshold;

      // Find low stock products
      const products = await Product.find({
        company: company._id,
        currentStock: { $lte: companyThreshold }
      }).populate('company warehouse');

      for (const p of products) {
        const isCritical = p.currentStock <= Math.floor(companyThreshold / 2);
        
        // Send email alert
        if (settings?.emailNotifications?.enabled && 
            settings?.emailNotifications?.lowStockAlerts) {
          try {
            await emailService.sendLowStockAlertEmail(p, company);
            console.log(`📧 Low stock alert sent for product ${p.name}`);
          } catch (err) {
            console.error('Failed to send low stock email for product', p._id, err);
          }
        }
        
        // Send SMS for critical stock
        if (settings?.smsNotifications?.enabled) {
          const phones = await getAdminPhones(company._id);
          if (phones.length > 0 && isCritical) {
            await smsService.sendLowStockCriticalSMS(p, company, phones);
          }
        }
      }
    }
  } catch (err) {
    console.error('Low stock check job failed', err);
  }
}

// ============================================
// DAILY SUMMARY REPORTS
// ============================================

async function sendDailySummaryReports() {
  console.log('🔔 Running daily summary job...');
  
  try {
    const companies = await Company.find({});

    for (const company of companies) {
      const settings = await getNotificationSettings(company._id);
      
      if (!settings?.emailNotifications?.enabled || 
          !settings?.emailNotifications?.dailySummary) {
        continue;
      }

      // Get stats
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const [
        newInvoices,
        newSales,
        lowStockCount,
        overdueInvoices,
        topProducts
      ] = await Promise.all([
        Invoice.countDocuments({ company: company._id, createdAt: { $gte: since } }),
        Invoice.countDocuments({ company: company._id, status: 'confirmed', createdAt: { $gte: since } }),
        Product.countDocuments({ company: company._id, currentStock: { $lte: Number(process.env.LOW_STOCK_THRESHOLD || 5) } }),
        Invoice.countDocuments({ 
          company: company._id, 
          dueDate: { $lt: new Date() },
          status: { $in: ['draft', 'confirmed'] },
          balance: { $gt: 0 }
        }),
        // Get top products by sales (simplified)
        Product.find({ company: company._id }).sort({ currentStock: 1 }).limit(5)
      ]);

      const stats = {
        newInvoices,
        newSales,
        lowStockCount,
        overdueInvoices,
        topProducts: topProducts.map(p => ({ name: p.name, quantity: p.currentStock }))
      };

      try {
        await emailService.sendDailySummaryEmail(company, stats);
        console.log(`📧 Daily summary sent for company ${company.name}`);
      } catch (err) {
        console.error('Failed to send daily summary for company', company._id, err);
      }
    }
  } catch (err) {
    console.error('Daily summary job failed', err);
  }
}

// ============================================
// WEEKLY SUMMARY REPORTS
// ============================================

async function sendWeeklySummaryReports() {
  console.log('🔔 Running weekly summary job...');
  
  try {
    const companies = await Company.find({});

    for (const company of companies) {
      const settings = await getNotificationSettings(company._id);
      
      if (!settings?.emailNotifications?.enabled || 
          !settings?.emailNotifications?.weeklySummary) {
        continue;
      }

      // Get stats for last 7 days
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      const [
        totalInvoices,
        totalRevenue,
        totalPurchases,
        lowStockCount,
        categoryBreakdown
      ] = await Promise.all([
        Invoice.countDocuments({ company: company._id, createdAt: { $gte: since } }),
        Invoice.aggregate([
          { $match: { company: company._id, status: 'confirmed', createdAt: { $gte: since } } },
          { $group: { _id: null, total: { $sum: '$total' } } }
        ]),
        require('../models/Purchase').countDocuments({ company: company._id, createdAt: { $gte: since } }),
        Product.countDocuments({ company: company._id, currentStock: { $lte: Number(process.env.LOW_STOCK_THRESHOLD || 5) } }),
        // Category breakdown (simplified)
        Product.aggregate([
          { $match: { company: company._id } },
          { $group: { _id: '$category', revenue: { $sum: '$currentStock' } } },
          { $limit: 5 }
        ])
      ]);

      const stats = {
        totalInvoices,
        totalRevenue: totalRevenue[0]?.total || 0,
        totalPurchases,
        lowStockCount,
        categoryBreakdown: categoryBreakdown.map(c => ({ 
          category: c._id || 'Uncategorized', 
          revenue: c.revenue 
        }))
      };

      try {
        await emailService.sendWeeklySummaryEmail(company, stats);
        console.log(`📧 Weekly summary sent for company ${company.name}`);
      } catch (err) {
        console.error('Failed to send weekly summary for company', company._id, err);
      }
    }
  } catch (err) {
    console.error('Weekly summary job failed', err);
  }
}

// ============================================
// SCHEDULER START
// ============================================

function startScheduler() {
  console.log('📅 Starting notification scheduler...');
  
  // Payment reminders - every hour
  cron.schedule('0 * * * *', sendPaymentReminders);
  
  // Low stock check - every 2 hours
  cron.schedule('0 */2 * * *', checkLowStock);
  
  // Daily summary - every day at 9 AM
  cron.schedule('0 9 * * *', sendDailySummaryReports);
  
  // Weekly summary - every Monday at 9 AM
  cron.schedule('0 9 * * 1', sendWeeklySummaryReports);
  
  // Run initial checks
  sendPaymentReminders();
  checkLowStock();
  sendDailySummaryReports();
  
  console.log('✅ Notification scheduler started with cron jobs');
}

module.exports = { startScheduler };
