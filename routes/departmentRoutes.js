const express = require('express');
const router = express.Router();
const {
  getDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  assignUsers,
  removeUser
} = require('../controllers/departmentController');
const { protect, authorize } = require('../middleware/auth');
const logAction = require('../middleware/logAction');

router.use(protect);

router.route('/')
  .get(getDepartments)
  .post(authorize('admin'), logAction('department'), createDepartment);

router.route('/:id')
  .get(getDepartment)
  .put(authorize('admin'), logAction('department'), updateDepartment)
  .delete(authorize('admin'), logAction('department'), deleteDepartment);

router.put('/:id/assign-users', authorize('admin'), logAction('department'), assignUsers);
router.put('/:id/remove-user/:userId', authorize('admin'), logAction('department'), removeUser);

module.exports = router;
