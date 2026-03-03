const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Company = require('../models/Company');

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from token
      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user) {
        return res.status(401).json({ 
          success: false, 
          message: 'User not found' 
        });
      }

      if (!req.user.isActive) {
        return res.status(401).json({ 
          success: false, 
          message: 'User account is inactive' 
        });
      }

      // Check if user is platform admin
      if (req.user.role === 'platform_admin') {
        req.isPlatformAdmin = true;
        req.company = null;
        return next();
      }

      // Get company information and attach to request
      req.company = await Company.findById(req.user.company);

      if (!req.company) {
        return res.status(401).json({ 
          success: false, 
          message: 'Company not found or inactive' 
        });
      }

      if (!req.company.isActive) {
        return res.status(401).json({ 
          success: false, 
          message: 'Company account is inactive' 
        });
      }

      // Check if company is approved
      if (req.company.approvalStatus !== 'approved') {
        return res.status(401).json({ 
          success: false, 
          message: 'Company access is pending approval. Please wait for platform administrator to approve your registration.',
          approvalStatus: req.company.approvalStatus,
          companyName: req.company.name
        });
      }

      next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ 
        success: false, 
        message: 'Not authorized, token failed' 
      });
    }
  }

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Not authorized, no token' 
    });
  }
};

// Role authorization
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role '${req.user.role}' is not authorized to access this route`
      });
    }
    next();
  };
};

module.exports = { protect, authorize };
