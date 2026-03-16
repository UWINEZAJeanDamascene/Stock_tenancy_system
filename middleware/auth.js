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
  return async (req, res, next) => {
    try {
      // Check legacy single role string first
      if (req.user && req.user.role && roles.includes(req.user.role)) return next();

      // Check roles array (may be ObjectId refs or populated docs)
      if (req.user && Array.isArray(req.user.roles) && req.user.roles.length) {
        // If populated as objects, check name property
        for (const r of req.user.roles) {
          if (typeof r === 'string' && roles.includes(r)) return next();
          if (r && typeof r === 'object' && roles.includes(r.name)) return next();
        }

        // If roles are ObjectIds, resolve their names
        const Role = require('../models/Role');
        const roleDocs = await Role.find({ _id: { $in: req.user.roles } }).select('name');
        for (const rd of roleDocs) {
          if (roles.includes(rd.name)) return next();
        }
      }

      return res.status(403).json({
        success: false,
        message: `User role '${req.user && req.user.role}' is not authorized to access this route`
      });
    } catch (err) {
      console.error('Authorization check error', err);
      return res.status(500).json({ success: false, message: 'Authorization check failed' });
    }
  };
};

module.exports = { protect, authorize };
