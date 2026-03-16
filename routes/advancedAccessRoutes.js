const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const ipWhitelist = require('../middleware/ipWhitelist');
const { createRole, getRoles, updateRole, deleteRole } = require('../controllers/roleController');
const { setup2FA, verify2FA, disable2FA } = require('../controllers/securityController');
const IPWhitelist = require('../models/IPWhitelist');

// All routes require authentication
router.use(protect);

// 2FA endpoints available to authenticated users - place BEFORE IP whitelist so users can set up 2FA
router.post('/2fa/setup', setup2FA);
router.post('/2fa/verify', verify2FA);
router.post('/2fa/disable', disable2FA);

// IP whitelist should be enforced for admin-only routes
router.use(ipWhitelist);

// Role management - admin/platform_admin only
router.get('/roles', authorize('platform_admin', 'admin'), getRoles);
router.post('/roles', authorize('platform_admin', 'admin'), createRole);
router.put('/roles/:id', authorize('platform_admin', 'admin'), updateRole);
router.delete('/roles/:id', authorize('platform_admin', 'admin'), deleteRole);

// IP Whitelist management - admin/platform_admin only
router.get('/ip-whitelist', authorize('platform_admin', 'admin'), async (req, res) => {
  try {
    const query = {};
    if (req.company) query.company = req.company._id;
    const entries = await IPWhitelist.find(query);
    res.json({ success: true, data: entries });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch IP whitelist' });
  }
});

router.post('/ip-whitelist', authorize('platform_admin', 'admin'), async (req, res) => {
  try {
    const { ip, description, enabled = true } = req.body;
    const company = req.company ? req.company._id : null;
    const entry = await IPWhitelist.create({ ip, description, company, enabled });
    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create IP whitelist entry' });
  }
});

router.put('/ip-whitelist/:id', authorize('platform_admin', 'admin'), async (req, res) => {
  try {
    const entry = await IPWhitelist.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!entry) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update IP whitelist entry' });
  }
});

router.delete('/ip-whitelist/:id', authorize('platform_admin', 'admin'), async (req, res) => {
  try {
    const entry = await IPWhitelist.findByIdAndDelete(req.params.id);
    if (!entry) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true, message: 'Entry deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete IP whitelist entry' });
  }
});

module.exports = router;
