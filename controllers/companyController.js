const jwt = require('jsonwebtoken');
const Company = require('../models/Company');
const User = require('../models/User');
const { sendApprovalEmail, sendRejectionEmail } = require('../services/emailService');

// Generate JWT Token with company and role info
const generateToken = (id, companyId, role) => {
  return jwt.sign(
    { id, companyId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );
};

// @desc    Register a new company and create admin user
// @route   POST /api/companies/register
// @access  Public
exports.registerCompany = async (req, res, next) => {
  try {
    const { company: companyData, admin: adminData } = req.body;

    // Validate required fields
    if (!companyData || !companyData.name || !companyData.email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide company name and email'
      });
    }

    if (!adminData || !adminData.email || !adminData.password || !adminData.name) {
      return res.status(400).json({
        success: false,
        message: 'Please provide admin name, email and password'
      });
    }

    // Check if company email already exists
    const companyExists = await Company.findOne({ email: companyData.email.toLowerCase() });
    if (companyExists) {
      return res.status(400).json({
        success: false,
        message: 'A company with this email already exists'
      });
    }

    // Check if admin email already exists in any company
    const userExists = await User.findOne({ email: adminData.email.toLowerCase() });
    if (userExists) {
      return res.status(400).json({
        success: false,
        message: 'A user with this email already exists'
      });
    }

    // Create company
    const company = await Company.create({
      name: companyData.name,
      tin: companyData.tin || '',
      email: companyData.email.toLowerCase(),
      phone: companyData.phone || '',
      address: companyData.address || {},
      settings: companyData.settings || {},
      subscription: {
        plan: 'free',
        status: 'active',
        startDate: new Date()
      },
      approvalStatus: 'pending'  // Company requires approval
    });

    // Create admin user for this company
    const adminUser = await User.create({
      name: adminData.name,
      email: adminData.email.toLowerCase(),
      password: adminData.password,
      company: company._id,
      role: 'admin',
      isActive: true,
      createdBy: null // First admin, no creator
    });

    // Don't return token - company needs approval first
    res.status(201).json({
      success: true,
      message: 'Company registration submitted successfully. Please wait for platform administrator approval.',
      data: {
        company: {
          _id: company._id,
          name: company.name,
          email: company.email,
          approvalStatus: company.approvalStatus
        },
        user: {
          _id: adminUser._id,
          name: adminUser.name,
          email: adminUser.email
        }
      }
    });
  } catch (error) {
    console.error('Company registration error:', error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Duplicate entry: Company or user already exists'
      });
    }
    
    next(error);
  }
};

// @desc    Get company details
// @route   GET /api/companies/me
// @access  Private
exports.getCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.user.company);

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update company details
// @route   PUT /api/companies
// @access  Private (Admin only)
exports.updateCompany = async (req, res, next) => {
  try {
    const { name, tin, email, phone, address, settings } = req.body;

    const company = await Company.findById(req.user.company);

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Update fields
    if (name) company.name = name;
    if (tin) company.tin = tin;
    if (email) company.email = email.toLowerCase();
    if (phone) company.phone = phone;
    if (address) company.address = address;
    if (settings) company.settings = { ...company.settings, ...settings };

    await company.save();

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all pending companies (for platform admin)
// @route   GET /api/companies/pending
// @access  Private (Platform Admin only)
exports.getPendingCompanies = async (req, res, next) => {
  try {
    const companies = await Company.find({ approvalStatus: 'pending' })
      .select('name email phone address tin createdAt')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: companies.length,
      data: companies
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all companies (for platform admin)
// @route   GET /api/companies/all
// @access  Private (Platform Admin only)
exports.getAllCompanies = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};

    if (status)
      query.approvalStatus = status;

    const total = await Company.countDocuments(query);
    const companies = await Company.find(query)
      .select('name email phone address tin approvalStatus isActive subscription createdAt')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: companies.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: companies
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve a company
// @route   PUT /api/companies/:id/approve
// @access  Private (Platform Admin only)
exports.approveCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    if (company.approvalStatus === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Company is already approved'
      });
    }

    company.approvalStatus = 'approved';
    company.approvedBy = req.user.id;
    company.approvedAt = new Date();
    await company.save();

    // Get admin user for this company to send email
    const adminUser = await User.findOne({ company: company._id, role: 'admin' });
    
    // Send approval email to admin user's email
    if (adminUser) {
      await sendApprovalEmail(adminUser.email, company.name, adminUser.name);
    }

    res.json({
      success: true,
      message: 'Company approved successfully',
      data: company
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject a company
// @route   PUT /api/companies/:id/reject
// @access  Private (Platform Admin only)
exports.rejectCompany = async (req, res, next) => {
  try {
    const { reason } = req.body;

    const company = await Company.findById(req.params.id);

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    if (company.approvalStatus === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Cannot reject an already approved company'
      });
    }

    company.approvalStatus = 'rejected';
    company.approvedBy = req.user.id;
    company.approvedAt = new Date();
    company.rejectionReason = reason || 'No reason provided';
    await company.save();

    // Get admin user for this company to send email
    const adminUser = await User.findOne({ company: company._id, role: 'admin' });
    
    // Send rejection email
    if (adminUser) {
      await sendRejectionEmail(company.email, company.name, adminUser.name, reason);
    }

    res.json({
      success: true,
      message: 'Company rejected',
      data: company
    });
  } catch (error) {
    next(error);
  }
};
