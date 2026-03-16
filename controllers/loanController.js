const Loan = require('../models/Loan');
const JournalService = require('../services/journalService');

// @desc    Get all loans for a company
// @route   GET /api/loans
// @access  Private
exports.getLoans = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, loanType } = req.query;
    
    const query = { company: companyId };
    if (status) query.status = status;
    if (loanType) query.loanType = loanType;

    const loans = await Loan.find(query)
      .populate('createdBy', 'name email')
      .sort({ startDate: -1 });

    // Calculate totals
    const totalOriginal = loans.reduce((sum, loan) => sum + (loan.originalAmount || 0), 0);
    const totalPaid = loans.reduce((sum, loan) => sum + (loan.amountPaid || 0), 0);
    const totalOutstanding = loans.reduce((sum, loan) => sum + (loan.remainingBalance || 0), 0);

    res.json({
      success: true,
      count: loans.length,
      data: loans,
      summary: {
        totalOriginal,
        totalPaid,
        totalOutstanding
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single loan
// @route   GET /api/loans/:id
// @access  Private
exports.getLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const loan = await Loan.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email')
      .populate('payments.recordedBy', 'name email');

    if (!loan) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }

    res.json({ success: true, data: loan });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new loan
// @route   POST /api/loans
// @access  Private
exports.createLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const loan = await Loan.create({
      ...req.body,
      company: companyId,
      createdBy: req.user._id
    });

    // Create journal entry for loan received if loan is active
    if (loan.status === 'active' && loan.originalAmount > 0) {
      try {
        await JournalService.createLoanReceivedEntry(companyId, req.user.id, {
          _id: loan._id,
          loanNumber: loan.loanNumber,
          loanType: loan.loanType,
          principalAmount: loan.originalAmount,
          disbursementDate: loan.startDate,
          paymentMethod: loan.paymentMethod || 'bank_transfer'
        });
      } catch (journalError) {
        console.error('Error creating journal entry for loan:', journalError);
        // Don't fail the loan creation if journal entry fails
      }
    }

    res.status(201).json({ success: true, data: loan });
  } catch (error) {
    next(error);
  }
};

// @desc    Update loan
// @route   PUT /api/loans/:id
// @access  Private
exports.updateLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    let loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }

    loan = await Loan.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    res.json({ success: true, data: loan });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete loan
// @route   DELETE /api/loans/:id
// @access  Private
exports.deleteLoan = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }

    await Loan.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: 'Loan deleted' });
  } catch (error) {
    next(error);
  }
};

// @desc    Record loan payment
// @route   POST /api/loans/:id/payment
// @access  Private
exports.recordPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference, notes } = req.body;
    
    const loan = await Loan.findOne({ _id: req.params.id, company: companyId });

    if (!loan) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }

    // Calculate interest portion based on loan's interest rate
    // Simple interest: Monthly interest = Principal × (Annual Rate / 12)
    let interestAmount = 0;
    if (loan.interestRate > 0) {
      const monthlyInterestRate = loan.interestRate / 100 / 12;
      interestAmount = Math.round(loan.originalAmount * monthlyInterestRate);
    }
    
    // Principal portion = Total payment - Interest
    const principalAmount = amount - interestAmount;

    // Add payment
    loan.payments.push({
      amount,
      paymentMethod,
      reference,
      notes,
      interestAmount, // Store the interest portion
      recordedBy: req.user._id,
      paymentDate: new Date()
    });

    // Update amount paid (only principal reduces the loan balance)
    loan.amountPaid += principalAmount;

    // Check if fully paid
    if (loan.amountPaid >= loan.originalAmount) {
      loan.status = 'paid-off';
    }

    await loan.save();

    // Create journal entry for loan payment
    try {
      await JournalService.createLoanPaymentEntry(companyId, req.user.id, {
        loanNumber: loan.loanNumber,
        loanType: loan.loanType, // Pass loan type to determine correct account
        date: new Date(),
        principalAmount: principalAmount,
        interestAmount: interestAmount,
        paymentMethod: paymentMethod
      });
    } catch (journalError) {
      console.error('Error creating journal entry for loan payment:', journalError);
      // Don't fail the payment if journal entry fails
    }

    res.status(201).json({ success: true, data: loan });
  } catch (error) {
    next(error);
  }
};

// @desc    Get loans summary for Balance Sheet
// @route   GET /api/loans/summary
// @access  Private
exports.getLoansSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Get active loans
    const loans = await Loan.find({ company: companyId, status: 'active' });

    // Separate by type
    const shortTermLoans = loans.filter(loan => loan.loanType === 'short-term');
    const longTermLoans = loans.filter(loan => loan.loanType === 'long-term');

    const shortTermTotal = shortTermLoans.reduce((sum, loan) => sum + (loan.remainingBalance || 0), 0);
    const longTermTotal = longTermLoans.reduce((sum, loan) => sum + (loan.remainingBalance || 0), 0);

    res.json({
      success: true,
      data: {
        shortTerm: {
          count: shortTermLoans.length,
          totalOutstanding: shortTermTotal
        },
        longTerm: {
          count: longTermLoans.length,
          totalOutstanding: longTermTotal
        },
        total: {
          count: loans.length,
          totalOutstanding: shortTermTotal + longTermTotal
        }
      }
    });
  } catch (error) {
    next(error);
  }
};
