const Budget = require('../models/Budget');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const mongoose = require('mongoose');

// @desc    Get all budgets for a company
// @route   GET /api/budgets
// @access  Private
exports.getBudgets = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, status, type, search, startDate, endDate } = req.query;
    
    const query = { company: companyId };
    
    if (status) query.status = status;
    if (type) query.type = type;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { budgetId: { $regex: search, $options: 'i' } }
      ];
    }
    if (startDate || endDate) {
      query.periodStart = {};
      query.periodEnd = {};
      if (startDate) query.periodStart.$gte = new Date(startDate);
      if (endDate) query.periodEnd.$lte = new Date(endDate);
    }
    
    const budgets = await Budget.find(query)
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const count = await Budget.countDocuments(query);
    
    res.json({
      success: true,
      data: budgets,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single budget by ID
// @route   GET /api/budgets/:id
// @access  Private
exports.getBudgetById = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    
    let budget;
    if (mongoose.Types.ObjectId.isValid(id)) {
      budget = await Budget.findOne({ _id: id, company: companyId })
        .populate('createdBy', 'name email')
        .populate('approvedBy', 'name email');
    } else {
      // Try finding by budgetId string
      budget = await Budget.findOne({ budgetId: id, company: companyId })
        .populate('createdBy', 'name email')
        .populate('approvedBy', 'name email');
    }
    
    if (!budget) {
      return res.status(404).json({ success: false, message: 'Budget not found' });
    }
    
    res.json({ success: true, data: budget });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new budget
// @route   POST /api/budgets
// @access  Private
exports.createBudget = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    
    const {
      name,
      description,
      type,
      status,
      periodStart,
      periodEnd,
      periodType,
      amount,
      department,
      notes,
      items
    } = req.body;
    
    // Generate unique budget ID
    const budgetId = await Budget.generateBudgetId(companyId);
    
    const budget = new Budget({
      budgetId,
      name,
      description,
      company: companyId,
      type,
      status: status || 'draft',
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
      periodType: periodType || 'monthly',
      amount: amount || 0,
      originalAmount: amount || 0,
      department,
      notes,
      items: items || [],
      createdBy: userId,
      approvalStatus: 'pending'
    });
    
    await budget.save();
    
    res.status(201).json({
      success: true,
      data: budget
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update budget
// @route   PUT /api/budgets/:id
// @access  Private
exports.updateBudget = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const { id } = req.params;
    
    let budget = await Budget.findOne({ _id: id, company: companyId });
    
    if (!budget) {
      return res.status(404).json({ success: false, message: 'Budget not found' });
    }
    
    // Check if budget can be edited (not approved or closed)
    if (budget.approvalStatus === 'approved' && budget.status === 'active') {
      // Create a new version instead of updating
      const newBudgetId = await Budget.generateBudgetId(companyId);
      
      const newBudget = new Budget({
        budgetId: newBudgetId,
        name: req.body.name || budget.name,
        description: req.body.description || budget.description,
        company: companyId,
        type: req.body.type || budget.type,
        status: 'draft',
        periodStart: req.body.periodStart ? new Date(req.body.periodStart) : budget.periodStart,
        periodEnd: req.body.periodEnd ? new Date(req.body.periodEnd) : budget.periodEnd,
        periodType: req.body.periodType || budget.periodType,
        amount: req.body.amount || budget.amount,
        originalAmount: req.body.amount || budget.amount,
        department: req.body.department || budget.department,
        notes: req.body.notes || budget.notes,
        items: req.body.items || budget.items,
        createdBy: userId,
        previousVersion: budget._id,
        version: budget.version + 1,
        approvalStatus: 'pending'
      });
      
      await newBudget.save();
      
      return res.json({
        success: true,
        data: newBudget,
        message: 'New budget version created'
      });
    }
    
    const updateFields = [
      'name', 'description', 'type', 'status', 'periodStart', 'periodEnd',
      'periodType', 'amount', 'department', 'notes', 'items'
    ];
    
    updateFields.forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'periodStart' || field === 'periodEnd') {
          budget[field] = new Date(req.body[field]);
        } else {
          budget[field] = req.body[field];
        }
      }
    });
    
    // Track adjustments
    if (req.body.amount && req.body.amount !== budget.originalAmount) {
      budget.adjustedAmount = req.body.amount;
    }
    
    budget.updatedBy = userId;
    budget.version += 1;
    
    await budget.save();
    
    res.json({
      success: true,
      data: budget
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete budget
// @route   DELETE /api/budgets/:id
// @access  Private
exports.deleteBudget = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    
    const budget = await Budget.findOne({ _id: id, company: companyId });
    
    if (!budget) {
      return res.status(404).json({ success: false, message: 'Budget not found' });
    }
    
    // Only allow deletion of draft budgets
    if (budget.status === 'active') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete active budget. Cancel it first.'
      });
    }
    
    await budget.deleteOne();
    
    res.json({
      success: true,
      message: 'Budget deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve budget
// @route   POST /api/budgets/:id/approve
// @access  Private (Manager/Admin)
exports.approveBudget = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const { id } = req.params;
    
    const budget = await Budget.findOne({ _id: id, company: companyId });
    
    if (!budget) {
      return res.status(404).json({ success: false, message: 'Budget not found' });
    }
    
    if (budget.approvalStatus === 'approved') {
      return res.status(400).json({ success: false, message: 'Budget already approved' });
    }
    
    budget.approvalStatus = 'approved';
    budget.approvedBy = userId;
    budget.approvedAt = new Date();
    budget.status = 'active';
    
    await budget.save();
    
    res.json({
      success: true,
      data: budget,
      message: 'Budget approved successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject budget
// @route   POST /api/budgets/:id/reject
// @access  Private (Manager/Admin)
exports.rejectBudget = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { reason } = req.body;
    
    const budget = await Budget.findOne({ _id: id, company: companyId });
    
    if (!budget) {
      return res.status(404).json({ success: false, message: 'Budget not found' });
    }
    
    if (budget.approvalStatus === 'approved') {
      return res.status(400).json({ success: false, message: 'Cannot reject already approved budget' });
    }
    
    budget.approvalStatus = 'rejected';
    budget.rejectionReason = reason || '';
    budget.status = 'cancelled';
    
    await budget.save();
    
    res.json({
      success: true,
      data: budget,
      message: 'Budget rejected'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get budget vs actual comparison
// @route   GET /api/budgets/:id/compare
// @access  Private
exports.getBudgetComparison = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    
    let budget;
    if (mongoose.Types.ObjectId.isValid(id)) {
      budget = await Budget.findOne({ _id: id, company: companyId });
    } else {
      budget = await Budget.findOne({ budgetId: id, company: companyId });
    }
    
    if (!budget) {
      return res.status(404).json({ success: false, message: 'Budget not found' });
    }
    
    const start = budget.periodStart;
    const end = budget.periodEnd || new Date();
    
    // Calculate actual amounts based on budget type
    let actualData = {
      total: 0,
      byMonth: [],
      breakdown: {}
    };
    
    if (budget.type === 'revenue') {
      // Get actual revenue from paid invoices
      const invoices = await Invoice.aggregate([
        {
          $match: {
            company: companyId,
            status: 'paid',
            paidDate: { $gte: start, $lte: end }
          }
        },
        {
          $group: {
            _id: {
              year: { $year: '$paidDate' },
              month: { $month: '$paidDate' }
            },
            total: { $sum: '$grandTotal' },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);
      
      actualData.total = invoices.reduce((sum, inv) => sum + inv.total, 0);
      actualData.byMonth = invoices.map(inv => ({
        year: inv._id.year,
        month: inv._id.month,
        amount: inv.total,
        count: inv.count
      }));
      
      // Get by payment method breakdown
      const paymentBreakdown = await Invoice.aggregate([
        {
          $match: {
            company: companyId,
            status: 'paid',
            paidDate: { $gte: start, $lte: end }
          }
        },
        { $unwind: '$payments' },
        {
          $group: {
            _id: '$payments.paymentMethod',
            total: { $sum: '$payments.amount' }
          }
        }
      ]);
      
      paymentBreakdown.forEach(item => {
        actualData.breakdown[item._id || 'unknown'] = item.total;
      });
      
    } else if (budget.type === 'expense') {
      // Get actual expenses from paid purchases
      const purchases = await Purchase.aggregate([
        {
          $match: {
            company: companyId,
            status: 'paid',
            paidDate: { $gte: start, $lte: end }
          }
        },
        {
          $group: {
            _id: {
              year: { $year: '$paidDate' },
              month: { $month: '$paidDate' }
            },
            total: { $sum: '$grandTotal' },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);
      
      actualData.total = purchases.reduce((sum, p) => sum + p.total, 0);
      actualData.byMonth = purchases.map(p => ({
        year: p._id.year,
        month: p._id.month,
        amount: p.total,
        count: p.count
      }));
    }
    
    // Calculate variance
    const variance = budget.amount - actualData.total;
    const variancePercent = budget.amount > 0 ? (variance / budget.amount) * 100 : 0;
    const utilizationPercent = budget.amount > 0 ? (actualData.total / budget.amount) * 100 : 0;
    
    // If budget has items, calculate per-item variance
    let itemComparisons = [];
    if (budget.items && budget.items.length > 0) {
      itemComparisons = budget.items.map(item => {
        const itemVariance = item.budgetedAmount - (item.actualAmount || 0);
        const itemVariancePercent = item.budgetedAmount > 0 
          ? (itemVariance / item.budgetedAmount) * 100 
          : 0;
        return {
          ...item.toObject(),
          variance: itemVariance,
          variancePercent: itemVariancePercent
        };
      });
    }
    
    res.json({
      success: true,
      data: {
        budget: {
          _id: budget._id,
          budgetId: budget.budgetId,
          name: budget.name,
          type: budget.type,
          status: budget.status,
          periodStart: budget.periodStart,
          periodEnd: budget.periodEnd,
          amount: budget.amount,
          originalAmount: budget.originalAmount,
          adjustedAmount: budget.adjustedAmount,
          items: budget.items
        },
        actual: actualData,
        variance: {
          amount: variance,
          percent: variancePercent,
          status: variance >= 0 ? 'under_budget' : 'over_budget'
        },
        utilization: {
          percent: utilizationPercent,
          remaining: Math.max(0, budget.amount - actualData.total)
        },
        itemComparisons,
        // Summary for quick display
        summary: {
          budgetedAmount: budget.amount,
          actualAmount: actualData.total,
          varianceAmount: variance,
          variancePercent: Math.round(variancePercent * 100) / 100,
          utilizationPercent: Math.round(utilizationPercent * 100) / 100,
          status: variance >= 0 ? 'on_track' : 'exceeded'
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all budgets with comparison data
// @route   GET /api/budgets/compare/all
// @access  Private
exports.getAllBudgetsComparison = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, type, periodStart, periodEnd } = req.query;
    
    const query = { company: companyId };
    if (status) query.status = status;
    if (type) query.type = type;
    if (periodStart || periodEnd) {
      query.periodStart = {};
      query.periodEnd = {};
      if (periodStart) query.periodStart.$gte = new Date(periodStart);
      if (periodEnd) query.periodEnd.$lte = new Date(periodEnd);
    }
    
    const budgets = await Budget.find(query)
      .populate('createdBy', 'name email')
      .sort({ periodStart: -1 });
    
    // Get comparison data for each budget
    const comparisons = await Promise.all(budgets.map(async (budget) => {
      const start = budget.periodStart;
      const end = budget.periodEnd || new Date();
      
      let actualTotal = 0;
      
      if (budget.type === 'revenue') {
        const result = await Invoice.aggregate([
          {
            $match: {
              company: companyId,
              status: 'paid',
              paidDate: { $gte: start, $lte: end }
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$grandTotal' }
            }
          }
        ]);
        actualTotal = result[0]?.total || 0;
      } else if (budget.type === 'expense') {
        const result = await Purchase.aggregate([
          {
            $match: {
              company: companyId,
              status: 'paid',
              paidDate: { $gte: start, $lte: end }
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$grandTotal' }
            }
          }
        ]);
        actualTotal = result[0]?.total || 0;
      }
      
      const variance = budget.amount - actualTotal;
      const variancePercent = budget.amount > 0 ? (variance / budget.amount) * 100 : 0;
      const utilizationPercent = budget.amount > 0 ? (actualTotal / budget.amount) * 100 : 0;
      
      return {
        _id: budget._id,
        budgetId: budget.budgetId,
        name: budget.name,
        type: budget.type,
        status: budget.status,
        periodStart: budget.periodStart,
        periodEnd: budget.periodEnd,
        budgetedAmount: budget.amount,
        actualAmount: actualTotal,
        variance: Math.round(variance * 100) / 100,
        variancePercent: Math.round(variancePercent * 100) / 100,
        utilizationPercent: Math.round(utilizationPercent * 100) / 100,
        createdBy: budget.createdBy
      };
    }));
    
    res.json({
      success: true,
      data: comparisons,
      summary: {
        totalBudgets: comparisons.length,
        activeBudgets: comparisons.filter(b => b.status === 'active').length,
        totalBudgeted: comparisons.reduce((sum, b) => sum + b.budgetedAmount, 0),
        totalActual: comparisons.reduce((sum, b) => sum + b.actualAmount, 0),
        averageUtilization: comparisons.length > 0
          ? comparisons.reduce((sum, b) => sum + b.utilizationPercent, 0) / comparisons.length
          : 0
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get budget summary/dashboard
// @route   GET /api/budgets/summary
// @access  Private
exports.getBudgetSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Get current active budgets
    const activeBudgets = await Budget.find({ 
      company: companyId, 
      status: 'active',
      approvalStatus: 'approved'
    });
    
    // Get current period (current month)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    // Calculate actuals for each active budget
    const budgetSummaries = await Promise.all(activeBudgets.map(async (budget) => {
      let actualAmount = 0;
      
      if (budget.type === 'revenue') {
        const result = await Invoice.aggregate([
          {
            $match: {
              company: companyId,
              status: 'paid',
              paidDate: { $gte: budget.periodStart, $lte: budget.periodEnd }
            }
          },
          { $group: { _id: null, total: { $sum: '$grandTotal' } } }
        ]);
        actualAmount = result[0]?.total || 0;
      } else if (budget.type === 'expense') {
        const result = await Purchase.aggregate([
          {
            $match: {
              company: companyId,
              status: 'paid',
              paidDate: { $gte: budget.periodStart, $lte: budget.periodEnd }
            }
          },
          { $group: { _id: null, total: { $sum: '$grandTotal' } } }
        ]);
        actualAmount = result[0]?.total || 0;
      }
      
      const variance = budget.amount - actualAmount;
      const variancePercent = budget.amount > 0 ? (variance / budget.amount) * 100 : 0;
      const utilization = budget.amount > 0 ? (actualAmount / budget.amount) * 100 : 0;
      
      return {
        _id: budget._id,
        budgetId: budget.budgetId,
        name: budget.name,
        type: budget.type,
        budgetedAmount: budget.amount,
        actualAmount,
        variance,
        variancePercent: Math.round(variancePercent * 100) / 100,
        utilization: Math.round(utilization * 100) / 100,
        periodStart: budget.periodStart,
        periodEnd: budget.periodEnd,
        isOnTrack: variance >= 0
      };
    }));
    
    // Calculate totals
    const totalBudgeted = budgetSummaries.reduce((sum, b) => sum + b.budgetedAmount, 0);
    const totalActual = budgetSummaries.reduce((sum, b) => sum + b.actualAmount, 0);
    const totalVariance = totalBudgeted - totalActual;
    
    // Count by status
    const onTrack = budgetSummaries.filter(b => b.isOnTrack).length;
    const exceeded = budgetSummaries.filter(b => !b.isOnTrack).length;
    
    // Get pending approvals
    const pendingApprovals = await Budget.countDocuments({
      company: companyId,
      approvalStatus: 'pending',
      status: 'draft'
    });
    
    // Get draft budgets
    const draftBudgets = await Budget.countDocuments({
      company: companyId,
      status: 'draft'
    });
    
    res.json({
      success: true,
      data: {
        budgets: budgetSummaries,
        totals: {
          totalBudgeted: Math.round(totalBudgeted * 100) / 100,
          totalActual: Math.round(totalActual * 100) / 100,
          totalVariance: Math.round(totalVariance * 100) / 100
        },
        status: {
          onTrack: onTrack,
          exceeded: exceeded,
          total: budgetSummaries.length
        },
        pendingApprovals,
        draftBudgets
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Clone budget to new period
// @route   POST /api/budgets/:id/clone
// @access  Private
exports.cloneBudget = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    const { id } = req.params;
    const { newPeriodStart, newPeriodEnd, newName } = req.body;
    
    const sourceBudget = await Budget.findOne({ _id: id, company: companyId });
    
    if (!sourceBudget) {
      return res.status(404).json({ success: false, message: 'Budget not found' });
    }
    
    // Generate new budget ID
    const newBudgetId = await Budget.generateBudgetId(companyId);
    
    const newBudget = new Budget({
      budgetId: newBudgetId,
      name: newName || `${sourceBudget.name} (Copy)`,
      description: sourceBudget.description,
      company: companyId,
      type: sourceBudget.type,
      status: 'draft',
      periodStart: new Date(newPeriodStart),
      periodEnd: new Date(newPeriodEnd),
      periodType: sourceBudget.periodType,
      amount: sourceBudget.amount,
      originalAmount: sourceBudget.amount,
      department: sourceBudget.department,
      notes: `Cloned from budget: ${sourceBudget.budgetId}`,
      items: sourceBudget.items,
      createdBy: userId,
      approvalStatus: 'pending'
    });
    
    await newBudget.save();
    
    res.status(201).json({
      success: true,
      data: newBudget,
      message: 'Budget cloned successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Close budget period
// @route   POST /api/budgets/:id/close
// @access  Private
exports.closeBudget = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    
    const budget = await Budget.findOne({ _id: id, company: companyId });
    
    if (!budget) {
      return res.status(404).json({ success: false, message: 'Budget not found' });
    }
    
    if (budget.status === 'closed') {
      return res.status(400).json({ success: false, message: 'Budget already closed' });
    }
    
    // Calculate final actuals before closing
    const comparison = await exports.getBudgetComparison({ 
      params: { id }, 
      user: { company: { _id: companyId } } 
    }, { 
      json: (data) => data 
    }, next);
    
    budget.status = 'closed';
    
    // Add final notes if provided
    if (req.body.notes) {
      budget.notes = (budget.notes || '') + `\n--- Closed Notes ---\n${req.body.notes}`;
    }
    
    await budget.save();
    
    res.json({
      success: true,
      data: budget,
      message: 'Budget closed successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get revenue forecast
// @route   GET /api/budgets/forecast/revenue
// @access  Private
exports.getRevenueForecast = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { months = 6 } = req.query;
    const forecastMonths = parseInt(months);
    
    // Get historical revenue data (last 12 months)
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    
    // Get paid invoices for the last 12 months
    const historicalRevenue = await Invoice.aggregate([
      {
        $match: {
          company: companyId,
          status: 'paid',
          paidDate: { $gte: twelveMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$paidDate' },
            month: { $month: '$paidDate' }
          },
          total: { $sum: '$grandTotal' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);
    
    // Calculate average monthly revenue
    const totalRevenue = historicalRevenue.reduce((sum, item) => sum + item.total, 0);
    const avgMonthlyRevenue = historicalRevenue.length > 0 ? totalRevenue / historicalRevenue.length : 0;
    
    // Calculate trend (simple linear regression)
    let trend = 0;
    if (historicalRevenue.length >= 2) {
      const n = historicalRevenue.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      historicalRevenue.forEach((item, index) => {
        const x = index;
        const y = item.total;
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
      });
      trend = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    }
    
    // Generate forecast
    const forecast = [];
    let runningTotal = 0;
    
    for (let i = 1; i <= forecastMonths; i++) {
      const forecastDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const baseForecast = avgMonthlyRevenue + trend * i;
      // Apply seasonal adjustment if we have enough data
      let seasonalAdjustment = 1;
      if (historicalRevenue.length >= 6) {
        const monthIndex = forecastDate.getMonth();
        const sameMonthHistorical = historicalRevenue.filter(h => 
          (h._id.month - 1) === monthIndex
        );
        if (sameMonthHistorical.length > 0) {
          const avgForMonth = sameMonthHistorical.reduce((s, h) => s + h.total, 0) / sameMonthHistorical.length;
          seasonalAdjustment = avgForMonth / avgMonthlyRevenue;
        }
      }
      const forecastValue = Math.max(0, baseForecast * seasonalAdjustment);
      runningTotal += forecastValue;
      
      forecast.push({
        year: forecastDate.getFullYear(),
        month: forecastDate.getMonth() + 1,
        monthName: forecastDate.toLocaleString('default', { month: 'short' }),
        projectedRevenue: Math.round(forecastValue * 100) / 100,
        confidence: calculateConfidence(historicalRevenue.length, i),
        trend: i === 1 ? (trend >= 0 ? 'up' : 'down') : null
      });
    }
    
    res.json({
      success: true,
      data: {
        historical: historicalRevenue.map(h => ({
          year: h._id.year,
          month: h._id.month,
          revenue: h.total,
          count: h.count
        })),
        forecast,
        summary: {
          averageMonthlyRevenue: Math.round(avgMonthlyRevenue * 100) / 100,
          totalProjected: Math.round(runningTotal * 100) / 100,
          trend: Math.round(trend * 100) / 100,
          trendDirection: trend >= 0 ? 'positive' : 'negative',
          dataPoints: historicalRevenue.length
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get expense forecast
// @route   GET /api/budgets/forecast/expense
// @access  Private
exports.getExpenseForecast = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { months = 6 } = req.query;
    const forecastMonths = parseInt(months);
    
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    
    // Get paid purchases for the last 12 months
    const historicalExpenses = await Purchase.aggregate([
      {
        $match: {
          company: companyId,
          status: 'paid',
          paidDate: { $gte: twelveMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$paidDate' },
            month: { $month: '$paidDate' }
          },
          total: { $sum: '$grandTotal' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);
    
    // Calculate average monthly expense
    const totalExpenses = historicalExpenses.reduce((sum, item) => sum + item.total, 0);
    const avgMonthlyExpense = historicalExpenses.length > 0 ? totalExpenses / historicalExpenses.length : 0;
    
    // Calculate trend
    let trend = 0;
    if (historicalExpenses.length >= 2) {
      const n = historicalExpenses.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      historicalExpenses.forEach((item, index) => {
        const x = index;
        const y = item.total;
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
      });
      trend = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    }
    
    // Generate forecast
    const forecast = [];
    let runningTotal = 0;
    
    for (let i = 1; i <= forecastMonths; i++) {
      const forecastDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const baseForecast = avgMonthlyExpense + trend * i;
      
      let seasonalAdjustment = 1;
      if (historicalExpenses.length >= 6) {
        const monthIndex = forecastDate.getMonth();
        const sameMonthHistorical = historicalExpenses.filter(h => 
          (h._id.month - 1) === monthIndex
        );
        if (sameMonthHistorical.length > 0) {
          const avgForMonth = sameMonthHistorical.reduce((s, h) => s + h.total, 0) / sameMonthHistorical.length;
          seasonalAdjustment = avgForMonth / avgMonthlyExpense;
        }
      }
      const forecastValue = Math.max(0, baseForecast * seasonalAdjustment);
      runningTotal += forecastValue;
      
      forecast.push({
        year: forecastDate.getFullYear(),
        month: forecastDate.getMonth() + 1,
        monthName: forecastDate.toLocaleString('default', { month: 'short' }),
        projectedExpense: Math.round(forecastValue * 100) / 100,
        confidence: calculateConfidence(historicalExpenses.length, i),
        trend: i === 1 ? (trend >= 0 ? 'up' : 'down') : null
      });
    }
    
    res.json({
      success: true,
      data: {
        historical: historicalExpenses.map(h => ({
          year: h._id.year,
          month: h._id.month,
          expense: h.total,
          count: h.count
        })),
        forecast,
        summary: {
          averageMonthlyExpense: Math.round(avgMonthlyExpense * 100) / 100,
          totalProjected: Math.round(runningTotal * 100) / 100,
          trend: Math.round(trend * 100) / 100,
          trendDirection: trend >= 0 ? 'increasing' : 'decreasing',
          dataPoints: historicalExpenses.length
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get cash flow forecast
// @route   GET /api/budgets/forecast/cashflow
// @access  Private
exports.getCashFlowForecast = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { months = 6 } = req.query;
    const forecastMonths = parseInt(months);
    
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    
    // Get historical revenue (paid invoices)
    const historicalRevenue = await Invoice.aggregate([
      {
        $match: {
          company: companyId,
          status: 'paid',
          paidDate: { $gte: twelveMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$paidDate' },
            month: { $month: '$paidDate' }
          },
          total: { $sum: '$grandTotal' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);
    
    // Get historical expenses (paid purchases)
    const historicalExpenses = await Purchase.aggregate([
      {
        $match: {
          company: companyId,
          status: 'paid',
          paidDate: { $gte: twelveMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$paidDate' },
            month: { $month: '$paidDate' }
          },
          total: { $sum: '$grandTotal' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);
    
    // Calculate averages
    const avgMonthlyRevenue = historicalRevenue.length > 0 
      ? historicalRevenue.reduce((s, h) => s + h.total, 0) / historicalRevenue.length 
      : 0;
    const avgMonthlyExpense = historicalExpenses.length > 0 
      ? historicalExpenses.reduce((s, h) => s + h.total, 0) / historicalExpenses.length 
      : 0;
    
    // Calculate trends
    const getTrend = (data) => {
      if (data.length < 2) return 0;
      const n = data.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      data.forEach((item, index) => {
        const x = index;
        const y = item.total;
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
      });
      return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    };
    
    const revenueTrend = getTrend(historicalRevenue);
    const expenseTrend = getTrend(historicalExpenses);
    
    // Get current cash position (outstanding receivables - outstanding payables)
    const currentReceivables = await Invoice.aggregate([
      {
        $match: {
          company: companyId,
          status: { $in: ['sent', 'overdue'] }
        }
      },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } }
    ]);
    
    const currentPayables = await Purchase.aggregate([
      {
        $match: {
          company: companyId,
          status: { $in: ['received', 'pending'] }
        }
      },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } }
    ]);
    
    const receivablesTotal = currentReceivables[0]?.total || 0;
    const payablesTotal = currentPayables[0]?.total || 0;
    
    // Generate forecast
    const forecast = [];
    let runningBalance = 0; // Net cash position change
    
    for (let i = 1; i <= forecastMonths; i++) {
      const forecastDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
      
      // Projected revenue with trend
      const projectedRevenue = Math.max(0, avgMonthlyRevenue + revenueTrend * i);
      // Projected expense with trend
      const projectedExpense = Math.max(0, avgMonthlyExpense + expenseTrend * i);
      
      const netCashFlow = projectedRevenue - projectedExpense;
      runningBalance += netCashFlow;
      
      forecast.push({
        year: forecastDate.getFullYear(),
        month: forecastDate.getMonth() + 1,
        monthName: forecastDate.toLocaleString('default', { month: 'short' }),
        projectedRevenue: Math.round(projectedRevenue * 100) / 100,
        projectedExpense: Math.round(projectedExpense * 100) / 100,
        netCashFlow: Math.round(netCashFlow * 100) / 100,
        cumulativeCashFlow: Math.round(runningBalance * 100) / 100
      });
    }
    
    // Calculate current position
    const currentCashPosition = receivablesTotal - payablesTotal;
    
    res.json({
      success: true,
      data: {
        currentPosition: {
          receivables: Math.round(receivablesTotal * 100) / 100,
          payables: Math.round(payablesTotal * 100) / 100,
          netPosition: Math.round(currentCashPosition * 100) / 100
        },
        historicalNetFlow: historicalRevenue.map(r => {
          const matchingExpense = historicalExpenses.find(e => 
            e._id.year === r._id.year && e._id.month === r._id.month
          );
          return {
            year: r._id.year,
            month: r._id.month,
            revenue: r.total,
            expense: matchingExpense?.total || 0,
            netFlow: r.total - (matchingExpense?.total || 0)
          };
        }),
        forecast,
        summary: {
          averageMonthlyRevenue: Math.round(avgMonthlyRevenue * 100) / 100,
          averageMonthlyExpense: Math.round(avgMonthlyExpense * 100) / 100,
          averageNetCashFlow: Math.round((avgMonthlyRevenue - avgMonthlyExpense) * 100) / 100,
          projectedTotalRevenue: Math.round(forecast.reduce((s, f) => s + f.projectedRevenue, 0) * 100) / 100,
          projectedTotalExpense: Math.round(forecast.reduce((s, f) => s + f.projectedExpense, 0) * 100) / 100,
          projectedNetCashFlow: Math.round(forecast.reduce((s, f) => s + f.netCashFlow, 0) * 100) / 100,
          revenueTrend: Math.round(revenueTrend * 100) / 100,
          expenseTrend: Math.round(expenseTrend * 100) / 100,
          dataPoints: Math.max(historicalRevenue.length, historicalExpenses.length)
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to calculate confidence based on data points
function calculateConfidence(dataPoints, forecastMonth) {
  if (dataPoints >= 12) {
    return forecastMonth <= 3 ? 'high' : forecastMonth <= 6 ? 'medium' : 'low';
  } else if (dataPoints >= 6) {
    return forecastMonth <= 3 ? 'medium' : 'low';
  } else if (dataPoints >= 3) {
    return 'low';
  }
  return 'very_low';
}
