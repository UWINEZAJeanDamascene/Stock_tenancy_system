const { getTransporter } = require('../config/email');

// ============================================
// CONSTANTS
// ============================================

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000; // exponential: 1s → 2s → 4s

const getSender = () =>
  `${process.env.EMAIL_FROM_NAME || 'StockManager'} <${process.env.EMAIL_FROM_ADDRESS || process.env.GMAIL_USER}>`;

// ============================================
// HELPERS
// ============================================

/** Basic HTML-entity escaping to prevent XSS in dynamic values */
const esc = (str) => {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

/** Sleep helper for retry backoff */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Validate email format (loose check) */
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// ============================================
// CORE SEND — with retry & validation
// ============================================

const sendEmail = async (to, subject, html, { text, attachments, retries } = {}) => {
  // Validate recipient(s)
  const recipients = String(to).split(',').map((e) => e.trim()).filter(Boolean);
  const validRecipients = recipients.filter(isValidEmail);

  if (validRecipients.length === 0) {
    console.warn('❌ sendEmail: no valid recipients —', to);
    return false;
  }

  const mailOptions = {
    from: getSender(),
    to: validRecipients.join(','),
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, ''),
    ...(attachments && attachments.length > 0 ? { attachments } : {})
  };

  const maxAttempts = retries ?? MAX_RETRIES;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const transporter = getTransporter();
      await transporter.sendMail(mailOptions);
      console.log(`📧 Email sent to: ${validRecipients.join(', ')}`);
      return true;
    } catch (error) {
      const isLast = attempt === maxAttempts;
      const isTransient =
        error.responseCode >= 400 ||
        ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET'].includes(error.code);

      if (isLast || !isTransient) {
        console.error(
          `❌ Email failed [attempt ${attempt}/${maxAttempts}] to=${validRecipients.join(',')} subject="${subject}":`,
          error.message
        );
        return false;
      }

      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`⚠️  Email retry ${attempt}/${maxAttempts} in ${delay}ms — ${error.message}`);
      await sleep(delay);
    }
  }

  return false;
};

// ============================================
// INVOICE NOTIFICATIONS
// ============================================

