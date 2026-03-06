const Role = require('../models/Role');

// Basic access control middleware factory
// Usage: checkPermission('product', 'update') or checkPermission('invoice', 'read')
const checkPermission = (resource, action, field = null) => {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });

      // Platform admins bypass permission checks
      if (req.user.role === 'platform_admin') return next();

      // Build permission strings to check. If field provided, allow 'resource.action.field' and 'resource.action'
      const permsToCheck = [];
      if (field) permsToCheck.push(`${resource}.${action}.${field}`);
      permsToCheck.push(`${resource}.${action}`);

      // Resolve roles (legacy single role may still be used)
      let roleIds = [];
      if (Array.isArray(req.user.roles) && req.user.roles.length) roleIds = req.user.roles;

      // If no role refs, attempt to find by legacy role string
      if (!roleIds.length && req.user.role) {
        // Try to resolve Role document with that name in same company
        const roleDoc = await Role.findOne({ name: req.user.role, company: req.user.company });
        if (roleDoc) roleIds = [roleDoc._id];
      }

      if (!roleIds.length) {
        return res.status(403).json({ success: false, message: 'No role assigned' });
      }

      const roles = await Role.find({ _id: { $in: roleIds } });

      for (const r of roles) {
        for (const p of r.permissions || []) {
          if (permsToCheck.includes(p)) return next();
        }
      }

      return res.status(403).json({ success: false, message: 'Forbidden: insufficient permissions' });
    } catch (err) {
      console.error('Access control error', err);
      return res.status(500).json({ success: false, message: 'Access control check failed' });
    }
  };
};

module.exports = { checkPermission };
