const nodemailer = require('nodemailer');

// ============================================
// ENVIRONMENT VALIDATION
// ============================================

const validateConfig = () => {
  const provider = (process.env.EMAIL_PROVIDER || 'gmail').toLowerCase();
  const missing = [];

  if (provider === 'gmail') {
    if (!process.env.GMAIL_USER) missing.push('GMAIL_USER');
    if (!process.env.GMAIL_APP_PASSWORD) missing.push('GMAIL_APP_PASSWORD');
  } else if (provider === 'resend') {
    if (!process.env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  } else {
    if (!process.env.SMTP_HOST) missing.push('SMTP_HOST');
    if (!process.env.SMTP_USER) missing.push('SMTP_USER');
    if (!process.env.SMTP_PASS) missing.push('SMTP_PASS');
  }

  if (!process.env.EMAIL_FROM_ADDRESS && !process.env.GMAIL_USER) {
    missing.push('EMAIL_FROM_ADDRESS');
  }

  if (missing.length > 0) {
    console.warn(`⚠️  Email config: missing env vars: ${missing.join(', ')}`);
  }

  return { provider, valid: missing.length === 0, missing };
};

// ============================================
// TRANSPORTER FACTORY
// ============================================

const createTransporter = () => {
  const { provider } = validateConfig();

  const poolDefaults = {
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 10, // max 10 messages/sec (Gmail limit ≈ 20/sec)
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    logger: process.env.NODE_ENV === 'development',
    debug: process.env.NODE_ENV === 'development'
  };

  if (provider === 'gmail') {
    return nodemailer.createTransport({
      ...poolDefaults,
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });
  }

  if (provider === 'resend') {
    return nodemailer.createTransport({
      ...poolDefaults,
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: {
        user: 'resend',
        pass: process.env.RESEND_API_KEY
      }
    });
  }

  // Fallback: generic SMTP
  const port = parseInt(process.env.SMTP_PORT, 10) || 587;
  return nodemailer.createTransport({
    ...poolDefaults,
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
};

let transporter = null;

/**
 * Lazily get or create the transporter singleton.
 * Avoids crashes if env vars are loaded late (e.g. dotenv in server.js).
 */
const getTransporter = () => {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
};

/**
 * Verify SMTP connection. Safe to call at server startup.
 * Returns true/false — never throws.
 */
const testConnection = async () => {
  try {
    const t = getTransporter();
    await t.verify();
    console.log(`✅ Email server connected (provider: ${process.env.EMAIL_PROVIDER || 'gmail'})`);
    return true;
  } catch (error) {
    console.error(`❌ Email server error [${process.env.EMAIL_PROVIDER || 'gmail'}]:`, error.message);
    return false;
  }
};

module.exports = { getTransporter, testConnection, validateConfig };
