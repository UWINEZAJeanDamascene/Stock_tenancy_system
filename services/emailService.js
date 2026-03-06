const nodemailer = require('nodemailer');
const mailgun = require('mailgun-js');

// Initialize Mailgun
const initializeMailgun = () => {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  
  if (apiKey && domain && apiKey !== 'your_mailgun_api_key_here') {
    return mailgun({ apiKey, domain });
  }
  return null;
};

// Create transporter for nodemailer (fallback)
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mailgun.org',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
};

// Send email using Mailgun or nodemailer
const sendEmail = async (to, subject, html, text = null) => {
  const mg = initializeMailgun();
  
  const mailOptions = {
    from: process.env.EMAIL_FROM || 'Stock Management <noreply@stockmanager.com>',
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, '') // Strip HTML for plain text
  };

  try {
    if (mg) {
      // Use Mailgun
      await mg.messages().send(mailOptions);
      console.log(`📧 Email sent via Mailgun to: ${to}`);
      return true;
    } else {
      // Fallback to nodemailer
      const transporter = createTransporter();
      if (transporter) {
        await transporter.sendMail(mailOptions);
        console.log(`📧 Email sent via SMTP to: ${to}`);
      } else {
        console.warn(`📧 Email not sent (no transporter): ${to} - ${subject}`);
      }
      return true;
    }
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
};

// ============================================
// INVOICE NOTIFICATIONS
// ============================================

// Send invoice email to client
const sendInvoiceEmail = async (invoice, company, client, pdfBuffer = null) => {
  const clientEmail = client?.contact?.email || client?.email;
  if (!clientEmail) {
    console.warn('No client email found for invoice:', invoice.invoiceNumber);
    return false;
  }

  const subject = `Invoice ${invoice.invoiceNumber} from ${company?.name || 'Stock Management'}`;
  const dueDate = new Date(invoice.dueDate).toLocaleDateString();
  const createdDate = new Date(invoice.createdAt).toLocaleDateString();
  
  // Build line items HTML
  let itemsHtml = '';
  if (invoice.items && invoice.items.length > 0) {
    itemsHtml = invoice.items.map(item => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.description || item.name || 'Item'}</td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity || 1}</td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">${(invoice.currency || '$')}${(item.price || 0).toFixed(2)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">${(invoice.currency || '$')}${(item.total || (item.price * item.quantity)).toFixed(2)}</td>
      </tr>
    `).join('');
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">📄 Invoice</h1>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 20px;">
          <div>
            <h2 style="margin: 0; color: #667eea;">${invoice.invoiceNumber}</h2>
            <p style="margin: 5px 0; color: #666;">Date: ${createdDate}</p>
            <p style="margin: 5px 0; color: #666;">Due Date: ${dueDate}</p>
          </div>
          <div style="text-align: right;">
            <strong>${company?.name || 'Company'}</strong><br>
            ${company?.address || ''}<br>
            ${company?.email || ''}
          </div>
        </div>

        <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <strong>Bill To:</strong><br>
          ${client?.name || 'Client'}<br>
          ${client?.contact?.address || ''}
        </div>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background: #667eea; color: white;">
              <th style="padding: 12px; text-align: left;">Description</th>
              <th style="padding: 12px; text-align: center;">Qty</th>
              <th style="padding: 12px; text-align: right;">Price</th>
              <th style="padding: 12px; text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <div style="text-align: right; margin: 20px 0;">
          <p style="margin: 5px 0;">Subtotal: ${(invoice.currency || '$')}${(invoice.subtotal || invoice.total || 0).toFixed(2)}</p>
          <p style="margin: 5px 0;">Tax: ${(invoice.currency || '$')}${(invoice.tax || 0).toFixed(2)}</p>
          <p style="margin: 5px 0; font-size: 18px; font-weight: bold;">Total: ${(invoice.currency || '$')}${(invoice.total || 0).toFixed(2)}</p>
          ${invoice.balance !== undefined ? `<p style="margin: 5px 0; color: #e53e3e;">Balance Due: ${(invoice.currency || '$')}${(invoice.balance || 0).toFixed(2)}</p>` : ''}
        </div>

        ${invoice.notes ? `<div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;"><strong>Notes:</strong><br>${invoice.notes}</div>` : ''}
        
        <div style="text-align: center; margin-top: 30px;">
          <a href="${process.env.FRONTEND_URL || 'https://stock-management-v3rl.onrender.com'}/invoices/${invoice._id}" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">View Invoice Online</a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          Thank you for your business! Payment is due by ${dueDate}.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(clientEmail, subject, html);
};

