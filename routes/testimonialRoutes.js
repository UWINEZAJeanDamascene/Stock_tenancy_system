const express = require('express');
const router = express.Router();
const {
  getTestimonials,
  getTestimonial,
  createTestimonial,
  updateTestimonial,
  deleteTestimonial,
  toggleTestimonial,
  reorderTestimonials
} = require('../controllers/testimonialController');

// Public routes (for landing page)
router.get('/', getTestimonials);
router.get('/:id', getTestimonial);

// Protected routes (admin only - would need auth middleware for full protection)
router.post('/', createTestimonial);
router.put('/:id', updateTestimonial);
router.delete('/:id', deleteTestimonial);
router.patch('/:id/toggle', toggleTestimonial);
router.post('/reorder', reorderTestimonials);

module.exports = router;
