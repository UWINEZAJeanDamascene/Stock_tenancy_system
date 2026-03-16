const express = require('express');
const router = express.Router();
const {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory
} = require('../controllers/categoryController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware, sessionMiddleware } = require('../middleware/cacheMiddleware');

router.use(protect);
router.use(sessionMiddleware);

router.route('/')
  .get(cacheMiddleware({ type: 'category', ttl: 600 }), getCategories)
  .post(authorize('admin'), logAction('category'), cacheInvalidationMiddleware({ type: 'category', invalidateAll: true }), createCategory);

router.route('/:id')
  .get(cacheMiddleware({ type: 'category', ttl: 600 }), getCategory)
  .put(authorize('admin'), logAction('category'), cacheInvalidationMiddleware({ type: 'category', invalidateAll: true }), updateCategory)
  .delete(authorize('admin'), logAction('category'), cacheInvalidationMiddleware({ type: 'category', invalidateAll: true }), deleteCategory);

module.exports = router;