const sendInvoiceEmail = async (invoice, company, client, pdfBuffer = null) => {
  const clientEmail = client?.contact?.email || client?.email;
  if (!clientEmail) {
    console.warn('No client email found for invoice:', invoice?.invoiceNumber);
    return false;
  }

  const subject = `Invoice ${esc(invoice.invoiceNumber)} from ${esc(company?.name || 'StockManager')}`;
  const dueDate = new Date(invoice.dueDate).toLocaleDateString();
  const createdDate = new Date(invoice.createdAt).toLocaleDateString();
  const currency = invoice.currency || 'RF';

  let itemsHtml = '';
  if (invoice.items && invoice.items.length > 0) {
    itemsHtml = invoice.items
      .map(
        (item) => `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #ddd;">${esc(item.description || item.name || 'Item')}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${item.quantity || 1}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${currency} ${(item.price || 0).toFixed(2)}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${currency} ${(item.total || item.price * item.quantity).toFixed(2)}</td>
      </tr>`
      )
      .join('');
  }

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📄 Invoice</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <h2 style="color:#7c3aed; margin:0 0 5px;">${esc(invoice.invoiceNumber)}</h2>
        <p style="color:#666; margin:5px 0;">Date: ${createdDate}</p>
        <p style="color:#666; margin:5px 0;">Due Date: ${dueDate}</p>
        <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
          <strong>Bill To:</strong><br/>${esc(client?.name || 'Client')}<br/>${esc(client?.contact?.address || '')}
        </div>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <thead>
            <tr style="background:#7c3aed; color:white;">
              <th style="padding:12px; text-align:left;">Description</th>
              <th style="padding:12px; text-align:center;">Qty</th>
              <th style="padding:12px; text-align:right;">Price</th>
              <th style="padding:12px; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align:right; margin:20px 0;">
          <p style="margin:5px 0;">Subtotal: ${currency} ${(invoice.subtotal || invoice.total || 0).toFixed(2)}</p>
          <p style="margin:5px 0;">Tax: ${currency} ${(invoice.tax || 0).toFixed(2)}</p>
          <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#7c3aed;">Total: ${currency} ${(invoice.total || 0).toFixed(2)}</p>
          ${invoice.balance !== undefined ? `<p style="margin:5px 0; color:#ef4444;">Balance Due: ${currency} ${(invoice.balance || 0).toFixed(2)}</p>` : ''}
        </div>
        ${invoice.notes ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Notes:</strong><br/>${esc(invoice.notes)}</div>` : ''}
        <div style="text-align:center; margin-top:30px;">
          <a href="${process.env.FRONTEND_URL}/invoices/${invoice._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Invoice Online</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">Thank you for your business! Payment is due by ${dueDate}.<br/>StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  const attachments = pdfBuffer
    ? [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdfBuffer }]
    : [];

  return sendEmail(clientEmail, subject, html, { attachments });
};

// ============================================
// PAYMENT REMINDER NOTIFICATIONS
// ============================================

const sendPaymentReminderEmail = async (invoice, company, client) => {
  const clientEmail = client?.contact?.email || client?.email;
  if (!clientEmail) return false;

  const daysUntilDue = Math.ceil((new Date(invoice.dueDate) - new Date()) / (1000 * 60 * 60 * 24));
  const isOverdue = daysUntilDue < 0;
  const daysOverdue = Math.abs(daysUntilDue);
  const currency = invoice.currency || 'RF';

  const subject = isOverdue
    ? `Payment Reminder: ${invoice.invoiceNumber} - OVERDUE`
    : `Payment Reminder: ${invoice.invoiceNumber} due in ${daysUntilDue} day(s)`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:${isOverdue ? '#ef4444' : '#7c3aed'}; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">${isOverdue ? '⚠️ PAYMENT OVERDUE' : '⏰ Payment Reminder'}</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Dear <strong>${esc(client?.name || 'Valued Customer')}</strong>,</p>
        <p>${isOverdue
          ? `Your invoice <b>${esc(invoice.invoiceNumber)}</b> is <b style="color:#ef4444;">${daysOverdue} days overdue.</b>`
          : `Your invoice <b>${esc(invoice.invoiceNumber)}</b> is due soon.`
        }</p>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <tr><td style="padding:8px; border:1px solid #ddd;">Invoice Number</td><td style="padding:8px; border:1px solid #ddd;">${esc(invoice.invoiceNumber)}</td></tr>
          <tr><td style="padding:8px; border:1px solid #ddd;">Amount Due</td><td style="padding:8px; border:1px solid #ddd; color:#7c3aed; font-weight:bold;">${currency} ${(invoice.balance || invoice.total || 0).toFixed(2)}</td></tr>
          <tr><td style="padding:8px; border:1px solid #ddd;">Due Date</td><td style="padding:8px; border:1px solid #ddd;">${new Date(invoice.dueDate).toLocaleDateString()}</td></tr>
        </table>
        <p>Please arrange payment at your earliest convenience.</p>
        <div style="text-align:center; margin-top:30px;">
          <a href="${process.env.FRONTEND_URL}/invoices/${invoice._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">Pay Now</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">If you have already made payment, please ignore this reminder.<br/>StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(clientEmail, subject, html);
};

// ============================================
// LOW STOCK ALERT NOTIFICATIONS
// ============================================

const sendLowStockAlertEmail = async (product, company, reorderPoint = null) => {
  const User = require('../models/User');
  const admins = await User.find({
    company: company._id,
    role: 'admin',
    isActive: true
  }).select('email name');

  const emails = admins.map((a) => a.email).filter(Boolean);
  if (emails.length === 0) {
    console.warn('No admin emails found for company:', company.name);
    return false;
  }

  const threshold = process.env.LOW_STOCK_THRESHOLD || 10;
  const isCritical = product.currentStock <= Math.floor(threshold / 2);

  const subject = isCritical
    ? `🔴 CRITICAL: Low Stock Alert - ${esc(product.name)}`
    : `⚠️ Low Stock Alert - ${esc(product.name)}`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:${isCritical ? '#ef4444' : '#f59e0b'}; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">${isCritical ? '🔴 CRITICAL LOW STOCK' : '⚠️ Low Stock Alert'}</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Dear <strong>Administrator</strong>,</p>
        <p>The following product requires immediate attention:</p>
        <div style="background:white; padding:20px; border-radius:8px; margin:20px 0;">
          <table style="width:100%;">
            <tr><td style="padding:8px 0;"><strong>Product Name:</strong></td><td style="text-align:right;">${esc(product.name)}</td></tr>
            <tr><td style="padding:8px 0;"><strong>SKU:</strong></td><td style="text-align:right;">${esc(product.sku || 'N/A')}</td></tr>
            <tr><td style="padding:8px 0;"><strong>Current Stock:</strong></td><td style="text-align:right; font-size:24px; color:${isCritical ? '#ef4444' : '#f59e0b'}; font-weight:bold;">${product.currentStock}</td></tr>
            <tr><td style="padding:8px 0;"><strong>Reorder Point:</strong></td><td style="text-align:right;">${reorderPoint?.reorderQuantity || threshold}</td></tr>
            <tr><td style="padding:8px 0;"><strong>Warehouse:</strong></td><td style="text-align:right;">${esc(product.warehouse?.name || 'Default')}</td></tr>
          </table>
        </div>
        <div style="text-align:center; margin-top:30px;">
          <a href="${process.env.FRONTEND_URL}/products/${product._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">Reorder Now</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Stock Alert</p>
      </div>
    </div>`;

  return sendEmail(emails.join(','), subject, html);
};

// ============================================
// BULK LOW STOCK ALERT (multiple products)
// ============================================

const sendBulkLowStockAlert = async ({ to, products }) => {
  const subject = `⚠️ Low Stock Alert - ${products.length} product(s)`;

  const rowsHtml = products
    .map(
      (p) => `
    <tr>
      <td style="padding:8px; border:1px solid #ddd;">${esc(p.name)}</td>
      <td style="padding:8px; border:1px solid #ddd; text-align:center; color:${p.currentStock === 0 ? '#ef4444' : '#f59e0b'};">${p.currentStock} ${esc(p.unit || '')}</td>
      <td style="padding:8px; border:1px solid #ddd; text-align:center;">${p.minStock} ${esc(p.unit || '')}</td>
      <td style="padding:8px; border:1px solid #ddd; text-align:center;">${p.currentStock === 0 ? '🔴 Out of Stock' : '🟡 Low Stock'}</td>
    </tr>`
    )
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:#f59e0b; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">⚠️ Low Stock Alert</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>The following products need restocking:</p>
        <table style="width:100%; border-collapse:collapse;">
          <tr style="background:#f3f4f6;">
            <th style="padding:8px; border:1px solid #ddd; text-align:left;">Product</th>
            <th style="padding:8px; border:1px solid #ddd;">Current Stock</th>
            <th style="padding:8px; border:1px solid #ddd;">Min Stock</th>
            <th style="padding:8px; border:1px solid #ddd;">Status</th>
          </tr>
          ${rowsHtml}
        </table>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Stock Alert</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html);
};

