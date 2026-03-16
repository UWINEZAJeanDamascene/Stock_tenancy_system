const Purchase = require('../models/Purchase');
const Supplier = require('../models/Supplier');
const PaymentSchedule = require('../models/PaymentSchedule');
const cacheService = require('../services/cacheService');

// @desc    Get all payment schedules
// @route   GET /api/payables/schedules
// @access  Private
exports.getPaymentSchedules = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { supplierId, status, startDate, endDate } = req.query;
    const query = { company: companyId };

    if (supplierId) {
      query.supplier = supplierId;
    }

    if (status) {
      query.status = status;
    }

    if (startDate || endDate) {
      query.scheduledDate = {};
      if (startDate) query.scheduledDate.$gte = new Date(startDate);
      if (endDate) query.scheduledDate.$lte = new Date(endDate);
    }

    const schedules = await PaymentSchedule.find(query)
      .populate('purchase', 'purchaseNumber grandTotal amountPaid balance')
      .populate('supplier', 'name code')
      .populate('createdBy', 'name email')
      .sort({ scheduledDate: 1 });

    res.json({
      success: true,
      count: schedules.length,
      data: schedules
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single payment schedule
// @route   GET /api/payables/schedules/:id
// @access  Private
exports.getPaymentSchedule = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const schedule = await PaymentSchedule.findOne({ _id: req.params.id, company: companyId })
      .populate('purchase')
      .populate('supplier', 'name code contact')
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Payment schedule not found'
      });
    }

    res.json({
      success: true,
      data: schedule
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create payment schedule
// @route   POST /api/payables/schedules
// @access  Private (admin, stock_manager)
exports.createPaymentSchedule = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { purchase, supplier, installments, earlyPaymentDiscount } = req.body;

    // Verify purchase exists
    const existingPurchase = await Purchase.findOne({ _id: purchase, company: companyId });
    if (!existingPurchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    // Verify supplier exists
    const existingSupplier = await Supplier.findOne({ _id: supplier, company: companyId });
    if (!existingSupplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Calculate installment amounts
    const balance = existingPurchase.balance;
    const installmentAmount = balance / installments.length;
    const now = new Date();

    // Create payment schedules for each installment
    const schedules = await Promise.all(installments.map((installment, index) => {
      return PaymentSchedule.create({
        company: companyId,
        purchase: existingPurchase._id,
        supplier: existingSupplier._id,
        installmentNumber: index + 1,
        scheduledAmount: installmentAmount,
        scheduledDate: new Date(installment.date),
        status: 'pending',
        earlyPaymentDiscount: earlyPaymentDiscount ? {
          applied: false,
          discountPercent: earlyPaymentDiscount.discountPercent || 0,
          discountAmount: 0,
          originalAmount: installmentAmount
        } : null,
        notes: installment.notes,
        createdBy: req.user.id
      });
    }));

    // Invalidate cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.status(201).json({
      success: true,
      count: schedules.length,
      data: schedules
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update payment schedule
// @route   PUT /api/payables/schedules/:id
// @access  Private (admin, stock_manager)
exports.updatePaymentSchedule = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let schedule = await PaymentSchedule.findOne({ _id: req.params.id, company: companyId });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Payment schedule not found'
      });
    }

    // Only pending schedules can be updated
    if (schedule.status !== 'pending' && schedule.status !== 'overdue') {
      return res.status(400).json({
        success: false,
        message: 'Only pending or overdue payment schedules can be updated'
      });
    }

    const { scheduledAmount, scheduledDate, notes, earlyPaymentDiscount } = req.body;

    if (scheduledAmount) schedule.scheduledAmount = scheduledAmount;
    if (scheduledDate) schedule.scheduledDate = new Date(scheduledDate);
    if (notes) schedule.notes = notes;
    if (earlyPaymentDiscount) {
      schedule.earlyPaymentDiscount = {
        ...schedule.earlyPaymentDiscount,
        discountPercent: earlyPaymentDiscount.discountPercent || schedule.earlyPaymentDiscount.discountPercent,
        originalAmount: schedule.scheduledAmount
      };
    }

    schedule.updatedBy = req.user.id;
    await schedule.save();

    // Invalidate cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      data: schedule
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete payment schedule
// @route   DELETE /api/payables/schedules/:id
// @access  Private (admin)
exports.deletePaymentSchedule = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const schedule = await PaymentSchedule.findOne({ _id: req.params.id, company: companyId });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Payment schedule not found'
      });
    }

    // Only pending schedules can be deleted
    if (schedule.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Only pending payment schedules can be deleted'
      });
    }

    await schedule.deleteOne();

    res.json({
      success: true,
      message: 'Payment schedule deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record payment for a payment schedule
// @route   POST /api/payables/schedules/:id/pay
// @access  Private (admin, stock_manager, purchases)
exports.recordSchedulePayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference, notes, applyEarlyPaymentDiscount } = req.body;

    const schedule = await PaymentSchedule.findOne({ _id: req.params.id, company: companyId })
      .populate('purchase');

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Payment schedule not found'
      });
    }

    if (schedule.status === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Payment schedule is already paid'
      });
    }

    let paymentAmount = amount;
    let discountAmount = 0;

    // Check if early payment discount should be applied
    if (applyEarlyPaymentDiscount && schedule.earlyPaymentDiscount && schedule.earlyPaymentDiscount.discountPercent > 0) {
      discountAmount = schedule.scheduledAmount * (schedule.earlyPaymentDiscount.discountPercent / 100);
      paymentAmount = schedule.scheduledAmount - discountAmount;
      
      schedule.earlyPaymentDiscount.applied = true;
      schedule.earlyPaymentDiscount.discountAmount = discountAmount;
    }

    if (paymentAmount > schedule.scheduledAmount) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount exceeds scheduled amount'
      });
    }

    // Update schedule
    schedule.paidAmount = paymentAmount;
    schedule.paidDate = new Date();
    schedule.paymentMethod = paymentMethod;
    schedule.paymentReference = reference;
    schedule.paymentNotes = notes;
    schedule.status = 'paid';
    schedule.updatedBy = req.user.id;
    await schedule.save();

    // Record payment on the purchase
    const purchase = schedule.purchase;
    purchase.payments.push({
      amount: paymentAmount,
      paymentMethod,
      reference,
      notes: notes || `Payment for installment #${schedule.installmentNumber}`,
      recordedBy: req.user.id
    });

    purchase.amountPaid += paymentAmount;
    purchase.balance = purchase.roundedAmount - purchase.amountPaid;
    if (purchase.balance < 0) purchase.balance = 0;

    // Update status based on payment
    if (purchase.amountPaid >= purchase.roundedAmount && purchase.roundedAmount > 0) {
      purchase.status = 'paid';
      if (!purchase.paidDate) {
        purchase.paidDate = new Date();
      }
    } else if (purchase.amountPaid > 0 && purchase.amountPaid < purchase.roundedAmount) {
      purchase.status = 'partial';
    }

    await purchase.save();

    // Update supplier outstanding balance
    const supplier = await Supplier.findOne({ _id: schedule.supplier, company: companyId });
    if (supplier) {
      supplier.outstandingBalance -= paymentAmount;
      if (supplier.outstandingBalance < 0) supplier.outstandingBalance = 0;
      await supplier.save();
    }

    // Invalidate cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      data: {
        schedule,
        purchase,
        discountApplied: discountAmount > 0,
        discountAmount
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get supplier statement (reconciliation)
// @route   GET /api/payables/supplier/:supplierId/statement
// @access  Private
exports.getSupplierStatement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { supplierId } = req.params;
    const { startDate, endDate } = req.query;

    // Verify supplier exists
    const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Build date filter
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    // Get all purchases from this supplier
    const purchaseQuery = { supplier: supplierId, company: companyId };
    if (startDate || endDate) {
      purchaseQuery.purchaseDate = dateFilter;
    }

    const purchases = await Purchase.find(purchaseQuery)
      .populate('createdBy', 'name')
      .sort({ purchaseDate: 1 });

    // Get all payments for these purchases
    const purchaseIds = purchases.map(p => p._id);
    const paymentsData = [];

    purchases.forEach(purchase => {
      purchase.payments.forEach(payment => {
        paymentsData.push({
          date: payment.paidDate,
          type: 'payment',
          reference: payment.reference || 'N/A',
          amount: payment.amount,
          purchaseNumber: purchase.purchaseNumber,
          purchaseDate: purchase.purchaseDate,
          purchaseTotal: purchase.roundedAmount
        });
      });
    });

    // Calculate summary
    const totalPurchases = purchases.reduce((sum, p) => sum + (p.roundedAmount || 0), 0);
    const totalPaid = purchases.reduce((sum, p) => sum + (p.amountPaid || 0), 0);
    const totalBalance = purchases.reduce((sum, p) => sum + (p.balance || 0), 0);

    // Get aging info for this supplier
    const now = new Date();
    const agingPurchases = purchases.filter(p => p.balance > 0);
    
    const aging = {
      current: 0,
      '1-30': 0,
      '31-60': 0,
      '61-90': 0,
      '90+': 0
    };

    agingPurchases.forEach(p => {
      const due = p.expectedDeliveryDate || p.purchaseDate;
      const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
      
      if (days <= 0) aging.current += p.balance;
      else if (days <= 30) aging['1-30'] += p.balance;
      else if (days <= 60) aging['31-60'] += p.balance;
      else if (days <= 90) aging['61-90'] += p.balance;
      else aging['90+'] += p.balance;
    });

    res.json({
      success: true,
      data: {
        supplier: {
          _id: supplier._id,
          name: supplier.name,
          code: supplier.code,
          contact: supplier.contact
        },
        period: {
          startDate: startDate || null,
          endDate: endDate || null
        },
        summary: {
          totalPurchases,
          totalPaid,
          totalBalance,
          purchaseCount: purchases.length
        },
        aging,
        purchases: purchases.map(p => ({
          _id: p._id,
          purchaseNumber: p.purchaseNumber,
          purchaseDate: p.purchaseDate,
          dueDate: p.expectedDeliveryDate,
          status: p.status,
          total: p.roundedAmount,
          paid: p.amountPaid,
          balance: p.balance,
          paymentTerms: p.paymentTerms
        })),
        payments: paymentsData.sort((a, b) => new Date(b.date) - new Date(a.date))
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reconcile supplier statement
// @route   POST /api/payables/supplier/:supplierId/reconcile
// @access  Private (admin)
exports.reconcileSupplierStatement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { supplierId } = req.params;
    const { notes, adjustments } = req.body;

    // Verify supplier exists
    const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Get all purchases from this supplier
    const purchases = await Purchase.find({ supplier: supplierId, company: companyId });

    // Calculate actual balance from purchases
    const actualBalance = purchases.reduce((sum, p) => sum + (p.balance || 0), 0);

    // Create reconciliation record (could be stored in a separate model if needed)
    const reconciliation = {
      reconciledAt: new Date(),
      reconciledBy: req.user.id,
      supplierId,
      previousBalance: supplier.outstandingBalance || 0,
      actualBalance,
      difference: (supplier.outstandingBalance || 0) - actualBalance,
      notes,
      adjustments: adjustments || []
    };

    // Update supplier's outstanding balance to match actual
    supplier.outstandingBalance = actualBalance;
    await supplier.save();

    // Invalidate cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Supplier statement reconciled successfully',
      data: reconciliation
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get payable aging report (enhanced)
// @route   GET /api/payables/aging
// @access  Private
exports.getPayableAgingReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { supplierId } = req.query;
    const now = new Date();

    // Build query
    const query = { 
      company: companyId,
      balance: { $gt: 0 },
      status: { $in: ['draft', 'ordered', 'received', 'partial'] }
    };

    if (supplierId) {
      query.supplier = supplierId;
    }

    const purchases = await Purchase.find(query)
      .populate('supplier', 'name code')
      .sort({ purchaseDate: 1 });

    // Group by supplier for summary
    const supplierSummary = {};
    const buckets = { current: [], '1-30': [], '31-60': [], '61-90': [], '90+': [] };

    purchases.forEach(p => {
      const supplierName = p.supplier?.name || 'Unknown';
      const supplierId = p.supplier?._id?.toString() || 'unknown';
      
      if (!supplierSummary[supplierId]) {
        supplierSummary[supplierId] = {
          supplier: p.supplier,
          totalBalance: 0,
          current: 0,
          '1-30': 0,
          '31-60': 0,
          '61-90': 0,
          '90+': 0,
          purchaseCount: 0
        };
      }

      const due = p.expectedDeliveryDate || p.purchaseDate;
      const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
      
      let bucket;
      if (days <= 0) {
        bucket = 'current';
      } else if (days <= 30) {
        bucket = '1-30';
      } else if (days <= 60) {
        bucket = '31-60';
      } else if (days <= 90) {
        bucket = '61-90';
      } else {
        bucket = '90+';
      }

      const entry = {
        purchase: p,
        balance: p.balance,
        days
      };

      buckets[bucket].push(entry);
      supplierSummary[supplierId][bucket] += p.balance;
      supplierSummary[supplierId].totalBalance += p.balance;
      supplierSummary[supplierId].purchaseCount += 1;
    });

    // Calculate totals
    const totals = {
      current: 0,
      '1-30': 0,
      '31-60': 0,
      '61-90': 0,
      '90+': 0,
      total: 0
    };

    Object.values(supplierSummary).forEach(s => {
      totals.current += s.current;
      totals['1-30'] += s['1-30'];
      totals['31-60'] += s['31-60'];
      totals['61-90'] += s['61-90'];
      totals['90+'] += s['90+'];
      totals.total += s.totalBalance;
    });

    res.json({
      success: true,
      data: {
        asOfDate: now,
        summary: totals,
        bySupplier: Object.values(supplierSummary),
        buckets
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get payables dashboard summary
// @route   GET /api/payables/summary
// @access  Private
exports.getPayablesSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const now = new Date();

    // Total payables (unpaid balance)
    const totalPayables = await Purchase.aggregate([
      {
        $match: {
          company: companyId,
          balance: { $gt: 0 },
          status: { $in: ['draft', 'ordered', 'received', 'partial'] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$balance' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Overdue payables
    const overduePayables = await Purchase.aggregate([
      {
        $match: {
          company: companyId,
          balance: { $gt: 0 },
          status: { $in: ['draft', 'ordered', 'received', 'partial'] }
        }
      },
      {
        $addFields: {
          dueDate: { $ifNull: ['$expectedDeliveryDate', '$purchaseDate'] }
        }
      },
      {
        $match: {
          dueDate: { $lt: now }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$balance' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Upcoming payments (next 7 days)
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const upcomingSchedules = await PaymentSchedule.aggregate([
      {
        $match: {
          company: companyId,
          status: 'pending',
          scheduledDate: { $gte: now, $lte: nextWeek }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$scheduledAmount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Payables by supplier
    const payablesBySupplier = await Purchase.aggregate([
      {
        $match: {
          company: companyId,
          balance: { $gt: 0 },
          status: { $in: ['draft', 'ordered', 'received', 'partial'] }
        }
      },
      {
        $group: {
          _id: '$supplier',
          totalBalance: { $sum: '$balance' },
          purchaseCount: { $sum: 1 }
        }
      },
      {
        $sort: { totalBalance: -1 }
      },
      {
        $limit: 10
      },
      {
        $lookup: {
          from: 'suppliers',
          localField: '_id',
          foreignField: '_id',
          as: 'supplier'
        }
      },
      {
        $unwind: '$supplier'
      },
      {
        $project: {
          supplierName: '$supplier.name',
          supplierCode: '$supplier.code',
          totalBalance: 1,
          purchaseCount: 1
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        totalPayables: totalPayables[0]?.total || 0,
        totalPayablesCount: totalPayables[0]?.count || 0,
        overduePayables: overduePayables[0]?.total || 0,
        overduePayablesCount: overduePayables[0]?.count || 0,
        upcomingPayments: upcomingSchedules[0]?.total || 0,
        upcomingPaymentsCount: upcomingSchedules[0]?.count || 0,
        topSuppliers: payablesBySupplier
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Auto-generate payment schedules from purchase payment terms
// @route   POST /api/payables/generate-schedules
// @access  Private (admin)
exports.generateSchedulesFromPurchases = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { purchaseIds, installmentCount, startDate } = req.body;

    // Get purchases to generate schedules for
    const query = { 
      company: companyId,
      balance: { $gt: 0 },
      status: { $in: ['received', 'partial'] }
    };

    if (purchaseIds && purchaseIds.length > 0) {
      query._id = { $in: purchaseIds };
    }

    const purchases = await Purchase.find(query)
      .populate('supplier', 'name code');

    const schedules = [];
    const startFromDate = startDate ? new Date(startDate) : new Date();

    for (const purchase of purchases) {
      // Skip if already has schedules
      const existingSchedules = await PaymentSchedule.find({ purchase: purchase._id });
      if (existingSchedules.length > 0) continue;

      const balance = purchase.balance;
      const amountPerInstallment = balance / installmentCount;

      for (let i = 0; i < installmentCount; i++) {
        const installmentDate = new Date(startFromDate);
        installmentDate.setDate(installmentDate.getDate() + (i * 30)); // Monthly installments

        const schedule = await PaymentSchedule.create({
          company: companyId,
          purchase: purchase._id,
          supplier: purchase.supplier._id,
          installmentNumber: i + 1,
          scheduledAmount: amountPerInstallment,
          scheduledDate: installmentDate,
          status: 'pending',
          createdBy: req.user.id
        });

        schedules.push(schedule);
      }
    }

    // Invalidate cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.status(201).json({
      success: true,
      count: schedules.length,
      message: `Generated ${schedules.length} payment schedules`,
      data: schedules
    });
  } catch (error) {
    next(error);
  }
};