// ============================================
// PAYMENT REMINDER NOTIFICATIONS
// ============================================

const sendPaymentReminderEmail = async (invoice, company, client) => {
  const clientEmail = client?.contact?.email || client?.email;
  if (!clientEmail) return false;

  const daysUntilDue = Math.ceil((new Date(invoice.dueDate) - new Date()) / (1000 * 60 * 60 * 24));
  const isOverdue = daysUntilDue < 0;
  
  const subject = isOverdue 
    ? `OVERDUE: Invoice ${invoice.invoiceNumber} - Payment Required`
    : `Payment Reminder: Invoice ${invoice.invoiceNumber} due in ${daysUntilDue} day(s)`;
    
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: ${isOverdue ? 'linear-gradient(135deg, #f56565 0%, #e53e3e 100%)' : 'linear-gradient(135deg, #f6ad55 0%, #ed8936 100%)'}; padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">${isOverdue ? '⚠️ PAYMENT OVERDUE' : '⏰ Payment Reminder'}</h1>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <p>Dear <strong>${client?.name || 'Valued Customer'}</strong>,</p>
        
        ${isOverdue ? `
        <div style="background: #fed7d7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #e53e3e;">
          <strong style="color: #c53030;">Your payment is overdue!</strong> Please arrange payment as soon as possible.
        </div>
        ` : `
        <div style="background: #feebc8; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ed8936;">
          <strong style="color: #c05621;">Your payment is due in ${daysUntilDue} day(s).</strong> Please arrange payment.
        </div>
        `}

        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Invoice Details</h3>
          <table style="width: 100%;">
            <tr>
              <td style="padding: 8px 0;"><strong>Invoice Number:</strong></td>
              <td style="text-align: right;">${invoice.invoiceNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0;"><strong>Due Date:</strong></td>
              <td style="text-align: right;">${new Date(invoice.dueDate).toLocaleDateString()}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0;"><strong>Amount Due:</strong></td>
              <td style="text-align: right; font-size: 18px; color: #667eea;">${(invoice.currency || '$')}${(invoice.balance || invoice.total).toFixed(2)}</td>
            </tr>
          </table>
        </div>

        <div style="text-align: center; margin-top: 30px;">
          <a href="${process.env.FRONTEND_URL || 'https://stock-management-v3rl.onrender.com'}/invoices/${invoice._id}" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Pay Now</a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          If you have already made payment, please ignore this reminder.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(clientEmail, subject, html);
};

// ============================================
// LOW STOCK ALERT NOTIFICATIONS
// ============================================

const sendLowStockAlertEmail = async (product, company, reorderPoint = null) => {
  // Get admin emails for the company
  const User = require('../models/User');
  const admins = await User.find({ 
    company: company._id, 
    role: 'admin', 
    isActive: true 
  }).select('email name');
  
  const emails = admins.map(a => a.email).filter(Boolean);
  if (emails.length === 0) {
    console.warn('No admin emails found for company:', company.name);
    return false;
  }

  const threshold = process.env.LOW_STOCK_THRESHOLD || 10;
  const isCritical = product.currentStock <= Math.floor(threshold / 2);
  
  const subject = isCritical
    ? `🔴 CRITICAL: Low Stock Alert - ${product.name}`
    : `⚠️ Low Stock Alert - ${product.name}`;
    
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: ${isCritical ? 'linear-gradient(135deg, #f56565 0%, #e53e3e 100%)' : 'linear-gradient(135deg, #f6ad55 0%, #ed8936 100%)'}; padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">${isCritical ? '🔴 CRITICAL LOW STOCK' : '⚠️ Low Stock Alert'}</h1>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <p>Dear <strong>Administrator</strong>,</p>
        
        <p>The following product requires immediate attention:</p>
        
        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <table style="width: 100%;">
            <tr>
              <td style="padding: 8px 0;"><strong>Product Name:</strong></td>
              <td style="text-align: right;">${product.name}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0;"><strong>SKU:</strong></td>
              <td style="text-align: right;">${product.sku || 'N/A'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0;"><strong>Current Stock:</strong></td>
              <td style="text-align: right; font-size: 24px; ${isCritical ? 'color: #e53e3e;' : 'color: #ed8936;'} font-weight: bold;">${product.currentStock}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0;"><strong>Reorder Point:</strong></td>
              <td style="text-align: right;">${reorderPoint?.reorderQuantity || threshold}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0;"><strong>Warehouse:</strong></td>
              <td style="text-align: right;">${product.warehouse?.name || 'Default'}</td>
            </tr>
          </table>
        </div>

        <div style="text-align: center; margin-top: 30px;">
          <a href="${process.env.FRONTEND_URL || 'https://stock-management-v3rl.onrender.com'}/products/${product._id}" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Reorder Now</a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          This is an automated alert from Stock Management System.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(emails.join(','), subject, html);
};

// ============================================
// DAILY/WEEKLY SUMMARY REPORTS
// ============================================

const sendDailySummaryEmail = async (company, stats) => {
  const User = require('../models/User');
  const admins = await User.find({ 
    company: company._id, 
    role: 'admin', 
    isActive: true 
  }).select('email name');
  
  const emails = admins.map(a => a.email).filter(Boolean);
  if (emails.length === 0) return false;

  const subject = `📊 Daily Summary - ${company.name} - ${new Date().toLocaleDateString()}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">📊 Daily Summary Report</h1>
        <p style="color: white; text-align: center; margin: 10px 0 0 0;">${company.name} - ${new Date().toLocaleDateString()}</p>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0;">
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #667eea;">${stats.newInvoices || 0}</div>
            <div style="color: #666;">New Invoices</div>
          </div>
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #48bb78;">${stats.newSales || 0}</div>
            <div style="color: #666;">Sales Today</div>
          </div>
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #ed8936;">${stats.lowStockCount || 0}</div>
            <div style="color: #666;">Low Stock Items</div>
          </div>
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #e53e3e;">${stats.overdueInvoices || 0}</div>
            <div style="color: #666;">Overdue Invoices</div>
          </div>
        </div>

        ${stats.topProducts && stats.topProducts.length > 0 ? `
        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Top Selling Products</h3>
          <table style="width: 100%;">
            ${stats.topProducts.slice(0, 5).map((p, i) => `
            <tr>
              <td style="padding: 8px 0;">${i + 1}. ${p.name}</td>
              <td style="text-align: right; color: #666;">${p.quantity} sold</td>
            </tr>
            `).join('')}
          </table>
        </div>
        ` : ''}

        <div style="text-align: center; margin-top: 30px;">
          <a href="${process.env.FRONTEND_URL || 'https://stock-management-v3rl.onrender.com'}/dashboard" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">View Dashboard</a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          This is an automated daily report from Stock Management System.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(emails.join(','), subject, html);
};

const sendWeeklySummaryEmail = async (company, stats) => {
  const User = require('../models/User');
  const admins = await User.find({ 
    company: company._id, 
    role: 'admin', 
    isActive: true 
  }).select('email name');
  
  const emails = admins.map(a => a.email).filter(Boolean);
  if (emails.length === 0) return false;

  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  
  const subject = `📊 Weekly Summary - ${company.name} - Week of ${startOfWeek.toLocaleDateString()}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">📊 Weekly Summary Report</h1>
        <p style="color: white; text-align: center; margin: 10px 0 0 0;">${company.name}</p>
        <p style="color: white; text-align: center; margin: 5px 0 0 0;">${startOfWeek.toLocaleDateString()} - ${new Date().toLocaleDateString()}</p>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0;">
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #667eea;">${stats.totalInvoices || 0}</div>
            <div style="color: #666;">Total Invoices</div>
          </div>
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #48bb78;">${(stats.totalRevenue || 0).toFixed(2)}</div>
            <div style="color: #666;">Total Revenue</div>
          </div>
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #ed8936;">${stats.totalPurchases || 0}</div>
            <div style="color: #666;">Purchase Orders</div>
          </div>
          <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
            <div style="font-size: 32px; font-weight: bold; color: #e53e3e;">${stats.lowStockCount || 0}</div>
            <div style="color: #666;">Low Stock Items</div>
          </div>
        </div>

        ${stats.categoryBreakdown && stats.categoryBreakdown.length > 0 ? `
        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Sales by Category</h3>
          ${stats.categoryBreakdown.map(c => `
          <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee;">
            <span>${c.category}</span>
            <span style="font-weight: bold;">${(company.currency || '$')}${(c.revenue || 0).toFixed(2)}</span>
          </div>
          `).join('')}
        </div>
        ` : ''}

        <div style="text-align: center; margin-top: 30px;">
          <a href="${process.env.FRONTEND_URL || 'https://stock-management-v3rl.onrender.com'}/reports" style="background: #48bb78; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">View Full Report</a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          This is an automated weekly report from Stock Management System.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(emails.join(','), subject, html);
};

// ============================================
// COMPANY APPROVAL/REJECTION (Existing)
// ============================================

const sendApprovalEmail = async (companyEmail, companyName, adminName) => {
  const subject = 'Your Company Has Been Approved - Stock Management System';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">🎉 Congratulations!</h1>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <p>Dear <strong>${adminName}</strong>,</p>
        
        <p>We are pleased to inform you that your company <strong>${companyName}</strong> has been <span style="color: #28a745; font-weight: bold;">APPROVED</span> and is now active on the Stock Management System.</p>
        
        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #28a745;">
          <h3 style="margin-top: 0; color: #28a745;">✅ What's Next?</h3>
          <ul style="margin: 0; padding-left: 20px;">
            <li>Log in to your account using your credentials</li>
            <li>Complete your company profile</li>
            <li>Start managing your inventory and sales</li>
            <li>Invite team members to join your account</li>
          </ul>
        </div>
        
        <div style="text-align: center; margin-top: 30px;">
          <a href="${process.env.FRONTEND_URL || 'https://stock-management-v3rl.onrender.com'}" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Login to Your Account</a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          This is an automated message from Stock Management System.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(companyEmail, subject, html);
};

const sendRejectionEmail = async (companyEmail, companyName, adminName, reason) => {
  const subject = 'Your Company Registration - Stock Management System';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #f56565 0%, #e53e3e 100%); padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">Important Update</h1>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <p>Dear <strong>${adminName}</strong>,</p>
        
        <p>We regret to inform you that your company <strong>${companyName}</strong>'s registration has been <span style="color: #e53e3e; font-weight: bold;">NOT APPROVED</span>.</p>
        
        ${reason ? `
        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #e53e3e;">
          <h3 style="margin-top: 0; color: #e53e3e;">Reason:</h3>
          <p style="margin: 0;">${reason}</p>
        </div>
        ` : ''}
        
        <p>If you believe this is an error or would like to resubmit your application, please contact our support team.</p>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          This is an automated message from Stock Management System.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(companyEmail, subject, html);
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  sendEmail,
  // Invoice notifications
  sendInvoiceEmail,
  // Payment reminders
  sendPaymentReminderEmail,
  // Low stock alerts
  sendLowStockAlertEmail,
  // Summary reports
  sendDailySummaryEmail,
  sendWeeklySummaryEmail,
  // Company notifications
  sendApprovalEmail,
  sendRejectionEmail
};
