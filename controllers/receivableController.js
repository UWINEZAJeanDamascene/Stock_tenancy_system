const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const cacheService = require('../services/cacheService');

// @desc    Get receivables dashboard summary
// @route   GET /api/receivables/summary
// @access  Private
exports.getReceivablesSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const now = new Date();

    // Total receivables (unpaid balance)
    const totalReceivables = await Invoice.aggregate([
      {
        $match: {
          company: companyId,
          balance: { $gt: 0 },
          status: { $in: ['confirmed', 'partial'] }
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

    // Overdue receivables
    const overdueReceivables = await Invoice.aggregate([
      {
        $match: {
          company: companyId,
          balance: { $gt: 0 },
          status: { $in: ['confirmed', 'partial'] }
        }
      },
      {
        $addFields: {
          dueDate: { $ifNull: ['$dueDate', '$invoiceDate'] }
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

    // Receivables by client
    const receivablesByClient = await Invoice.aggregate([
      {
        $match: {
          company: companyId,
          balance: { $gt: 0 },
          status: { $in: ['confirmed', 'partial'] }
        }
      },
      {
        $group: {
          _id: '$client',
          totalBalance: { $sum: '$balance' },
          invoiceCount: { $sum: 1 }
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
          from: 'clients',
          localField: '_id',
          foreignField: '_id',
          as: 'client'
        }
      },
      {
        $unwind: '$client'
      },
      {
        $project: {
          clientName: '$client.name',
          clientCode: '$client.code',
          totalBalance: 1,
          invoiceCount: 1
        }
      }
    ]);

    // Bad debt total
    const badDebtTotal = await Invoice.aggregate([
      {
        $match: {
          company: companyId,
          status: 'bad_debt'
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

    res.json({
      success: true,
      data: {
        totalReceivables: totalReceivables[0]?.total || 0,
        totalReceivablesCount: totalReceivables[0]?.count || 0,
        overdueReceivables: overdueReceivables[0]?.total || 0,
        overdueReceivablesCount: overdueReceivables[0]?.count || 0,
        badDebt: badDebtTotal[0]?.total || 0,
        badDebtCount: badDebtTotal[0]?.count || 0,
        topClients: receivablesByClient
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get receivable aging report
// @route   GET /api/receivables/aging
// @access  Private
exports.getReceivableAgingReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId } = req.query;
    const now = new Date();

    // Build query
    const query = {
      company: companyId,
      balance: { $gt: 0 },
      status: { $in: ['confirmed', 'partial'] }
    };

    if (clientId) {
      query.client = clientId;
    }

    const invoices = await Invoice.find(query)
      .populate('client', 'name code')
      .sort({ invoiceDate: 1 });

    // Group by client for summary
    const clientSummary = {};
    const buckets = { current: [], '1-30': [], '31-60': [], '61-90': [], '90+': [] };

    invoices.forEach(inv => {
      const clientName = inv.client?.name || 'Unknown';
      const clientIdStr = inv.client?._id?.toString() || 'unknown';

      if (!clientSummary[clientIdStr]) {
        clientSummary[clientIdStr] = {
          client: inv.client,
          totalBalance: 0,
          current: 0,
          '1-30': 0,
          '31-60': 0,
          '61-90': 0,
          '90+': 0,
          invoiceCount: 0
        };
      }

      const due = inv.dueDate || inv.invoiceDate;
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
        invoice: inv,
        balance: inv.balance,
        days
      };

      buckets[bucket].push(entry);
      clientSummary[clientIdStr][bucket] += inv.balance;
      clientSummary[clientIdStr].totalBalance += inv.balance;
      clientSummary[clientIdStr].invoiceCount += 1;
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

    Object.values(clientSummary).forEach(s => {
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
        byClient: Object.values(clientSummary),
        buckets
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client statement
// @route   GET /api/receivables/client/:clientId/statement
// @access  Private
exports.getClientStatement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId } = req.params;
    const { startDate, endDate } = req.query;

    // Verify client exists
    const client = await Client.findOne({ _id: clientId, company: companyId });
    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    // Build date filter
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    // Get all invoices from this client
    const invoiceQuery = { client: clientId, company: companyId };
    if (startDate || endDate) {
      invoiceQuery.invoiceDate = dateFilter;
    }

    const invoices = await Invoice.find(invoiceQuery)
      .populate('createdBy', 'name')
      .sort({ invoiceDate: 1 });

    // Get all payments for these invoices
    const paymentsData = [];

    invoices.forEach(inv => {
      inv.payments.forEach(payment => {
        paymentsData.push({
          date: payment.paidDate,
          type: 'payment',
          reference: payment.reference || 'N/A',
          amount: payment.amount,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate,
          invoiceTotal: inv.roundedAmount
        });
      });
    });

    // Calculate summary
    const totalInvoices = invoices.reduce((sum, inv) => sum + (inv.roundedAmount || 0), 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + (inv.amountPaid || 0), 0);
    const totalBalance = invoices.reduce((sum, inv) => sum + (inv.balance || 0), 0);

    // Get aging info for this client
    const agingInvoices = invoices.filter(inv => inv.balance > 0);

    const aging = {
      current: 0,
      '1-30': 0,
      '31-60': 0,
      '61-90': 0,
      '90+': 0
    };

    const now = new Date();
    agingInvoices.forEach(inv => {
      const due = inv.dueDate || inv.invoiceDate;
      const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));

      if (days <= 0) aging.current += inv.balance;
      else if (days <= 30) aging['1-30'] += inv.balance;
      else if (days <= 60) aging['31-60'] += inv.balance;
      else if (days <= 90) aging['61-90'] += inv.balance;
      else aging['90+'] += inv.balance;
    });

    res.json({
      success: true,
      data: {
        client: {
          _id: client._id,
          name: client.name,
          code: client.code,
          contact: client.contact
        },
        period: {
          startDate: startDate || null,
          endDate: endDate || null
        },
        summary: {
          totalInvoices,
          totalPaid,
          totalBalance,
          invoiceCount: invoices.length
        },
        aging,
        invoices: invoices.map(inv => ({
          _id: inv._id,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate,
          dueDate: inv.dueDate,
          status: inv.status,
          total: inv.roundedAmount,
          paid: inv.amountPaid,
          balance: inv.balance,
          paymentTerms: inv.paymentTerms
        })),
        payments: paymentsData.sort((a, b) => new Date(b.date) - new Date(a.date))
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Write off bad debt
// @route   POST /api/receivables/client/:clientId/bad-debt
// @access  Private (admin)
exports.writeOffBadDebt = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId } = req.params;
    const { invoiceIds, reason, notes } = req.body;

    // Verify client exists
    const client = await Client.findOne({ _id: clientId, company: companyId });
    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    // Build query for invoices to write off
    const query = {
      company: companyId,
      client: clientId,
      balance: { $gt: 0 },
      status: { $in: ['confirmed', 'partial'] }
    };

    if (invoiceIds && invoiceIds.length > 0) {
      query._id = { $in: invoiceIds };
    }

    // Get invoices to write off
    const invoices = await Invoice.find(query);

    if (invoices.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No outstanding invoices found to write off'
      });
    }

    // Calculate total bad debt amount
    const totalBadDebt = invoices.reduce((sum, inv) => sum + inv.balance, 0);

    // Update invoices to bad_debt status
    const writeOffDate = new Date();
    await Promise.all(invoices.map(async (inv) => {
      inv.status = 'bad_debt';
      inv.balance = 0;
      inv.badDebtWrittenOff = true;
      inv.writtenOffAt = writeOffDate;
      inv.writtenOffBy = req.user.id;
      inv.badDebtReason = reason || 'Bad debt write-off';
      inv.badDebtNotes = notes;
      await inv.save();
    }));

    // Update client's outstanding balance
    client.outstandingBalance -= totalBadDebt;
    if (client.outstandingBalance < 0) client.outstandingBalance = 0;
    await client.save();

    // Invalidate cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: `Bad debt of ${totalBadDebt} written off successfully`,
      data: {
        invoiceCount: invoices.length,
        totalBadDebt,
        writtenOffDate: writeOffDate,
        reason: reason || 'Bad debt write-off'
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reverse bad debt (restore invoice)
// @route   POST /api/receivables/invoice/:invoiceId/reverse-bad-debt
// @access  Private (admin)
exports.reverseBadDebt = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { invoiceId } = req.params;
    const { reason } = req.body;

    const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    if (invoice.status !== 'bad_debt') {
      return res.status(400).json({
        success: false,
        message: 'Invoice is not marked as bad debt'
      });
    }

    // Calculate the original balance before write-off
    const originalBalance = invoice.roundedAmount - invoice.amountPaid;

    // Restore the invoice
    invoice.status = 'confirmed';
    invoice.balance = originalBalance;
    invoice.badDebtWrittenOff = false;
    invoice.writtenOffAt = undefined;
    invoice.writtenOffBy = undefined;
    invoice.badDebtReason = undefined;
    invoice.badDebtNotes = undefined;
    invoice.reversedFromBadDebt = true;
    invoice.reverseBadDebtAt = new Date();
    invoice.reverseBadDebtReason = reason;
    await invoice.save();

    // Update client's outstanding balance
    const client = await Client.findOne({ _id: invoice.client, company: companyId });
    if (client) {
      client.outstandingBalance += originalBalance;
      await client.save();
    }

    // Invalidate cache
    try {
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Bad debt reversed successfully',
      data: {
        invoice: invoice,
        restoredBalance: originalBalance
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all bad debt invoices
// @route   GET /api/receivables/bad-debts
// @access  Private
exports.getBadDebts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const badDebtInvoices = await Invoice.find({
      company: companyId,
      status: 'bad_debt'
    })
      .populate('client', 'name code contact')
      .sort({ updatedAt: -1 });

    const totalBadDebt = badDebtInvoices.reduce((sum, inv) => sum + (inv.roundedAmount - inv.amountPaid), 0);

    res.json({
      success: true,
      data: {
        invoices: badDebtInvoices,
        totalBadDebt,
        count: badDebtInvoices.length
      }
    });
  } catch (error) {
    next(error);
  }
};
