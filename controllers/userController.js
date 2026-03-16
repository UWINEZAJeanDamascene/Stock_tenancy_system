const User = require('../models/User');
const ActionLog = require('../models/ActionLog');
const { notifyUserCreated, notifyPasswordChanged } = require('../services/notificationHelper');

// Generate a random temporary password
const generateTempPassword = (length = 8) => {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
};

// @desc    Get all users
// @route   GET /api/users
// @access  Private (admin)
exports.getUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, role, isActive } = req.query;
    
    // Multi-tenancy: Filter by company
    const companyId = req.user.company._id;
    const query = { company: companyId };

    if (role) {
      query.role = role;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: users.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: users
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private (admin)
exports.getUser = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const user = await User.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new user (Admin only with temp password)
// @route   POST /api/users
// @access  Private (admin)
exports.createUser = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { name, email, role, generateTemp } = req.body;

    // Check if user already exists in this company
    const existingUser = await User.findOne({ email: email.toLowerCase(), company: companyId });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists in your company'
      });
    }

    // Generate temporary password or use provided one
    const tempPassword = generateTemp ? generateTempPassword() : req.body.password || generateTempPassword();
    const mustChangePassword = generateTemp || !req.body.password;

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password: tempPassword,
      company: companyId,
      role: role || 'viewer',
      createdBy: req.user.id,
      mustChangePassword,
      tempPassword: mustChangePassword
    });

    res.status(201).json({
      success: true,
      data: user,
      tempPassword // Only returned once during creation
    });

    // Notify new user created
    try {
      await notifyUserCreated(companyId, user, req.user);
    } catch (e) {
      console.error('notifyUserCreated failed', e);
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (admin)
exports.updateUser = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Don't allow password update through this route
    delete req.body.password;
    // Don't allow changing company
    delete req.body.company;

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      {
        new: true,
        runValidators: true
      }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (admin)
exports.deleteUser = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const user = await User.findOne({ _id: req.params.id, company: companyId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent deleting yourself
    if (user._id.toString() === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reset user password (Admin only)
// @route   POST /api/users/:id/reset-password
// @access  Private (admin)
exports.resetPassword = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const user = await User.findOne({ _id: req.params.id, company: companyId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const { newPassword, temporary } = req.body;
    let tempPassword;
    
    if (newPassword) {
      // Set permanent password
      user.password = newPassword;
      user.mustChangePassword = false;
      user.tempPassword = false;
      user.passwordChangedAt = new Date();
      await user.save();
      
      res.json({
        success: true,
        message: 'Password updated successfully'
      });
      try {
        await notifyPasswordChanged(companyId, user._id);
      } catch (e) {
        console.error('notifyPasswordChanged failed', e);
      }
    } else {
      // Generate temporary password (requires user to change on next login)
      tempPassword = generateTempPassword();
      user.password = tempPassword;
      user.mustChangePassword = true;
      user.tempPassword = true;
      user.passwordChangedAt = null;
      await user.save();

      res.json({
        success: true,
        message: 'Password reset successfully',
        tempPassword
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle user active status (Admin only)
// @route   PUT /api/users/:id/toggle-status
// @access  Private (admin)
exports.toggleUserStatus = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const user = await User.findOne({ _id: req.params.id, company: companyId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent deactivating yourself
    if (user._id.toString() === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot deactivate your own account'
      });
    }

    user.isActive = !user.isActive;
    await user.save();

    res.json({
      success: true,
      data: user,
      message: user.isActive ? 'User activated successfully' : 'User deactivated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user action logs
// @route   GET /api/users/:id/action-logs
// @access  Private (admin)
exports.getUserActionLogs = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 50, module } = req.query;
    
    // First verify user belongs to company
    const user = await User.findOne({ _id: req.params.id, company: companyId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const query = { user: req.params.id, company: companyId };

    if (module) {
      query.module = module;
    }

    const total = await ActionLog.countDocuments(query);
    const logs = await ActionLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: logs.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: logs
    });
  } catch (error) {
    next(error);
  }
};
