const Department = require('../models/Department');
const User = require('../models/User');

// @desc    Get all departments
// @route   GET /api/departments
// @access  Private
exports.getDepartments = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { search } = req.query;
    const query = { company: companyId };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const departments = await Department.find(query).sort({ name: 1 });

    // Get user counts per department
    const userCounts = await User.aggregate([
      { $match: { company: companyId, department: { $ne: null } } },
      { $group: { _id: '$department', count: { $sum: 1 } } }
    ]);

    const countMap = {};
    userCounts.forEach(uc => { countMap[uc._id.toString()] = uc.count; });

    const data = departments.map(d => ({
      ...d.toObject(),
      userCount: countMap[d._id.toString()] || 0
    }));

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single department
// @route   GET /api/departments/:id
// @access  Private
exports.getDepartment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const department = await Department.findOne({ _id: req.params.id, company: companyId });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    // Get users in this department
    const users = await User.find({ company: companyId, department: department._id })
      .select('name email role isActive')
      .sort({ name: 1 });

    res.json({ success: true, data: { ...department.toObject(), users } });
  } catch (error) {
    next(error);
  }
};

// @desc    Create department
// @route   POST /api/departments
// @access  Private (admin)
exports.createDepartment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Department name is required' });
    }

    // Check for duplicate name
    const existing = await Department.findOne({ company: companyId, name: { $regex: `^${name.trim()}$`, $options: 'i' } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A department with this name already exists' });
    }

    const department = await Department.create({
      name: name.trim(),
      description: description?.trim() || '',
      company: companyId
    });

    res.status(201).json({ success: true, data: { ...department.toObject(), userCount: 0 } });
  } catch (error) {
    next(error);
  }
};

// @desc    Update department
// @route   PUT /api/departments/:id
// @access  Private (admin)
exports.updateDepartment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { name, description } = req.body;

    const department = await Department.findOne({ _id: req.params.id, company: companyId });
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    if (name && name.trim()) {
      // Check for duplicate name (excluding current)
      const existing = await Department.findOne({
        company: companyId,
        name: { $regex: `^${name.trim()}$`, $options: 'i' },
        _id: { $ne: department._id }
      });
      if (existing) {
        return res.status(400).json({ success: false, message: 'A department with this name already exists' });
      }
      department.name = name.trim();
    }

    if (description !== undefined) {
      department.description = description?.trim() || '';
    }

    await department.save();

    const userCount = await User.countDocuments({ company: companyId, department: department._id });

    res.json({ success: true, data: { ...department.toObject(), userCount } });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete department
// @route   DELETE /api/departments/:id
// @access  Private (admin)
exports.deleteDepartment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const department = await Department.findOne({ _id: req.params.id, company: companyId });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    // Remove department reference from all users in this department
    await User.updateMany(
      { company: companyId, department: department._id },
      { $unset: { department: '' } }
    );

    await department.deleteOne();

    res.json({ success: true, message: 'Department deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// @desc    Assign users to department
// @route   PUT /api/departments/:id/assign-users
// @access  Private (admin)
exports.assignUsers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { userIds } = req.body;

    const department = await Department.findOne({ _id: req.params.id, company: companyId });
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please provide user IDs' });
    }

    await User.updateMany(
      { _id: { $in: userIds }, company: companyId },
      { department: department._id }
    );

    const userCount = await User.countDocuments({ company: companyId, department: department._id });

    res.json({ success: true, message: `${userIds.length} user(s) assigned to ${department.name}`, data: { ...department.toObject(), userCount } });
  } catch (error) {
    next(error);
  }
};

// @desc    Remove user from department
// @route   PUT /api/departments/:id/remove-user/:userId
// @access  Private (admin)
exports.removeUser = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const department = await Department.findOne({ _id: req.params.id, company: companyId });

    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    await User.updateOne(
      { _id: req.params.userId, company: companyId, department: department._id },
      { $unset: { department: '' } }
    );

    res.json({ success: true, message: 'User removed from department' });
  } catch (error) {
    next(error);
  }
};
