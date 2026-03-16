const Role = require('../models/Role');

exports.createRole = async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: 'Role name is required' });
    const company = req.company ? req.company._id : null;
    const role = new Role({ name: String(name).trim(), description, permissions: Array.isArray(permissions) ? permissions : [], company });
    await role.save();
    res.status(201).json({ success: true, data: role });
  } catch (err) {
    console.error('Role creation error:', err);
    // Handle duplicate key error with friendlier message
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'A role with this name already exists for this company' });
    }
    res.status(500).json({ success: false, message: err.message || 'Could not create role' });
  }
};

exports.getRoles = async (req, res) => {
  try {
    const query = {};
    if (req.company) query.company = req.company._id;
    const roles = await Role.find(query);
    res.status(200).json({ success: true, data: roles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not fetch roles' });
  }
};

exports.updateRole = async (req, res) => {
  try {
    const role = await Role.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    res.status(200).json({ success: true, data: role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not update role' });
  }
};

exports.deleteRole = async (req, res) => {
  try {
    const role = await Role.findByIdAndDelete(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    res.status(200).json({ success: true, message: 'Role deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not delete role' });
  }
};
