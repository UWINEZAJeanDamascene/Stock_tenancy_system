const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/database');
const errorHandler = require('./middleware/errorHandler');

// Redis caching layer
const { redisClient } = require('./config/redis');
const { createRateLimiters } = require('./middleware/redisRateLimiter');
const { sessionMiddleware } = require('./middleware/cacheMiddleware');

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

// Load all models to ensure they're registered with mongoose
require('./models/IPWhitelist');
require('./models/Role');
require('./models/Backup');
require('./models/FixedAsset');
require('./models/Loan');
require('./models/PrecomputedAggregation');
require('./models/Expense');
require('./models/PurchaseReturn');
require('./models/Testimonial');
require('./models/DeliveryNote');
require('./models/PettyCash');
require('./models/BankAccount');

const app = express();

// Security middleware
app.use(helmet());

// Rate limiting with Redis (distributed)
const rateLimiters = createRateLimiters();
app.use('/api/auth', rateLimiters.auth);
app.use('/api/', rateLimiters.api);

// CORS - Allow Vercel frontend and localhost for development
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow localhost for development
    if (origin.includes('localhost')) {
      return callback(null, true);
    }
    
    // Allow all Vercel deployments (most common frontend hosting platform)
    if (origin.includes('vercel.app')) {
      return callback(null, true);
    }
    
    // Allow all Render deployments (for self-hosted backends)
    if (origin.includes('render.com')) {
      return callback(null, true);
    }
    
    // Allow specific domains
    const allowedOrigins = [
      'https://stock-management-frontend.vercel.app',
      'https://your-frontend.vercel.app',
      'https://stock-frontend-topaz-alpha.vercel.app',
      'https://stock-management-v3rl.onrender.com',
      'https://stock-tenancy-bnd.vercel.app',
      'https://stock-tenancy-system.onrender.com'
    ];
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // For development, allow all (remove in production)
    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
};
app.use(cors(corsOptions));

// Body parser - increased limit for CSV imports
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session management with Redis
app.use(sessionMiddleware);

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/companies', require('./routes/companyRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/suppliers', require('./routes/supplierRoutes'));
app.use('/api/clients', require('./routes/clientRoutes'));
app.use('/api/stock', require('./routes/stockRoutes'));
app.use('/api/stock/advanced', require('./routes/advancedStockRoutes'));
app.use('/api/quotations', require('./routes/quotationRoutes'));
app.use('/api/invoices', require('./routes/invoiceRoutes'));
app.use('/api/purchases', require('./routes/purchaseRoutes'));
app.use('/api/pos', require('./routes/posRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/exchange-rates', require('./routes/exchangeRateRoutes'));
// Advanced access control & security routes
app.use('/api/access', require('./routes/advancedAccessRoutes'));
// Recurring invoices & subscriptions
app.use('/api/recurring-invoices', require('./routes/recurringInvoiceRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptionRoutes'));
// Credit notes
app.use('/api/credit-notes', require('./routes/creditNoteRoutes'));

// Notification settings
app.use('/api/notifications', require('./routes/notificationRoutes'));

// Backup & Restore
app.use('/api/backups', require('./routes/backupRoutes'));

// Fixed Assets
app.use('/api/fixed-assets', require('./routes/fixedAssetRoutes'));

// Loans
app.use('/api/loans', require('./routes/loanRoutes'));

// Budget Management
app.use('/api/budgets', require('./routes/budgetRoutes'));

// Tax Management
app.use('/api/taxes', require('./routes/taxRoutes'));

// Payroll Management
app.use('/api/payroll', require('./routes/payrollRoutes'));

// Expenses
app.use('/api/expenses', require('./routes/expenseRoutes'));

// Petty Cash
app.use('/api/petty-cash', require('./routes/pettyCashRoutes'));

// Bank Accounts & Cash Management
app.use('/api/bank-accounts', require('./routes/bankAccountRoutes'));

// Purchase Returns
app.use('/api/purchase-returns', require('./routes/purchaseReturnRoutes'));

// Accounts Payable Management
app.use('/api/payables', require('./routes/payableRoutes'));

// Accounts Receivable Management
app.use('/api/receivables', require('./routes/receivableRoutes'));

// Delivery Notes
app.use('/api/delivery-notes', require('./routes/deliveryNoteRoutes'));

// Departments
app.use('/api/departments', require('./routes/departmentRoutes'));

// Bulk Data Import/Export
app.use('/api/bulk', require('./routes/bulkDataRoutes'));

// Audit Trail
app.use('/api/audit-trail', require('./routes/auditTrailRoutes'));

// AI Chatbot (Gemini)
app.use('/api/chat', require('./routes/chatRoutes'));

// Journal Entries & Accounting
app.use('/api/journal-entries', require('./routes/journalRoutes'));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Stock Management System API is running',
    timestamp: new Date().toISOString()
  });
});

