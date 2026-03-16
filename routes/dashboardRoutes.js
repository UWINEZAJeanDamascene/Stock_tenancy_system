const express = require('express');
const router = express.Router();
const {
  getDashboardStats,
  getRecentActivities,
  getLowStockAlerts,
  getTopSellingProducts,
  getTopClients,
  getSalesChart,
  getStockMovementChart
} = require('../controllers/dashboardController');
const { protect } = require('../middleware/auth');
const { cacheMiddleware, sessionMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);
router.use(sessionMiddleware);

router.get('/stats', cacheMiddleware({ type: 'dashboard', ttl: 60 }), getDashboardStats);
router.get('/recent-activities', cacheMiddleware({ type: 'dashboard', ttl: 60 }), getRecentActivities);
router.get('/low-stock-alerts', cacheMiddleware({ type: 'stock', ttl: 60 }), getLowStockAlerts);
router.get('/top-selling-products', cacheMiddleware({ type: 'dashboard', ttl: 60 }), getTopSellingProducts);
router.get('/top-clients', cacheMiddleware({ type: 'dashboard', ttl: 60 }), getTopClients);
router.get('/sales-chart', cacheMiddleware({ type: 'dashboard', ttl: 60 }), getSalesChart);
router.get('/stock-movement-chart', cacheMiddleware({ type: 'dashboard', ttl: 60 }), getStockMovementChart);

module.exports = router;
