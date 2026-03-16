const nodemailer = require('nodemailer');
const path = require('path');

// Minimal notification service: email + SMS stub
// Usage: notify.sendEmail({ to, subject, text, html })

const createTransporter = () => {
  // Use environment variables: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
  if (!process.env.SMTP_HOST) {
    console.warn('SMTP_HOST not configured - email sending will be disabled');
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
};

const transporter = createTransporter();

async function sendEmail({ to, subject, text, html, from }) {
  if (!transporter) {
    console.log('Email not sent (transporter missing).', subject, to);
    return;
  }
  const mailOptions = {
    from: from || process.env.EMAIL_FROM || 'no-reply@example.com',
    to,
    subject,
    text,
    html
  };
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId, 'to', to);
    return info;
  } catch (err) {
    console.error('Failed to send email', err);
    throw err;
  }
}

// SMS stub - implement with Twilio or other provider
async function sendSMS({ to, body }) {
  if (!process.env.SMS_PROVIDER) {
    console.log('SMS provider not configured - SMS not sent to', to);
    return;
  }
  // Example: if provider === 'twilio' you'd call Twilio SDK here
  console.log('SMS sent (stub):', to, body);
}

// Small helper to build invoice email content
function invoiceEmailTemplate(invoice, company) {
  const subject = `Invoice ${invoice.number} from ${company ? company.name : ''}`;
  const text = `Hello,\n\nPlease find your invoice ${invoice.number} for ${invoice.total}.\n\nThank you.`;
  const html = `<p>Hello,</p><p>Please find your invoice <strong>${invoice.number}</strong> for <strong>${invoice.total}</strong>.</p><p>Thank you.</p>`;
  return { subject, text, html };
}

module.exports = {
  sendEmail,
  sendSMS,
  invoiceEmailTemplate
};