// Admin: Reset rate limit for IP (for testing)
app.post('/admin/reset-rate-limit', async (req, res) => {
  try {
    const { resetRateLimit } = require('./middleware/redisRateLimiter');
    const ip = req.body.ip || req.ip;
    const result = await resetRateLimit(ip, 'ratelimit:auth');
    res.json({ success: result, message: `Rate limit reset for IP: ${ip}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Root route
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    message: 'Stock Management System API',
    endpoints: [
      '/api/auth',
      '/api/companies',
      '/api/users',
      '/api/products',
      '/api/categories',
      '/api/suppliers',
      '/api/clients',
      '/api/stock',
      '/api/quotations',
      '/api/invoices',
      '/api/reports',
      '/api/dashboard',
      '/api/exchange-rates',
      '/health'
    ]
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Route not found' 
  });
});

// Error handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// Start recurring scheduler (non-blocking)
try {
  const { startScheduler } = require('./services/recurringService');
  startScheduler();
} catch (err) {
  console.warn('Could not start recurring invoice scheduler', err);
}

// Start notification scheduler (payment reminders, low-stock, summaries)
try {
  const notify = require('./services/notificationScheduler');
  notify.startScheduler();
} catch (err) {
  console.warn('Could not start recurring invoice scheduler', err);
}

// Start backup scheduler (automated backups, verification)
try {
  const backupScheduler = require('./services/backupScheduler');
  backupScheduler.startBackupScheduler();
  backupScheduler.startVerificationScheduler();
} catch (err) {
  console.warn('Could not start backup scheduler', err);
}

// Start depreciation scheduler (monthly depreciation entries)
try {
  const depreciationScheduler = require('./services/depreciationScheduler');
  depreciationScheduler.startDepreciationScheduler();
} catch (err) {
  console.warn('Could not start depreciation scheduler', err);
}

// Start report scheduler (snapshot generation for weekly/monthly/quarterly/etc.)
try {
  const reportScheduler = require('./services/reportSchedulerService');
  if (reportScheduler && typeof reportScheduler.initializeScheduler === 'function') {
    reportScheduler.initializeScheduler(app);
    console.log('Report scheduler initialized');
  }
} catch (err) {
  console.warn('Could not initialize report scheduler', err && err.message ? err.message : err);
}

// Initialize Background Job Queue (BullMQ)
// Runs nightly aggregations, report generation, email notifications
try {
  const { initializeWorkers } = require('./services/jobWorkers');
  const { setupScheduledJobs } = require('./services/jobQueue');
  
  // Initialize workers to process background jobs
  initializeWorkers();
  
  // Setup scheduled jobs (nightly aggregations)
  setupScheduledJobs();
  
  console.log('Background job system initialized');
} catch (err) {
  console.warn('Could not initialize job queue:', err.message || err);
}

// Verify email server connection (non-blocking)
try {
  const { testConnection } = require('./config/email');
  testConnection();
} catch (err) {
  console.warn('Could not verify email server:', err.message || err);
}

const server = app.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    // Try next port once
    const fallbackPort = Number(PORT) + 1;
    console.log(`Attempting to listen on port ${fallbackPort} instead...`);
    server.close();
    app.listen(fallbackPort, () => {
      console.log(`Server running in ${process.env.NODE_ENV} mode on port ${fallbackPort}`);
    }).on('error', (e) => {
      console.error('Failed to bind to fallback port:', e.message);
      process.exit(1);
    });
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

// Initialize Socket.io for real-time notifications
try {
  const socketService = require('./services/socketService');
  socketService.init(server);
} catch (err) {
  console.warn('Could not initialize socket service', err.message || err);
}

module.exports = app;