// ============================================
// WELCOME EMAIL
// ============================================

const sendWelcomeEmail = async ({ to, name, companyName }) => {
  const subject = `Welcome to StockManager, ${esc(companyName)}!`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">Welcome to StockManager! 🎉</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Hi <strong>${esc(name)}</strong>,</p>
        <p>Your account for <b>${esc(companyName)}</b> has been approved.</p>
        <p>You can now login and start managing your stock.</p>
        <div style="text-align:center; margin:30px 0;">
          <a href="${process.env.FRONTEND_URL}/login" style="background:#7c3aed; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block;">Login to Dashboard →</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html);
};

// ============================================
// PASSWORD RESET
// ============================================

const sendPasswordResetEmail = async ({ to, name, resetToken }) => {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
  const subject = 'Reset Your StockManager Password';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">🔒 Password Reset</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Hi <strong>${esc(name)}</strong>,</p>
        <p>Click below to reset your password. This link expires in <b>1 hour</b>.</p>
        <div style="text-align:center; margin:30px 0;">
          <a href="${resetUrl}" style="background:#7c3aed; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block;">Reset Password →</a>
        </div>
        <p style="color:#888; font-size:12px;">If you did not request this, please ignore this email.</p>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html);
};

// ============================================
// BACKUP CONFIRMATION
// ============================================

