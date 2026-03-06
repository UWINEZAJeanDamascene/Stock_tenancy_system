const IPWhitelist = require('../models/IPWhitelist');

// Middleware to enforce IP whitelist per company or global entries
module.exports = async function ipWhitelist(req, res, next) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '').split(',')[0].trim();

    // If no user yet (e.g., public endpoints), skip check
    if (!req.user) return next();

      // Allow access to whitelist management endpoints so admins can manage entries
      if (req.path && req.path.startsWith('/ip-whitelist')) return next();

    // Platform admins bypass IP checks
    if (req.user.role === 'platform_admin') return next();

    // Check if there are any IP whitelist entries configured
    // If no entries exist, allow access (whitelist is optional)
    const companyId = req.user.company;
    let hasWhitelistEntries = false;
    
    if (companyId) {
      hasWhitelistEntries = await IPWhitelist.countDocuments({ company: companyId, enabled: true }) > 0;
    }
    const globalEntries = await IPWhitelist.countDocuments({ company: null, enabled: true }) > 0;
    
    if (!hasWhitelistEntries && !globalEntries) {
      // No whitelist configured, allow access
      return next();
    }

    // Check user-level whitelist first
    if (Array.isArray(req.user.ipWhitelist) && req.user.ipWhitelist.length) {
      if (req.user.ipWhitelist.includes(ip)) return next();
    }

    // Then company-level whitelist
    if (companyId) {
      const entry = await IPWhitelist.findOne({ company: companyId, ip, enabled: true });
      if (entry) return next();
    }

    // If environment has global whitelist entries (optional), allow
    const global = await IPWhitelist.findOne({ company: null, ip, enabled: true });
    if (global) return next();

    return res.status(403).json({ success: false, message: 'Access denied from this IP address' });
  } catch (err) {
    console.error('IP whitelist check error', err);
    return res.status(500).json({ success: false, message: 'IP whitelist check failed' });
  }
};
