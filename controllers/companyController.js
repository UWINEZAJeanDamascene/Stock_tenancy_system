const jwt = require('jsonwebtoken');
const Company = require('../models/Company');
const User = require('../models/User');
const { sendApprovalEmail, sendRejectionEmail } = require('../services/emailService');
const JournalService = require('../services/journalService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');

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
    const { name, tin, email, phone, address, settings, equity, liabilities } = req.body;

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
    if (equity) company.equity = { ...company.equity, ...equity };
    
    // Update liabilities (current and non-current)
    if (liabilities) {
      if (liabilities.currentLiabilities) {
        company.liabilities.currentLiabilities = liabilities.currentLiabilities;
      }
      if (liabilities.nonCurrentLiabilities) {
        company.liabilities.nonCurrentLiabilities = liabilities.nonCurrentLiabilities;
      }
      if (liabilities.accruedExpenses !== undefined) {
        company.liabilities.accruedExpenses = liabilities.accruedExpenses;
      }
      if (liabilities.otherLongTermLiabilities !== undefined) {
        company.liabilities.otherLongTermLiabilities = liabilities.otherLongTermLiabilities;
      }
    }

    // Also update assets (like prepaid expenses)
    if (req.body.assets) {
      if (req.body.assets.prepaidExpenses !== undefined) {
        company.assets.prepaidExpenses = req.body.assets.prepaidExpenses;
      }
    }

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

    // Create a system notification for company approval
    try {
      const { notifyCompanyApproved } = require('../services/notificationHelper');
      await notifyCompanyApproved(company._id, company);
    } catch (e) {
      console.error('notifyCompanyApproved failed', e);
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

// @desc    Record owner's capital investment
// @route   POST /api/companies/capital/owner
// @access  Private (Admin)
exports.recordOwnerCapital = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, date, description, paymentMethod, reference } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid amount'
      });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Update owner's capital in company equity
    company.equity.ownerCapital = (company.equity.ownerCapital || 0) + amount;
    await company.save();

    // Determine cash account based on payment method
    let cashAccount;
    if (paymentMethod === 'bank_transfer') {
      cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
    } else if (paymentMethod === 'mobile_money') {
      cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
    } else {
      cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    }

    // Create journal entry: Debit Cash/Bank, Credit Owner's Capital
    const entryDate = date ? new Date(date) : new Date();
    try {
      await JournalService.createEntry(companyId, req.user._id, {
        date: entryDate,
        description: description || `Owner's Capital Investment - ${amount}`,
        sourceType: 'capital_investment',
        sourceReference: reference || null,
        lines: [
          JournalService.createDebitLine(
            cashAccount,
            amount,
            'Capital investment received'
          ),
          JournalService.createCreditLine(
            DEFAULT_ACCOUNTS.ownerCapital,
            amount,
            "Owner's Capital Investment"
          )
        ],
        isAutoGenerated: true
      });
    } catch (journalError) {
      console.error('Error creating journal entry for owner capital:', journalError);
      // Continue even if journal entry fails
    }

    res.json({
      success: true,
      message: "Owner's capital investment recorded successfully",
      data: {
        amount,
        totalOwnerCapital: company.equity.ownerCapital,
        date: entryDate
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record share capital investment
// @route   POST /api/companies/capital/share
// @access  Private (Admin)
exports.recordShareCapital = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, date, description, paymentMethod, reference } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid amount'
      });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Update share capital in company equity
    company.equity.shareCapital = (company.equity.shareCapital || 0) + amount;
    await company.save();

    // Determine cash account based on payment method
    let cashAccount;
    if (paymentMethod === 'bank_transfer') {
      cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
    } else if (paymentMethod === 'mobile_money') {
      cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
    } else {
      cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    }

    // Create journal entry: Debit Cash/Bank, Credit Share Capital
    const entryDate = date ? new Date(date) : new Date();
    try {
      await JournalService.createEntry(companyId, req.user._id, {
        date: entryDate,
        description: description || `Share Capital Investment - ${amount}`,
        sourceType: 'capital_investment',
        sourceReference: reference || null,
        lines: [
          JournalService.createDebitLine(
            cashAccount,
            amount,
            'Share capital received'
          ),
          JournalService.createCreditLine(
            DEFAULT_ACCOUNTS.shareCapital,
            amount,
            'Share Capital Investment'
          )
        ],
        isAutoGenerated: true
      });
    } catch (journalError) {
      console.error('Error creating journal entry for share capital:', journalError);
      // Continue even if journal entry fails
    }

    res.json({
      success: true,
      message: 'Share capital investment recorded successfully',
      data: {
        amount,
        totalShareCapital: company.equity.shareCapital,
        date: entryDate
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get capital balance (for validation)
// @route   GET /api/companies/capital/balance
// @access  Private
exports.getCapitalBalance = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const company = await Company.findById(companyId);

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    const ownerCapital = company.equity?.ownerCapital || 0;
    const shareCapital = company.equity?.shareCapital || 0;
    const totalCapital = ownerCapital + shareCapital;

    res.json({
      success: true,
      data: {
        ownerCapital,
        shareCapital,
        totalCapital
      }
    });
  } catch (error) {
    next(error);
  }
};