const sendBackupConfirmation = async ({ to, fileName, size }) => {
  const subject = '✅ Database Backup Completed';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:#10b981; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">✅ Backup Completed</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Your database backup was completed successfully.</p>
        <div style="background:white; padding:20px; border-radius:8px; margin:20px 0;">
          <p style="margin:8px 0;"><strong>File:</strong> ${esc(fileName)}</p>
          <p style="margin:8px 0;"><strong>Size:</strong> ${esc(size)}</p>
          <p style="margin:8px 0;"><strong>Stored in:</strong> Dropbox/StockManagerBackups</p>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Backup Notification</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html);
};

// ============================================
// COMPANY APPROVAL / REJECTION
// ============================================

const sendApprovalEmail = async (companyEmail, companyName, adminName) => {
  const subject = 'Your Company Has Been Approved - StockManager';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">🎉 Congratulations!</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Dear <strong>${esc(adminName)}</strong>,</p>
        <p>Your company <strong>${esc(companyName)}</strong> has been <span style="color:#10b981; font-weight:bold;">APPROVED</span> on StockManager.</p>
        <div style="background:white; padding:20px; border-radius:8px; margin:20px 0; border-left:4px solid #10b981;">
          <h3 style="margin-top:0; color:#10b981;">✅ What's Next?</h3>
          <ul style="margin:0; padding-left:20px;">
            <li>Log in to your account</li>
            <li>Complete your company profile</li>
            <li>Start managing your inventory and sales</li>
            <li>Invite team members</li>
          </ul>
        </div>
        <div style="text-align:center; margin-top:30px;">
          <a href="${process.env.FRONTEND_URL}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">Login to Your Account</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(companyEmail, subject, html);
};

const sendRejectionEmail = async (companyEmail, companyName, adminName, reason) => {
  const subject = 'Your Company Registration - StockManager';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:#ef4444; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">Important Update</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Dear <strong>${esc(adminName)}</strong>,</p>
        <p>Your company <strong>${esc(companyName)}</strong>'s registration has been <span style="color:#ef4444; font-weight:bold;">NOT APPROVED</span>.</p>
        ${reason ? `
        <div style="background:white; padding:20px; border-radius:8px; margin:20px 0; border-left:4px solid #ef4444;">
          <h3 style="margin-top:0; color:#ef4444;">Reason:</h3>
          <p style="margin:0;">${esc(reason)}</p>
        </div>` : ''}
        <p>If you believe this is an error, please contact our support team.</p>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(companyEmail, subject, html);
};

// ============================================
// DAILY / WEEKLY SUMMARY REPORTS
// ============================================

