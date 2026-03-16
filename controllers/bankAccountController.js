const { BankAccount, BankTransaction } = require('../models/BankAccount');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const Expense = require('../models/Expense');
const JournalService = require('../services/journalService');

// @desc    Get all bank accounts for a company
// @route   GET /api/bank-accounts
// @access  Private
exports.getBankAccounts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { accountType, isActive, page = 1, limit = 50 } = req.query;
    
    const query = { company: companyId };
    
    if (accountType) {
      query.accountType = accountType;
    }
    
    // Default to only active accounts - can be overridden by passing isActive=false
    if (isActive === undefined) {
      query.isActive = true;
    } else {
      query.isActive = isActive === 'true';
    }
    
    const accounts = await BankAccount.find(query)
      .populate('createdBy', 'name email')
      .sort({ isPrimary: -1, name: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await BankAccount.countDocuments(query);
    
    // Get totals by type
    const totals = await BankAccount.getTotalCashPosition(companyId);
    
    res.json({
      success: true,
      count: accounts.length,
      total,
      pages: Math.ceil(total / limit),
      totals,
      data: accounts
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single bank account
// @route   GET /api/bank-accounts/:id
// @access  Private
exports.getBankAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId
    }).populate('createdBy', 'name email');
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    res.json({
      success: true,
      data: account
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new bank account
// @route   POST /api/bank-accounts
// @access  Private
exports.createBankAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Check if account number already exists for this company
    if (req.body.accountNumber) {
      const existing = await BankAccount.findOne({
        company: companyId,
        accountNumber: req.body.accountNumber,
        isActive: true
      });
      
      if (existing) {
        return res.status(400).json({ 
          success: false, 
          message: 'An account with this number already exists' 
        });
      }
    }
    
    const account = new BankAccount({
      ...req.body,
      company: companyId,
      createdBy: req.user._id
    });
    
    await account.save();
    
    // Note: Opening balance is already set as currentBalance by the model's pre-save middleware
    // No need to create an opening transaction - the currentBalance represents the starting position
    
    res.status(201).json({
      success: true,
      data: account
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update bank account
// @route   PUT /api/bank-accounts/:id
// @access  Private
exports.updateBankAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    let account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    // Don't allow changing company or createdBy
    const { company, createdBy, currentBalance, ...updateData } = req.body;
    
    // If trying to update opening balance, require special permission or create adjustment
    if (updateData.openingBalance !== undefined && updateData.openingBalance !== account.openingBalance) {
      return res.status(400).json({
        success: false,
        message: 'Cannot directly modify opening balance. Use adjustment transaction instead.'
      });
    }
    
    Object.assign(account, updateData);
    await account.save();
    
    res.json({
      success: true,
      data: account
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete (deactivate) bank account
// @route   DELETE /api/bank-accounts/:id
// @access  Private
exports.deleteBankAccount = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    // Check if account has transactions
    const transactionCount = await BankTransaction.countDocuments({ account: account._id });
    
    if (transactionCount > 0 && !req.body.force) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete account with transactions. Use deactivate instead.',
        hasTransactions: true
      });
    }
    
    // Soft delete - deactivate
    account.isActive = false;
    await account.save();
    
    res.json({
      success: true,
      message: 'Bank account deactivated'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get transactions for a bank account
// @route   GET /api/bank-accounts/:id/transactions
// @access  Private
exports.getAccountTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, type, page = 1, limit = 50 } = req.query;
    
    // Verify account belongs to company
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    const query = { account: req.params.id };
    
    if (type) {
      query.type = type;
    }
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }
    
    const transactions = await BankTransaction.find(query)
      .populate('createdBy', 'name email')
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await BankTransaction.countDocuments(query);
    
    // Calculate totals
    const totals = await BankTransaction.aggregate([
      { $match: { account: new mongoose.Types.ObjectId(req.params.id) } },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$amount' }
        }
      }
    ]);
    
    res.json({
      success: true,
      count: transactions.length,
      total,
      pages: Math.ceil(total / limit),
      totals,
      data: transactions
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add transaction to bank account
// @route   POST /api/bank-accounts/:id/transactions
// @access  Private
exports.addTransaction = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
      isActive: true
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found or inactive' });
    }
    
    const transaction = await account.addTransaction({
      ...req.body,
      createdBy: req.user._id,
      status: 'completed'
    });
    
    res.status(201).json({
      success: true,
      data: transaction
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Transfer between accounts
// @route   POST /api/bank-accounts/transfer
// @access  Private
exports.transfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { fromAccount, toAccount, amount, description, referenceNumber, notes } = req.body;
    
    if (!fromAccount || !toAccount || !amount) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide fromAccount, toAccount, and amount' 
      });
    }
    
    if (amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Amount must be greater than 0' 
      });
    }
    
    // Verify both accounts exist and belong to company
    const from = await BankAccount.findOne({
      _id: fromAccount,
      company: companyId,
      isActive: true
    });
    
    const to = await BankAccount.findOne({
      _id: toAccount,
      company: companyId,
      isActive: true
    });
    
    if (!from) {
      return res.status(404).json({ success: false, message: 'Source account not found' });
    }
    
    if (!to) {
      return res.status(404).json({ success: false, message: 'Destination account not found' });
    }
    
    if (from.currentBalance < amount) {
      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient funds in source account' 
      });
    }
    
    // Create withdrawal from source
    const withdrawal = await from.addTransaction({
      type: 'transfer_out',
      amount,
      description: description || `Transfer to ${to.name}`,
      referenceNumber,
      notes,
      reference: toAccount,
      referenceType: 'BankAccount',
      createdBy: req.user._id,
      status: 'completed'
    });
    
    // Create deposit to destination
    const deposit = await to.addTransaction({
      type: 'transfer_in',
      amount,
      description: description || `Transfer from ${from.name}`,
      referenceNumber,
      notes,
      reference: fromAccount,
      referenceType: 'BankAccount',
      createdBy: req.user._id,
      status: 'completed'
    });
    
    // Create journal entry for bank transfer
    try {
      await JournalService.createBankTransferEntry({
        companyId,
        fromAccountCode: from.accountCode || '1010', // Default to cash if not set
        toAccountCode: to.accountCode || '1010',
        fromAccountName: from.name,
        toAccountName: to.name,
        amount,
        description: description || `Transfer from ${from.name} to ${to.name}`,
        referenceNumber,
        date: new Date()
      });
    } catch (journalError) {
      console.error('Journal entry creation failed for bank transfer:', journalError);
    }
    
    res.status(201).json({
      success: true,
      data: {
        withdrawal,
        deposit
      },
      message: `Successfully transferred ${amount} from ${from.name} to ${to.name}`
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get total cash position
// @route   GET /api/bank-accounts/summary/position
// @access  Private
exports.getCashPosition = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const position = await BankAccount.getTotalCashPosition(companyId);
    
    res.json({
      success: true,
      data: position
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reconcile account
// @route   POST /api/bank-accounts/:id/reconcile
// @access  Private
exports.reconcile = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { statementBalance, statementDate, notes } = req.body;
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    const difference = statementBalance - account.currentBalance;
    
    // Update reconciliation info
    account.lastReconciledAt = statementDate || new Date();
    account.lastReconciledBalance = statementBalance;
    await account.save();
    
    // If there's a difference, create an adjustment transaction
    let adjustment = null;
    if (difference !== 0) {
      adjustment = await account.addTransaction({
        type: 'adjustment',
        amount: Math.abs(difference),
        balanceAfter: statementBalance,
        description: `Reconciliation adjustment: ${difference > 0 ? 'Found' : 'Missing'} ${Math.abs(difference)}`,
        notes: notes || `Reconciled with statement balance ${statementBalance}. Difference: ${difference}`,
        createdBy: req.user._id,
        status: 'completed'
      });
    }
    
    res.json({
      success: true,
      data: {
        account,
        statementBalance,
        systemBalance: account.currentBalance,
        difference,
        adjustment
      },
      message: difference === 0 
        ? 'Account reconciled successfully - no adjustments needed'
        : `Account reconciled with ${Math.abs(difference)} adjustment`
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all transactions across all accounts
// @route   GET /api/bank-accounts/transactions
// @access  Private
exports.getAllTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, accountId, type, page = 1, limit = 50 } = req.query;
    
    const query = { company: companyId };
    
    if (accountId) {
      query.account = accountId;
    }
    
    if (type) {
      query.type = type;
    }
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }
    
    // Only get transactions from active accounts
    const activeAccounts = await BankAccount.find({ company: companyId, isActive: true }).select('_id');
    const activeAccountIds = activeAccounts.map(a => a._id);
    query.account = { $in: activeAccountIds };
    
    const transactions = await BankTransaction.find(query)
      .populate('account', 'name accountType _id')
      .populate('createdBy', 'name email')
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await BankTransaction.countDocuments(query);
    
    res.json({
      success: true,
      count: transactions.length,
      total,
      pages: Math.ceil(total / limit),
      data: transactions
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Adjust account balance
// @route   POST /api/bank-accounts/:id/adjust
// @access  Private
exports.adjustBalance = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { newBalance, reason } = req.body;
    
    if (newBalance === undefined || newBalance === null) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide newBalance' 
      });
    }
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
      isActive: true
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    const difference = newBalance - account.currentBalance;
    
    const transaction = await account.addTransaction({
      type: 'adjustment',
      amount: Math.abs(difference),
      balanceAfter: newBalance,
      description: `Balance adjustment: ${difference > 0 ? '+' : ''}${difference}`,
      notes: reason || `Manual adjustment to ${newBalance}`,
      createdBy: req.user._id,
      status: 'completed'
    });
    
    res.status(201).json({
      success: true,
      data: {
        transaction,
        previousBalance: account.currentBalance - difference,
        newBalance: account.currentBalance,
        difference
      },
      message: `Account balance adjusted by ${difference > 0 ? '+' : ''}${difference}`
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get account statistics
// @route   GET /api/bank-accounts/:id/stats
// @access  Private
exports.getAccountStats = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { period = 'month' } = req.query; // day, week, month, year
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    // Calculate date range
    const now = new Date();
    let startDate;
    let groupBy;
    
    switch (period) {
      case 'day':
        startDate = new Date(now.setDate(now.getDate() - 30));
        groupBy = { $dateToString: { format: '%Y-%m-%d', date: '$date' } };
        break;
      case 'week':
        startDate = new Date(now.setDate(now.getDate() - 90));
        groupBy = { $dateToString: { format: '%Y-%W', date: '$date' } };
        break;
      case 'month':
        startDate = new Date(now.setMonth(now.getMonth() - 12));
        groupBy = { $dateToString: { format: '%Y-%m', date: '$date' } };
        break;
      case 'year':
        startDate = new Date(now.setFullYear(now.getFullYear() - 5));
        groupBy = { $dateToString: { format: '%Y', date: '$date' } };
        break;
      default:
        startDate = new Date(now.setMonth(now.getMonth() - 12));
        groupBy = { $dateToString: { format: '%Y-%m', date: '$date' } };
    }
    
    // Get transaction totals by type
    const stats = await BankTransaction.aggregate([
      {
        $match: {
          account: account._id,
          date: { $gte: startDate }
        }
      },
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
      deposits: 0,
      withdrawals: 0,
      transfersIn: 0,
      transfersOut: 0,
      adjustments: 0,
      totalTransactions: 0
    };
    
    stats.forEach(item => {
      switch (item._id) {
        case 'deposit':
          result.deposits = item.total;
          break;
        case 'withdrawal':
          result.withdrawals = item.total;
          break;
        case 'transfer_in':
          result.transfersIn = item.total;
          break;
        case 'transfer_out':
          result.transfersOut = item.total;
          break;
        case 'adjustment':
        case 'opening':
        case 'closing':
          result.adjustments += item.total;
          break;
      }
      result.totalTransactions += item.count;
    });
    
    // Get daily/weekly/monthly trend
    const trend = await BankTransaction.aggregate([
      {
        $match: {
          account: account._id,
          date: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: groupBy,
          deposits: {
            $sum: {
              $cond: [{ $in: ['$type', ['deposit', 'transfer_in', 'opening']] }, '$amount', 0]
            }
          },
          withdrawals: {
            $sum: {
              $cond: [{ $in: ['$type', ['withdrawal', 'transfer_out', 'closing']] }, '$amount', 0]
            }
          },
          net: {
            $sum: {
              $cond: [
                { $in: ['$type', ['deposit', 'transfer_in', 'opening']] },
                '$amount',
                { $multiply: ['$amount', -1] }
              ]
            }
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    res.json({
      success: true,
      data: {
        currentBalance: account.currentBalance,
        openingBalance: account.openingBalance,
        ...result,
        netChange: result.deposits + result.transfersIn - result.withdrawals - result.transfersOut,
        trend
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get bank statement
// @route   GET /api/bank-accounts/:id/statement
// @access  Private
exports.getBankStatement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, format = 'json' } = req.query;
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    const query = { account: req.params.id };
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }
    
    const transactions = await BankTransaction.find(query)
      .populate('createdBy', 'name')
      .sort({ date: 1 });
    
    // Calculate running balance
    let runningBalance = account.openingBalance;
    const statement = transactions.map(t => {
      if (t.type === 'deposit' || t.type === 'transfer_in' || t.type === 'opening') {
        runningBalance += t.amount;
      } else {
        runningBalance -= t.amount;
      }
      return {
        ...t.toObject(),
        runningBalance
      };
    });
    
    res.json({
      success: true,
      data: {
        account: {
          name: account.name,
          accountType: account.accountType,
          accountNumber: account.accountNumber,
          bankName: account.bankName
        },
        period: {
          start: startDate,
          end: endDate
        },
        openingBalance: account.openingBalance,
        closingBalance: runningBalance,
        transactions: statement
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Import transactions from CSV
// @route   POST /api/bank-accounts/:id/import-csv
// @access  Private
exports.importCSV = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { transactions: csvTransactions, autoMatch = false, bankFormat, dateFrom, dateTo } = req.body;
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId,
      isActive: true
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    if (!csvTransactions || !Array.isArray(csvTransactions) || csvTransactions.length === 0) {
      return res.status(400).json({ success: false, message: 'No transactions provided' });
    }
    
    // Filter by date range if provided
    let filteredTransactions = csvTransactions;
    if (dateFrom || dateTo) {
      filteredTransactions = csvTransactions.filter(tx => {
        if (!tx.date) return true;
        const txDate = new Date(tx.date);
        if (isNaN(txDate.getTime())) return true;
        
        let include = true;
        if (dateFrom) {
          const fromDate = new Date(dateFrom);
          include = include && txDate >= fromDate;
        }
        if (dateTo) {
          const toDate = new Date(dateTo);
          toDate.setHours(23, 59, 59, 999);
          include = include && txDate <= toDate;
        }
        return include;
      });
    }
    
    const importedTransactions = [];
    let currentBalance = account.currentBalance;
    
    for (const tx of filteredTransactions) {
      // Parse amount - handle different CSV formats
      let amount = 0;
      if (typeof tx.amount === 'number') {
        amount = tx.amount;
      } else if (typeof tx.amount === 'string') {
        // Remove currency symbols and commas
        amount = parseFloat(tx.amount.replace(/[^0-9.-]/g, '')) || 0;
      }
      
      // Determine if credit or debit - check debitCredit field from frontend
      const isCredit = tx.debitCredit === 'credit' || tx.type === 'credit' || tx.type === 'C' || amount > 0;
      const isDebit = tx.debitCredit === 'debit' || tx.type === 'debit' || tx.type === 'D' || amount < 0;
      
      // Parse date
      let date = new Date();
      if (tx.date) {
        const parsed = new Date(tx.date);
        if (!isNaN(parsed.getTime())) {
          date = parsed;
        }
      }
      
      // Determine transaction type based on credit/debit
      let transactionType = 'deposit';
      if (isDebit) {
        transactionType = 'withdrawal';
      } else if (isCredit) {
        transactionType = 'deposit';
      }
      
      // Create transaction
      const transaction = new BankTransaction({
        company: companyId,
        account: account._id,
        type: transactionType,
        amount: Math.abs(amount),
        balanceAfter: currentBalance,
        description: tx.description || tx.narration || tx.details || 'Imported from CSV',
        date,
        referenceNumber: tx.reference || tx.ref || tx.transactionId || '',
        paymentMethod: 'bank_transfer',
        status: 'completed',
        createdBy: req.user._id,
        notes: `Imported: ${tx.date} | ${tx.reference || ''} | Format: ${bankFormat || 'auto'}`
      });
      
      await transaction.save();
      
      // Update running balance
      if (isCredit) {
        currentBalance += Math.abs(amount);
      } else if (isDebit) {
        currentBalance -= Math.abs(amount);
      }
      
      transaction.balanceAfter = currentBalance;
      await transaction.save();
      
      importedTransactions.push(transaction);
    }
    
    // Update account balance
    account.currentBalance = currentBalance;
    await account.save();
    
    let matchResults = null;
    let matched = 0;
    let unmatched = importedTransactions.length;
    
    // Auto-match if enabled
    if (autoMatch && importedTransactions.length > 0) {
      matchResults = await autoMatchTransactions(companyId, account._id, importedTransactions);
      matched = matchResults.matched;
      unmatched = matchResults.unmatched;
    }
    
    res.status(201).json({
      success: true,
      data: {
        imported: importedTransactions.length,
        matched,
        unmatched,
        newBalance: currentBalance,
        transactions: importedTransactions,
        matchResults
      },
      message: `Successfully imported ${importedTransactions.length} transactions`
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Auto-match transactions with invoices, purchases, expenses
// @route   POST /api/bank-accounts/:id/auto-match
// @access  Private
exports.autoMatchTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const accountId = req.params.id;
    
    const account = await BankAccount.findOne({
      _id: accountId,
      company: companyId
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    const results = await autoMatchTransactions(companyId, accountId);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get reconciliation report
// @route   GET /api/bank-accounts/:id/reconciliation-report
// @access  Private
exports.getReconciliationReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    
    const account = await BankAccount.findOne({
      _id: req.params.id,
      company: companyId
    });
    
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }
    
    // Get all transactions in date range
    const query = { account: account._id };
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }
    
    const transactions = await BankTransaction.find(query)
      .sort({ date: 1 });
    
    // Get all paid invoices
    const invoices = await Invoice.find({
      company: companyId,
      status: 'paid',
      paymentMethod: 'bank_transfer'
    }).populate('client', 'name');
    
    // Get all paid purchases
    const purchases = await Purchase.find({
      company: companyId,
      status: 'received',
      paymentMethod: 'bank_transfer'
    }).populate('supplier', 'name');
    
    // Get all paid expenses
    const expenses = await Expense.find({
      company: companyId,
      paid: true,
      paymentMethod: 'bank_transfer'
    });
    
    // Categorize transactions
    const matched = [];
    const unmatched = [];
    
    for (const tx of transactions) {
      const matchResult = findMatch(tx, invoices, purchases, expenses);
      
      if (matchResult) {
        matched.push({
          transaction: tx,
          matchedTo: matchResult
        });
      } else {
        unmatched.push(tx);
      }
    }
    
    // Calculate totals
    const matchedAmount = matched.reduce((sum, m) => sum + m.transaction.amount, 0);
    const unmatchedAmount = unmatched.reduce((sum, m) => sum + m.transaction.amount, 0);
    
    res.json({
      success: true,
      data: {
        account: {
          name: account.name,
          accountType: account.accountType,
          currentBalance: account.currentBalance
        },
        period: { startDate, endDate },
        summary: {
          totalTransactions: transactions.length,
          matched: matched.length,
          unmatched: unmatched.length,
          matchedAmount,
          unmatchedAmount
        },
        matched,
        unmatched
      }
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to auto-match transactions
async function autoMatchTransactions(companyId, accountId, transactions = null) {
  const txList = transactions || await BankTransaction.find({
    company: companyId,
    account: accountId,
    status: 'completed'
  });
  
  // Get all pending payments from invoices, purchases, expenses
  const invoices = await Invoice.find({
    company: companyId,
    status: { $in: ['confirmed', 'partial'] },
    paymentMethod: 'bank_transfer'
  }).populate('client', 'name');
  
  const purchases = await Purchase.find({
    company: companyId,
    status: { $in: ['pending', 'partial'] },
    paymentMethod: 'bank_transfer'
  }).populate('supplier', 'name');
  
  const expenses = await Expense.find({
    company: companyId,
    paid: false,
    paymentMethod: 'bank_transfer'
  });
  
  let matched = 0;
  let unmatched = 0;
  
  for (const tx of txList) {
    const matchResult = findMatch(tx, invoices, purchases, expenses);
    
    if (matchResult) {
      // Update the transaction with match info
      tx.reference = matchResult.id;
      tx.referenceType = matchResult.type;
      tx.notes = (tx.notes || '') + ` | Matched to ${matchResult.type} #${matchResult.number}`;
      await tx.save();
      
      // Mark the invoice/purchase/expense as paid
      if (matchResult.type === 'Invoice') {
        await Invoice.findByIdAndUpdate(matchResult.id, {
          status: 'paid',
          paidDate: tx.date
        });
      } else if (matchResult.type === 'Purchase') {
        await Purchase.findByIdAndUpdate(matchResult.id, {
          status: 'received'
        });
      } else if (matchResult.type === 'Expense') {
        await Expense.findByIdAndUpdate(matchResult.id, {
          paid: true,
          paidDate: tx.date
        });
      }
      
      matched++;
    } else {
      unmatched++;
    }
  }
  
  return { matched, unmatched };
}

// Helper function to find match for a transaction
function findMatch(tx, invoices, purchases, expenses) {
  const txAmount = tx.amount;
  const txRef = (tx.referenceNumber || '').toLowerCase();
  const txDesc = (tx.description || '').toLowerCase();
  
  // Try to match with invoices (payments received)
  for (const invoice of invoices) {
    const invoiceTotal = invoice.total || 0;
    const invoiceNumber = (invoice.invoiceNumber || '').toLowerCase();
    const clientName = (invoice.client?.name || '').toLowerCase();
    
    // Check amount match (within 1% tolerance)
    const amountDiff = Math.abs(txAmount - invoiceTotal) / invoiceTotal;
    
    if (amountDiff < 0.01 || txAmount === invoiceTotal) {
      // Check reference/number match
      if (txRef.includes(invoiceNumber) || txDesc.includes(invoiceNumber) || txDesc.includes(clientName)) {
        return {
          type: 'Invoice',
          id: invoice._id,
          number: invoice.invoiceNumber,
          amount: invoiceTotal
        };
      }
    }
  }
  
  // Try to match with purchases (payments made)
  for (const purchase of purchases) {
    const purchaseTotal = purchase.total || 0;
    const purchaseNumber = (purchase.orderNumber || '').toLowerCase();
    const supplierName = (purchase.supplier?.name || '').toLowerCase();
    
    const amountDiff = Math.abs(txAmount - purchaseTotal) / purchaseTotal;
    
    if (amountDiff < 0.01 || txAmount === purchaseTotal) {
      if (txRef.includes(purchaseNumber) || txDesc.includes(purchaseNumber) || txDesc.includes(supplierName)) {
        return {
          type: 'Purchase',
          id: purchase._id,
          number: purchase.orderNumber,
          amount: purchaseTotal
        };
      }
    }
  }
  
  // Try to match with expenses
  for (const expense of expenses) {
    const expenseAmount = expense.amount || 0;
    const expenseDesc = (expense.description || '').toLowerCase();
    
    const amountDiff = Math.abs(txAmount - expenseAmount) / expenseAmount;
    
    if (amountDiff < 0.01 || txAmount === expenseAmount) {
      if (txRef.includes(expenseDesc) || txDesc.includes(expenseDesc)) {
        return {
          type: 'Expense',
          id: expense._id,
          number: expense.expenseNumber || expense.description,
          amount: expenseAmount
        };
      }
    }
  }
  
  return null;
}
