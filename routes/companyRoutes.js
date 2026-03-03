const express = require('express');
const router = express.Router();
const {
  registerCompany,
  getCompany,
  updateCompany,
  getPendingCompanies,
  getAllCompanies,
  approveCompany,
  rejectCompany
} = require('../controllers/companyController');
const { protect, authorize } = require('../middleware/auth');

// Public route - Company registration
router.post('/register', registerCompany);

// Platform admin routes
router.get('/pending', protect, authorize('platform_admin'), getPendingCompanies);
router.get('/all', protect, authorize('platform_admin'), getAllCompanies);
router.put('/:id/approve', protect, authorize('platform_admin'), approveCompany);
router.put('/:id/reject', protect, authorize('platform_admin'), rejectCompany);

// Protected routes
router.get('/me', protect, getCompany);
router.put('/', protect, authorize('admin'), updateCompany);

module.exports = router;
