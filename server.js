const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/database');
const errorHandler = require('./middleware/errorHandler');

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

// Load all models to ensure they're registered with mongoose
require('./models/IPWhitelist');
require('./models/Role');

const app = express();

// Security middleware
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

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

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Stock Management System API is running',
    timestamp: new Date().toISOString()
  });
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

module.exports = app;
