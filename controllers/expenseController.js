const Expense = require('../models/Expense');
const mongoose = require('mongoose');
const { BankAccount, BankTransaction } = require('../models/BankAccount');
const JournalService = require('../services/journalService');

// @desc    Get all expenses for a company
// @route   GET /api/expenses
// @access  Private
exports.getExpenses = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { type, startDate, endDate, page = 1, limit = 50 } = req.query;
    
    const query = { company: companyId };
    
    if (type) {
      query.type = type;
    }
    
    if (startDate || endDate) {
      query.expenseDate = {};
      if (startDate) query.expenseDate.$gte = new Date(startDate);
      if (endDate) query.expenseDate.$lte = new Date(endDate);
    }
    
    const expenses = await Expense.find(query)
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .sort({ expenseDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Expense.countDocuments(query);
    
    res.json({
      success: true,
      count: expenses.length,
      total,
      pages: Math.ceil(total / limit),
      data: expenses
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single expense
// @route   GET /api/expenses/:id
// @access  Private
exports.getExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const expense = await Expense.findOne({
      _id: req.params.id,
      company: companyId
    }).populate('createdBy', 'name email').populate('approvedBy', 'name email');
    
    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    
    res.json({
      success: true,
      data: expense
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new expense
// @route   POST /api/expenses
// @access  Private
exports.createExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const expense = new Expense({
      ...req.body,
      company: companyId,
      createdBy: req.user._id
    });
    
    await expense.save();
    
    // Create journal entry if expense is marked as paid immediately
    if (expense.paid === true) {
      try {
        await JournalService.createExpenseEntry(companyId, req.user.id, {
          _id: expense._id,
          description: expense.description || expense.type,
          date: expense.expenseDate || new Date(),
          amount: expense.amount,
          vatAmount: expense.vatAmount || 0,
          category: expense.type,
          paymentMethod: expense.paymentMethod
        });
      } catch (journalError) {
        console.error('Error creating journal entry for expense:', journalError);
      }
    }
    
    res.status(201).json({
      success: true,
      data: expense
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update expense
// @route   PUT /api/expenses/:id
// @access  Private
exports.updateExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    let expense = await Expense.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    
    // Don't allow changing company or createdBy
    const { company, createdBy, bankAccountId, ...updateData } = req.body;
    
    // Check if expense is being marked as paid with bank transfer
    const isBeingPaid = updateData.paid === true && !expense.paid;
    const paymentMethod = updateData.paymentMethod;
    
    Object.assign(expense, updateData);
    await expense.save();

    // Create journal entry for expense payment
    let journalEntry = null;
    if (isBeingPaid) {
      try {
        await JournalService.createExpenseEntry(companyId, req.user.id, {
          _id: expense._id,
          description: expense.description || expense.type,
          date: expense.expenseDate || new Date(),
          amount: expense.amount,
          vatAmount: expense.vatAmount || 0,
          category: expense.type,
          paymentMethod: expense.paymentMethod
        });
      } catch (journalError) {
        console.error('Error creating journal entry for expense:', journalError);
        // Don't fail the expense update if journal entry fails
      }
    }
    
    // Create bank transaction if expense is being marked as paid with bank transfer
    let bankTransaction = null;
    if (isBeingPaid && paymentMethod === 'bank_transfer' && bankAccountId) {
      try {
        const bankAccount = await BankAccount.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true
        });
        
        if (bankAccount) {
          const currentBalance = bankAccount.currentBalance;
          
          // Create withdrawal transaction (debit) for expense payment
          const transaction = new BankTransaction({
            company: companyId,
            account: bankAccount._id,
            type: 'withdrawal',
            amount: expense.amount,
            balanceAfter: currentBalance - expense.amount,
            description: `Expense paid: ${expense.description || expense.type}`,
            date: new Date(),
            referenceNumber: expense.reference || '',
            paymentMethod: 'bank_transfer',
            status: 'completed',
            reference: expense._id,
            referenceType: 'Expense',
            createdBy: req.user._id,
            notes: `Payment for expense: ${expense.description || expense.type}`
          });
          
          await transaction.save();
          
          // Update bank account balance
          bankAccount.currentBalance = currentBalance - expense.amount;
          await bankAccount.save();
          
          bankTransaction = transaction;
        }
      } catch (bankError) {
        console.error('Error creating bank transaction:', bankError);
      }
    }
    
    res.json({
      success: true,
      data: expense,
      bankTransaction: bankTransaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete expense
// @route   DELETE /api/expenses/:id
// @access  Private
exports.deleteExpense = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const expense = await Expense.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    
    // Soft delete - mark as cancelled
    expense.status = 'cancelled';
    await expense.save();
    
    res.json({
      success: true,
      message: 'Expense cancelled'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get expense summary by type for a period
// @route   GET /api/expenses/summary
// @access  Private
exports.getExpenseSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    
    const match = {
      company: companyId,
      status: { $ne: 'cancelled' }
    };
    
    if (startDate || endDate) {
      match.expenseDate = {};
      if (startDate) match.expenseDate.$gte = new Date(startDate);
      if (endDate) match.expenseDate.$lte = new Date(endDate);
    }
    
    const summary = await Expense.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Transform to object
    const result = {
      salariesWages: 0,
      rent: 0,
      utilities: 0,
      transportDelivery: 0,
      marketingAdvertising: 0,
      otherExpenses: 0,
      interestIncome: 0,
      otherIncome: 0,
      totalOperating: 0,
      totalOtherIncome: 0
    };
    
    summary.forEach(item => {
      const type = item._id;
      const total = item.total;
      
      switch (type) {
        case 'salaries_wages':
          result.salariesWages = total;
          result.totalOperating += total;
          break;
        case 'rent':
          result.rent = total;
          result.totalOperating += total;
          break;
        case 'utilities':
          result.utilities = total;
          result.totalOperating += total;
          break;
        case 'transport_delivery':
          result.transportDelivery = total;
          result.totalOperating += total;
          break;
        case 'marketing_advertising':
          result.marketingAdvertising = total;
          result.totalOperating += total;
          break;
        case 'other_expense':
          result.otherExpenses = total;
          result.totalOperating += total;
          break;
        case 'interest_income':
          result.interestIncome = total;
          result.totalOtherIncome += total;
          break;
        case 'other_income':
          result.otherIncome = total;
          result.totalOtherIncome += total;
          break;
      }
    });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk create expenses
// @route   POST /api/expenses/bulk
// @access  Private
exports.bulkCreateExpenses = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { expenses } = req.body;
    
    if (!expenses || !Array.isArray(expenses) || expenses.length === 0) {
      return res.status(400).json({ success: false, message: 'No expenses provided' });
    }
    
    const createdExpenses = await Promise.all(
      expenses.map(async (expenseData) => {
        const expense = new Expense({
          ...expenseData,
          company: companyId,
          createdBy: req.user._id
        });
        await expense.save();
        return expense;
      })
    );
    
    res.status(201).json({
      success: true,
      count: createdExpenses.length,
      data: createdExpenses
    });
  } catch (error) {
    next(error);
  }
};
