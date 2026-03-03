const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Company = require('../models/Company');

// Generate JWT Token with company and role info
const generateToken = (id, companyId, role) => {
  return jwt.sign(
    { id, companyId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Validate email & password
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide email and password' 
      });
    }

    // Check for user
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password').populate('company', 'name email isActive approvalStatus');

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account is inactive. Please contact administrator.' 
      });
    }

    // Check if user is platform admin - they don't have a company
    if (user.role === 'platform_admin') {
      // Generate token without companyId for platform admin
      const token = generateToken(user._id, null, user.role);
      
      const userWithoutPassword = user.toJSON();
      
      return res.json({
        success: true,
        data: userWithoutPassword,
        token,
        requirePasswordChange: user.mustChangePassword || false,
        isPlatformAdmin: true
      });
    }

    // Check if company is active
    if (!user.company || !user.company.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Company account is inactive. Please contact support.' 
      });
    }

    // Check if company is approved
    if (user.company.approvalStatus !== 'approved') {
      return res.status(401).json({ 
        success: false, 
        message: 'Company is pending approval. Please wait for platform administrator to approve your registration.',
        approvalStatus: user.company.approvalStatus
      });
    }

    // Check if password matches
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Check if account requires password change (first login with temp password)
    const requirePasswordChange = user.mustChangePassword;

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate token with companyId
    const token = generateToken(user._id, user.company._id, user.role);

    // Remove password from user object
    const userWithoutPassword = user.toJSON();

    res.json({
      success: true,
      data: userWithoutPassword,
      company: user.company,
      token,
      requirePasswordChange
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).populate('company', 'name email');

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update password
// @route   PUT /api/auth/update-password
// @access  Private
exports.updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide current and new password' 
      });
    }

    const user = await User.findById(req.user.id).select('+password');

    // Check current password
    const isMatch = await user.comparePassword(currentPassword);

    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Current password is incorrect' 
      });
    }

    user.password = newPassword;
    user.passwordChangedAt = new Date();
    user.mustChangePassword = false;
    user.tempPassword = false;
    await user.save();

    const token = generateToken(user._id, req.user.company._id, user.role);

    res.json({
      success: true,
      message: 'Password updated successfully',
      token
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
exports.logout = async (req, res, next) => {
  try {
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    next(error);
  }
};