const sendDailySummaryEmail = async (company, stats) => {
  const User = require('../models/User');
  const admins = await User.find({ company: company._id, role: 'admin', isActive: true }).select('email');
  const emails = admins.map((a) => a.email).filter(Boolean);
  if (emails.length === 0) return false;

  const subject = `📊 Daily Summary - ${esc(company.name)} - ${new Date().toLocaleDateString()}`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📊 Daily Summary</h1>
        <p style="color:white; text-align:center; margin:10px 0 0;">${esc(company.name)} — ${new Date().toLocaleDateString()}</p>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <tr>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center; width:50%;"><div style="font-size:32px; font-weight:bold; color:#7c3aed;">${stats.newInvoices || 0}</div><div style="color:#666;">New Invoices</div></td>
            <td style="width:15px;"></td>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center; width:50%;"><div style="font-size:32px; font-weight:bold; color:#10b981;">${stats.newSales || 0}</div><div style="color:#666;">Sales Today</div></td>
          </tr>
          <tr><td colspan="3" style="height:15px;"></td></tr>
          <tr>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center;"><div style="font-size:32px; font-weight:bold; color:#f59e0b;">${stats.lowStockCount || 0}</div><div style="color:#666;">Low Stock Items</div></td>
            <td style="width:15px;"></td>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center;"><div style="font-size:32px; font-weight:bold; color:#ef4444;">${stats.overdueInvoices || 0}</div><div style="color:#666;">Overdue Invoices</div></td>
          </tr>
        </table>
        <div style="text-align:center; margin-top:30px;">
          <a href="${process.env.FRONTEND_URL}/dashboard" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Dashboard</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Daily Report</p>
      </div>
    </div>`;

  return sendEmail(emails.join(','), subject, html);
};

const sendWeeklySummaryEmail = async (company, stats) => {
  const User = require('../models/User');
  const admins = await User.find({ company: company._id, role: 'admin', isActive: true }).select('email');
  const emails = admins.map((a) => a.email).filter(Boolean);
  if (emails.length === 0) return false;

  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  const currency = company.currency || 'RF';

  const subject = `📊 Weekly Summary - ${esc(company.name)} - Week of ${startOfWeek.toLocaleDateString()}`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#10b981,#059669); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📊 Weekly Summary</h1>
        <p style="color:white; text-align:center; margin:10px 0 0;">${esc(company.name)}</p>
        <p style="color:white; text-align:center; margin:5px 0 0;">${startOfWeek.toLocaleDateString()} — ${new Date().toLocaleDateString()}</p>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <tr>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center; width:50%;"><div style="font-size:32px; font-weight:bold; color:#7c3aed;">${stats.totalInvoices || 0}</div><div style="color:#666;">Total Invoices</div></td>
            <td style="width:15px;"></td>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center; width:50%;"><div style="font-size:32px; font-weight:bold; color:#10b981;">${currency} ${(stats.totalRevenue || 0).toFixed(2)}</div><div style="color:#666;">Total Revenue</div></td>
          </tr>
          <tr><td colspan="3" style="height:15px;"></td></tr>
          <tr>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center;"><div style="font-size:32px; font-weight:bold; color:#f59e0b;">${stats.totalPurchases || 0}</div><div style="color:#666;">Purchase Orders</div></td>
            <td style="width:15px;"></td>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center;"><div style="font-size:32px; font-weight:bold; color:#ef4444;">${stats.lowStockCount || 0}</div><div style="color:#666;">Low Stock Items</div></td>
          </tr>
        </table>
        <div style="text-align:center; margin-top:30px;">
          <a href="${process.env.FRONTEND_URL}/reports" style="background:#10b981; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Full Report</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Weekly Report</p>
      </div>
    </div>`;

  return sendEmail(emails.join(','), subject, html);
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  sendEmail,
  // Invoice
  sendInvoiceEmail,
  // Payment reminders
  sendPaymentReminderEmail,
  // Low stock alerts
  sendLowStockAlertEmail,
  sendBulkLowStockAlert,
  // Welcome / Auth
  sendWelcomeEmail,
  sendPasswordResetEmail,
  // Backup
  sendBackupConfirmation,
  // Summary reports
  sendDailySummaryEmail,
  sendWeeklySummaryEmail,
  // Company notifications
  sendApprovalEmail,
  sendRejectionEmail
};
