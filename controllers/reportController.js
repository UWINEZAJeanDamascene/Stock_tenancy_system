const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const StockMovement = require('../models/StockMovement');
const Client = require('../models/Client');
const Supplier = require('../models/Supplier');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const Purchase = require('../models/Purchase');
const Budget = require('../models/Budget');
const Company = require('../models/Company');
const FixedAsset = require('../models/FixedAsset');
const Loan = require('../models/Loan');
const CreditNote = require('../models/CreditNote');
const Expense = require('../models/Expense');
const PurchaseReturn = require('../models/PurchaseReturn');
const cacheService = require('../services/cacheService');
const { BankAccount, BankTransaction } = require('../models/BankAccount');
const reportGeneratorService = require('../services/reportGeneratorService');
const pdfRenderer = require('../utils/pdfRenderer');

// Shared helper: declining-balance rate (mirrors FixedAsset model logic)
function _dbRateReport(cost, salvage, years) {
  if (salvage > 0 && cost > 0) return 1 - Math.pow(salvage / cost, 1 / years);
  return 2 / years;
}

// Shared helper: calculate total depreciation expense for a list of fixed assets
// within a specific reporting period. Respects the "1st of purchase month" start rule.
// P&L uses this so that: annual P&L shows the full annual slice (same every year for SL),
// and partial periods show a proportional monthly amount.
function calculateDepreciationForPeriod(assets, periodStart, periodEnd) {
  let total = 0;

  assets.forEach(asset => {
    if (!asset.purchaseDate || !asset.purchaseCost || !asset.usefulLifeYears) return;

    const purchaseDate = new Date(asset.purchaseDate);
    // Snap to 1st of purchase month — use UTC getters to avoid timezone day-shift
    // when dates are stored as "YYYY-MM-01T00:00:00.000Z" (UTC midnight)
    const depStart    = new Date(Date.UTC(purchaseDate.getUTCFullYear(), purchaseDate.getUTCMonth(), 1));
    const totalMonths = asset.usefulLifeYears * 12;
    // Depreciation ends at 1st of the month after useful life expires
    const depEnd = new Date(Date.UTC(depStart.getUTCFullYear(), depStart.getUTCMonth() + totalMonths, 1));

    const depreciable = (asset.purchaseCost || 0) - (asset.salvageValue || 0);
    if (depreciable <= 0) return;

    // Work in absolute month indices (year * 12 + month) — all UTC
    const depStartAbs    = depStart.getUTCFullYear()    * 12 + depStart.getUTCMonth();
    const depEndAbs      = depEnd.getUTCFullYear()      * 12 + depEnd.getUTCMonth();
    const periodStartAbs = periodStart.getUTCFullYear() * 12 + periodStart.getUTCMonth();
    const periodEndAbs   = periodEnd.getUTCFullYear()   * 12 + periodEnd.getUTCMonth();

    const overlapStart = Math.max(depStartAbs, periodStartAbs);
    const overlapEnd   = Math.min(depEndAbs, periodEndAbs + 1); // inclusive end month

    if (overlapEnd <= overlapStart) return; // no overlap

    // Sum monthly depreciation for each month in the overlap
    for (let abs = overlapStart; abs < overlapEnd; abs++) {
      const monthsIntoLife = abs - depStartAbs;
      if (monthsIntoLife < 0 || monthsIntoLife >= totalMonths) continue;

      const yearIdx = Math.floor(monthsIntoLife / 12); // 0-indexed year in asset's life

      let monthlyDep = 0;
      switch (asset.depreciationMethod || 'straight-line') {
        case 'straight-line':
          monthlyDep = depreciable / totalMonths;
          break;
        case 'sum-of-years': {
          const syd = (asset.usefulLifeYears * (asset.usefulLifeYears + 1)) / 2;
          const remainingLife = asset.usefulLifeYears - yearIdx;
          monthlyDep = (depreciable * remainingLife) / syd / 12;
          break;
        }
        case 'declining-balance': {
          const rate = _dbRateReport(asset.purchaseCost, asset.salvageValue || 0, asset.usefulLifeYears);
          let bv = asset.purchaseCost;
          for (let y = 0; y < yearIdx; y++) {
            const dep = Math.min(bv * rate, Math.max(0, bv - (asset.salvageValue || 0)));
            bv -= dep;
          }
          const yearlyDep = Math.min(bv * rate, Math.max(0, bv - (asset.salvageValue || 0)));
          monthlyDep = yearlyDep / 12;
          break;
        }
        default:
          monthlyDep = depreciable / totalMonths;
      }
      total += monthlyDep;
    }
  });

  return total;
}

// Shared helper: calculates interest expense for a list of active loans within a reporting period.
// Handles both simple interest (fixed monthly interest on outstanding balance) and
// compound/EMI interest (amortizing schedule – interest portion of each EMI).
function calculateLoanInterest(loans, periodStart, periodEnd) {
  let interestExpense = 0;

  loans.forEach(loan => {
    const loanStart  = new Date(loan.startDate);
    const loanEnd    = loan.endDate ? new Date(loan.endDate) : null;
    const method     = loan.interestMethod || 'simple';
    const annualRate = loan.interestRate   || 0;
    const r          = annualRate / 100 / 12; // monthly rate

    if (method === 'compound' && loan.durationMonths && r > 0) {
      // ── COMPOUND / EMI ────────────────────────────────────────────────────
      // Walk the full amortization schedule; sum interest only for months that
      // fall inside the reporting period.
      const n   = loan.durationMonths;
      const P   = loan.originalAmount;
      const emi = P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);

      let balance = P;
      for (let m = 0; m < n; m++) {
        const monthDate  = new Date(loanStart);
        monthDate.setMonth(monthDate.getMonth() + m);

        const interest    = balance * r;
        const principal   = emi - interest;

        const mY = monthDate.getFullYear(), mM = monthDate.getMonth();
        const sY = periodStart.getFullYear(), sM = periodStart.getMonth();
        const eY = periodEnd.getFullYear(),   eM = periodEnd.getMonth();

        const afterStart = (mY > sY) || (mY === sY && mM >= sM);
        const beforeEnd  = (mY < eY) || (mY === eY && mM <= eM);

        if (afterStart && beforeEnd) interestExpense += interest;

        balance -= principal;
        if (balance < 0.01) break;
      }
    } else {
      // ── SIMPLE INTEREST ───────────────────────────────────────────────────
      // For simple interest the FULL interest for the entire loan duration is
      // recognised immediately (front-loaded) — both in P&L and Balance Sheet.
      // We still clamp to the reporting period to avoid including loans that
      // haven't started yet or have already ended.
      const effectiveStart = loanStart > periodStart ? loanStart : periodStart;
      const effectiveEnd   = (loanEnd && loanEnd < periodEnd) ? loanEnd : periodEnd;

      if (effectiveEnd < effectiveStart) return; // not active in this period

      // Use the full contractual duration, not just the reporting-period slice.
      // Fall back to the clamped window only when durationMonths is not recorded.
      const totalDurationMonths = loan.durationMonths || Math.max(1,
        ((effectiveEnd.getFullYear() - effectiveStart.getFullYear()) * 12 +
          effectiveEnd.getMonth() - effectiveStart.getMonth()) + 1
      );

      // Simple interest: full interest for entire loan term, recognised immediately
      const monthlyInterest = (loan.originalAmount * annualRate / 100) / 12;
      interestExpense += monthlyInterest * totalDurationMonths;
    }
  });

  return interestExpense;
}

// Shared helper: computes NET PROFIT (AFTER TAX) using the EXACT same logic as getProfitAndLossFull.
// This ensures Balance Sheet → Equity → Current Period Profit always matches P&L → Net Profit (After Tax).
// Any change to the P&L formula will automatically be reflected in the Balance Sheet.
async function computeCurrentPeriodProfit(companyId, periodStart, periodEnd) {
  // ── REVENUE ──────────────────────────────────────────────────────────────
  const paidInvoices = await Invoice.find({
    company: companyId,
    status: 'paid',
    paidDate: { $gte: periodStart, $lte: periodEnd }
  }).populate('items.product', 'averageCost');

  const salesRevenueExVAT = paidInvoices.reduce((sum, inv) => sum + (inv.subtotal || 0), 0);
  const discountsGiven = paidInvoices.reduce((sum, inv) => sum + (inv.totalDiscount || 0), 0);

  const creditNotes = await CreditNote.find({
    company: companyId,
    status: { $in: ['issued', 'applied', 'refunded', 'partially_refunded'] },
    issueDate: { $gte: periodStart, $lte: periodEnd }
  });
  const salesReturns = creditNotes.reduce((sum, cn) => sum + (cn.subtotal || 0), 0);

  const netRevenue = salesRevenueExVAT - salesReturns - discountsGiven;

  // ── COGS ─────────────────────────────────────────────────────────────────
  const purchases = await Purchase.find({
    company: companyId,
    status: { $in: ['received', 'paid'] },
    purchaseDate: { $gte: periodStart, $lte: periodEnd }
  });
  const purchasesExVAT = purchases.reduce((sum, p) => sum + (p.subtotal || 0) - (p.totalDiscount || 0), 0);

  const purchaseReturnsData = await PurchaseReturn.aggregate([
    {
      $match: {
        company: companyId,
        status: { $in: ['approved', 'refunded'] },
        returnDate: { $gte: periodStart, $lte: periodEnd }
      }
    },
    { $group: { _id: null, subtotal: { $sum: '$subtotal' } } }
  ]);
  const purchaseReturns = purchaseReturnsData[0]?.subtotal || 0;

  const products = await Product.find({ company: companyId, isArchived: false });
  const closingStockValue = products.reduce((sum, p) => sum + (p.currentStock * p.averageCost), 0);

  // openingStockValue defaults to 0 (same as P&L Full when no previousPeriod provided)
  const totalCOGS = purchasesExVAT - purchaseReturns - closingStockValue;

  const grossProfit = netRevenue - totalCOGS;

  // ── OPERATING EXPENSES (from Expense model – mirrors P&L Full exactly) ──
  const expenseSummary = await Expense.aggregate([
    {
      $match: {
        company: companyId,
        status: { $ne: 'cancelled' }
        // No date filter – matches P&L Full behaviour
      }
    },
    { $group: { _id: '$type', total: { $sum: '$amount' } } }
  ]);

  const expenseData = {};
  expenseSummary.forEach(item => { expenseData[item._id] = item.total; });

  const salariesWages         = expenseData['salaries_wages'] || 0;
  const rent                  = expenseData['rent'] || 0;
  const utilities             = expenseData['utilities'] || 0;
  const transportDelivery     = expenseData['transport_delivery'] || 0;
  const marketingAdvertising  = expenseData['marketing_advertising'] || 0;
  const otherExpenses         = expenseData['other_expense'] || 0;

  // Depreciation — period-aware, starts from 1st of purchase month
  const fixedAssets = await FixedAsset.find({ company: companyId, status: 'active' });
  const depreciationExpense = calculateDepreciationForPeriod(fixedAssets, periodStart, periodEnd);

  const totalOperatingExpenses =
    salariesWages + rent + utilities + transportDelivery +
    marketingAdvertising + depreciationExpense + otherExpenses;

  const operatingProfit = grossProfit - totalOperatingExpenses;

  // ── OTHER INCOME / EXPENSES ───────────────────────────────────────────────
  const interestIncome        = expenseData['interest_income'] || 0;
  const otherIncome           = expenseData['other_income'] || 0;
  const otherExpenseFromModule = expenseData['other_expense_income'] || 0;

  const activeLoans = await Loan.find({
    company: companyId,
    status: 'active',
    startDate: { $lte: periodEnd },
    $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: periodStart } }]
  });
  const interestExpense = calculateLoanInterest(activeLoans, periodStart, periodEnd);

  const netOtherIncome = interestIncome + otherIncome - interestExpense - otherExpenseFromModule;

  // ── PROFIT BEFORE TAX ─────────────────────────────────────────────────────
  const profitBeforeTax = operatingProfit + netOtherIncome;

  // ── CORPORATE INCOME TAX (30%) ────────────────────────────────────────────
  const corporateIncomeTax = Math.max(0, profitBeforeTax * 0.30);

  // ── NET PROFIT (AFTER TAX) ────────────────────────────────────────────────
  const netProfit = profitBeforeTax - corporateIncomeTax;

  return {
    netProfit,
    corporateIncomeTax,
    profitBeforeTax,
    netRevenue,
    grossProfit,
    invoicesConsidered: paidInvoices.length
  };
}
// @desc    Get stock valuation report
// @route   GET /api/reports/stock-valuation
// @access  Private
exports.getStockValuationReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { categoryId } = req.query;
    const cacheKey = { companyId, categoryId: categoryId || 'all' };
    
    const cached = await cacheService.fetchOrExecute(
      'stock',
      async () => {
        const query = { isArchived: false, company: companyId };
        if (categoryId) {
          query.category = categoryId;
        }

        const products = await Product.find(query)
          .populate('category', 'name')
          .sort({ name: 1 });

        const report = products.map(product => ({
          sku: product.sku,
          name: product.name,
          category: product.category?.name,
          unit: product.unit,
          currentStock: product.currentStock,
          averageCost: product.averageCost,
          totalValue: product.currentStock * product.averageCost
        }));

        const totalValue = report.reduce((sum, item) => sum + item.totalValue, 0);

        return {
          items: report,
          summary: {
            totalProducts: report.length,
            totalValue
          }
        };
      },
      cacheKey,
      { ttl: 60, useCompanyPrefix: true } // 1 minute cache - stock changes frequently
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales summary report
// @route   GET /api/reports/sales-summary
// @access  Private
exports.getSalesSummaryReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, clientId } = req.query;
    const cacheKey = { companyId, startDate, endDate, clientId };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const query = { status: { $in: ['paid', 'partial'] }, company: companyId };

        if (startDate || endDate) {
          query.invoiceDate = {};
          if (startDate) query.invoiceDate.$gte = new Date(startDate);
          if (endDate) query.invoiceDate.$lte = new Date(endDate);
        }

        if (clientId) {
          query.client = clientId;
        }

        const invoices = await Invoice.find(query)
          .populate('client', 'name code')
          .populate('items.product', 'name sku')
          .sort({ invoiceDate: -1 });

        const summary = {
          totalInvoices: invoices.length,
          totalSales: invoices.reduce((sum, inv) => sum + inv.grandTotal, 0),
          totalPaid: invoices.reduce((sum, inv) => sum + inv.amountPaid, 0),
          totalDiscount: invoices.reduce((sum, inv) => sum + inv.totalDiscount, 0),
          totalTax: invoices.reduce((sum, inv) => sum + inv.totalTax, 0)
        };

        // Sales by product
        const productSales = {};
        invoices.forEach(invoice => {
          invoice.items.forEach(item => {
            const productId = item.product?._id?.toString();
            if (!productSales[productId]) {
              productSales[productId] = {
                product: item.product,
                quantity: 0,
                revenue: 0
              };
            }
            productSales[productId].quantity += item.quantity;
            productSales[productId].revenue += item.total;
          });
        });

        return {
          invoices,
          summary,
          productSales: Object.values(productSales)
        };
      },
      cacheKey,
      { ttl: 120, useCompanyPrefix: true } // 2 minute cache
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get product movement report
// @route   GET /api/reports/product-movement
// @access  Private
exports.getProductMovementReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, productId, type } = req.query;
    const query = { company: companyId };

    if (startDate || endDate) {
      query.movementDate = {};
      if (startDate) query.movementDate.$gte = new Date(startDate);
      if (endDate) query.movementDate.$lte = new Date(endDate);
    }

    if (productId) {
      query.product = productId;
    }

    if (type) {
      query.type = type;
    }

    const movements = await StockMovement.find(query)
      .populate('product', 'name sku unit')
      .populate('supplier', 'name code')
      .populate('performedBy', 'name email')
      .sort({ movementDate: -1 });

    const summary = {
      totalMovements: movements.length,
      totalIn: movements.filter(m => m.type === 'in').reduce((sum, m) => sum + m.quantity, 0),
      totalOut: movements.filter(m => m.type === 'out').reduce((sum, m) => sum + m.quantity, 0),
      totalCost: movements.reduce((sum, m) => sum + (m.totalCost || 0), 0)
    };

    res.json({
      success: true,
      data: {
        movements,
        summary
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client sales report
// @route   GET /api/reports/client-sales
// @access  Private
exports.getClientSalesReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    const cacheKey = { companyId, startDate, endDate };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const matchStage = { status: { $in: ['paid', 'partial'] }, company: companyId };

        if (startDate || endDate) {
          matchStage.invoiceDate = {};
          if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
          if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
        }

        const clientSales = await Invoice.aggregate([
          { $match: matchStage },
          { $group: {
            _id: '$client',
            totalInvoices: { $sum: 1 },
            totalSales: { $sum: '$grandTotal' },
            totalPaid: { $sum: '$amountPaid' },
            totalBalance: { $sum: '$balance' }
          }},
          { $sort: { totalSales: -1 } }
        ]);

        await Client.populate(clientSales, { 
          path: '_id', 
          select: 'name code contact type'
        });

        return clientSales;
      },
      cacheKey,
      { ttl: 120, useCompanyPrefix: true } // 2 minute cache
    );

    res.json({
      success: true,
      count: cached.data.length,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get profit and loss report (gross margin, net profit)
// @route   GET /api/reports/profit-and-loss
// @access  Private
exports.getProfitAndLossReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    
    // NO CACHING for P&L - used by Balance Sheet for Current Period Profit
    // Must always reflect real-time data

    // For Profit & Loss, we only consider PAID invoices
    // Revenue is only recognized when payment is received
    const invMatch = { status: 'paid', company: companyId };
    if (startDate || endDate) {
      invMatch.invoiceDate = {};
      if (startDate) invMatch.invoiceDate.$gte = new Date(startDate);
      if (endDate) invMatch.invoiceDate.$lte = new Date(endDate);
    }

    const invoices = await Invoice.find(invMatch).populate('items.product', 'averageCost');

    // Total Revenue: Sum of all paid invoice amounts (INCLUDING tax)
    // Revenue includes tax - tax will be subtracted as expense
    const revenue = invoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);

    // COGS (Cost of Goods Sold): Sum of cost price × quantity sold for all products on paid invoices
    // We use the product's averageCost as the cost price (this is the best available approximation)
    let cogs = 0;
    invoices.forEach(inv => {
      inv.items.forEach(item => {
        const costPrice = item.product?.averageCost || 0;
        cogs += (costPrice * (item.quantity || 0));
      });
    });

    // Gross Profit = Revenue - COGS
    const grossProfit = revenue - cogs;

    // Gross Margin % = (Gross Profit / Revenue) × 100
    const grossMarginPercent = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

    // NOTE: Purchase Expenses are NOT included in P&L
    // In accrual accounting, purchases are recorded as Assets (Inventory) in the Balance Sheet
    // Only COGS (Cost of Goods Sold) is recorded as expense when products are sold
    const purchaseExpenses = 0;

    // Taxes: Sum of actual tax amounts recorded on each paid invoice
    const taxes = invoices.reduce((sum, inv) => sum + (inv.totalTax || 0), 0);

    // Discounts: Sum of all discounts applied on paid invoices in this period
    const discounts = invoices.reduce((sum, inv) => sum + (inv.totalDiscount || 0), 0);

    // Net Profit = Gross Profit - Taxes - Discounts
    // (Purchase expenses removed - purchases are now assets, not expenses)
    const netProfit = grossProfit - taxes - discounts;

    // Net Margin % = (Net Profit / Revenue) × 100
    const netMarginPercent = revenue > 0 ? (netProfit / revenue) * 100 : 0;

    res.json({
      success: true,
      data: {
        revenue,
        cogs,
        grossProfit,
        grossMarginPercent: Math.round(grossMarginPercent * 100) / 100,
        purchaseExpenses,
        taxes,
        discounts,
        netProfit,
        netMarginPercent: Math.round(netMarginPercent * 100) / 100,
        invoicesCount: invoices.length
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get detailed Profit & Loss Statement (Comprehensive)
// @route   GET /api/reports/profit-and-loss-detailed
// @access  Private
exports.getProfitAndLossDetailed = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    
    // Set default period to current quarter if not provided
    const now = new Date();
    const periodStart = startDate ? new Date(startDate) : new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const periodEnd = endDate ? new Date(endDate) : new Date();
    
    // Get company info
    const company = await Company.findById(companyId);
    const companyName = company?.name || 'N/A';
    const companyTin = company?.tin || 'N/A';
    
    // =============================================
    // REVENUE SECTION
    // =============================================
    
    // Sales Revenue (excluding VAT) - Cash-basis: revenue recognised when payment is received.
    // Use paidDate (not invoiceDate) so that invoices issued before the period but paid
    // within it are correctly included, and unpaid invoices are excluded.
    const salesInvoiceMatch = { 
      status: 'paid', 
      company: companyId,
      paidDate: { $gte: periodStart, $lte: periodEnd }
    };
    
    const paidInvoices = await Invoice.find(salesInvoiceMatch).populate('items.product', 'averageCost');
    
    // Sales Revenue (ex. VAT) = Gross sales before discounts (subtotal is pre-discount, pre-tax)
    // Discounts are shown as a separate line below, so do NOT subtract them here
    const salesRevenueExVAT = paidInvoices.reduce((sum, inv) => {
      return sum + (inv.subtotal || 0);
    }, 0);
    
    // Sales Returns (Credit Notes issued) in period
    const creditNoteMatch = {
      company: companyId,
      status: { $in: ['issued', 'applied', 'refunded', 'partially_refunded'] },
      issueDate: { $gte: periodStart, $lte: periodEnd }
    };
    
    const creditNotes = await CreditNote.find(creditNoteMatch);
    const salesReturns = creditNotes.reduce((sum, cn) => sum + (cn.subtotal || 0), 0);
    
    // Discounts Given - from paid invoices (item-level discounts + invoice-level discounts)
    const discountsGiven = paidInvoices.reduce((sum, inv) => sum + (inv.totalDiscount || 0), 0);
    
    // NET REVENUE = Sales Revenue - Sales Returns - Discounts
    const netRevenue = salesRevenueExVAT - salesReturns - discountsGiven;
    
    // =============================================
    // COST OF GOODS SOLD (COGS) SECTION
    // =============================================
    
    // For COGS, we calculate from ACTUAL items sold on paid invoices
    // This is more accurate than the inventory method which requires historical data
    
    const products = await Product.find({ company: companyId, isArchived: false });
    
    // Opening Stock: simply use 0 - stock returns only affect Closing Stock
    const openingStockValue = 0;
    
    // Purchases (ex. VAT) - from RECEIVED/PAID purchases in period
    const purchaseMatch = {
      company: companyId,
      status: { $in: ['received', 'paid'] },
      purchaseDate: { $gte: periodStart, $lte: periodEnd }
    };
    
    const purchases = await Purchase.find(purchaseMatch);
    const purchasesExVAT = purchases.reduce((sum, p) => {
      return sum + (p.subtotal || 0) - (p.totalDiscount || 0);
    }, 0);

    // Purchase Returns (ex. VAT) - approved/refunded purchase returns in period
    const purchaseReturnMatchDetailed = {
      company: companyId,
      status: { $in: ['approved', 'refunded', 'partially_refunded'] },
      returnDate: { $gte: periodStart, $lte: periodEnd }
    };
    const purchaseReturnsAggDetailed = await PurchaseReturn.aggregate([
      { $match: purchaseReturnMatchDetailed },
      { $group: { _id: null, subtotal: { $sum: '$subtotal' }, count: { $sum: 1 } } }
    ]);
    const purchaseReturnsDetailed = purchaseReturnsAggDetailed[0]?.subtotal || 0;
    const purchaseReturnsCountDetailed = purchaseReturnsAggDetailed[0]?.count || 0;
    
    // Closing Stock Value (current inventory)
    const closingStockValue = products.reduce((sum, product) => {
      return sum + (product.currentStock * product.averageCost);
    }, 0);
    
    // COGS: Opening Stock + Purchases - Purchase Returns - Closing Stock
    const totalCOGS = openingStockValue + purchasesExVAT - purchaseReturnsDetailed - closingStockValue;
    
    // =============================================
    // GROSS PROFIT
    // =============================================
    const grossProfit = netRevenue - totalCOGS;
    const grossMarginPercent = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;
    
    // =============================================
    // OPERATING EXPENSES
    // =============================================
    
    // 1. Depreciation — period-aware, starts from 1st of purchase month
    const fixedAssets = await FixedAsset.find({ company: companyId, status: 'active' });
    const depreciationExpense = calculateDepreciationForPeriod(fixedAssets, periodStart, periodEnd);
    
    // 2. Interest Expense (from Loans)
    const loanMatch = {
      company: companyId,
      status: 'active',
      startDate: { $lte: periodEnd },
      $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: periodStart } }]
    };
    const activeLoans = await Loan.find(loanMatch);

    // Calculate interest expense for the period (prorated, on outstanding balance)
    const interestExpense = calculateLoanInterest(activeLoans, periodStart, periodEnd);
    
    // 3. Transport & Delivery (from invoice shipping/transport if tracked)
    // Note: Not currently in invoice model, set to 0
    const transportDelivery = 0;
    
    // 4. VAT Expense (Output VAT - Input VAT) for the period
    // Output VAT from sales
    const outputVAT = paidInvoices.reduce((sum, inv) => sum + (inv.totalTax || 0), 0);
    // Input VAT from purchases
    const inputVAT = purchases.reduce((sum, p) => sum + (p.totalTax || 0), 0);
    // Net VAT = Output VAT - Input VAT (if positive, you owe VAT to RRA; if negative, you have VAT credit/receivable from RRA)
    const vatLiability = outputVAT - inputVAT;
    
    // For now, we'll set other operating expenses to 0 
    // In a full system, you'd have an Expense model to track these
    const salariesWages = 0;
    const rent = 0;
    const utilities = 0;
    const marketingAdvertising = 0;
    const otherExpenses = 0;
    
    const totalOperatingExpenses = 
      salariesWages + 
      rent + 
      utilities + 
      transportDelivery + 
      marketingAdvertising + 
      depreciationExpense + 
      otherExpenses;
    
    // =============================================
    // OPERATING PROFIT (EBIT)
    // =============================================
    const operatingProfit = grossProfit - totalOperatingExpenses;
    const operatingMarginPercent = netRevenue > 0 ? (operatingProfit / netRevenue) * 100 : 0;
    
    // =============================================
    // OTHER INCOME / EXPENSES
    // =============================================
    
    // Interest Income (could be from deposits - not currently tracked)
    const interestIncome = 0;
    
    // Other Income (not currently tracked)
    const otherIncome = 0;
    
    // Other Expense (not currently tracked)
    const otherExpense = 0;
    
    const netOtherIncome = interestIncome - interestExpense + otherIncome - otherExpense;
    
    // =============================================
    // PROFIT BEFORE TAX (PBT)
    // =============================================
    const profitBeforeTax = operatingProfit + netOtherIncome;
    
    // =============================================
    // TAX
    // =============================================
    
    // VAT is collected on behalf of RRA - it's neither income nor expense
    // It appears on the Balance Sheet as either a liability (VAT Payable) or asset (VAT Receivable)
    // Therefore, we set vatExpense to 0 for P&L purposes - it does NOT affect profit
    const vatExpense = 0;
    
    // Corporate Income Tax (30% of Profit Before Tax)
    const corporateTaxRate = 0.30;
    const corporateIncomeTax = Math.max(0, profitBeforeTax * corporateTaxRate);
    
    const totalTax = vatExpense + corporateIncomeTax;

    // =============================================
    // NET PROFIT (AFTER TAX)
    // Use formula-based COGS for consistency with the display
    // =============================================
    let netProfit = profitBeforeTax - totalTax;
    
    // Use the formula-based approach for net profit (same as COGS calculation above)
    // This ensures NET PROFIT is dynamic and consistent with the report display
    const netProfitFromFormula = netRevenue - totalCOGS - totalOperatingExpenses + netOtherIncome - corporateIncomeTax;
    netProfit = netProfitFromFormula;
    const netMarginPercent = netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0;
    
    // =============================================
    // RESPONSE
    // =============================================
    res.json({
      success: true,
      data: {
        // Header
        company: {
          name: companyName,
          tin: companyTin
        },
        period: {
          start: periodStart,
          end: periodEnd,
          formatted: `${periodStart.toLocaleDateString('en-GB')} - ${periodEnd.toLocaleDateString('en-GB')}`
        },
        
        // REVENUE
        revenue: {
          salesRevenueExVAT: Math.round(salesRevenueExVAT * 100) / 100,
          salesReturns: Math.round(salesReturns * 100) / 100,
          discountsGiven: Math.round(discountsGiven * 100) / 100,
          netRevenue: Math.round(netRevenue * 100) / 100
        },
        
        // COST OF GOODS SOLD
        cogs: {
          openingStockValue: Math.round(openingStockValue * 100) / 100,
          purchasesExVAT: Math.round(purchasesExVAT * 100) / 100,
          purchaseReturns: Math.round(purchaseReturnsDetailed * 100) / 100,
          closingStockValue: Math.round(closingStockValue * 100) / 100,
          totalCOGS: Math.round(totalCOGS * 100) / 100
        },
        
        // GROSS PROFIT
        grossProfit: {
          amount: Math.round(grossProfit * 100) / 100,
          marginPercent: Math.round(grossMarginPercent * 100) / 100
        },
        
        // OPERATING EXPENSES
        operatingExpenses: {
          salariesAndWages: salariesWages,
          rent: rent,
          utilities: utilities,
          transportAndDelivery: transportDelivery,
          marketingAndAdvertising: marketingAdvertising,
          depreciation: Math.round(depreciationExpense * 100) / 100,
          otherExpenses: otherExpenses,
          total: Math.round(totalOperatingExpenses * 100) / 100
        },
        
        // OPERATING PROFIT (EBIT)
        operatingProfit: {
          amount: Math.round(operatingProfit * 100) / 100,
          marginPercent: Math.round(operatingMarginPercent * 100) / 100
        },
        
        // OTHER INCOME / EXPENSES
        otherIncomeExpenses: {
          interestIncome: interestIncome,
          interestExpense: Math.round(interestExpense * 100) / 100,
          otherIncome: otherIncome,
          otherExpense: otherExpense,
          netOtherIncome: Math.round(netOtherIncome * 100) / 100
        },
        
        // PROFIT BEFORE TAX
        profitBeforeTax: {
          amount: Math.round(profitBeforeTax * 100) / 100
        },
        
        // TAX
        tax: {
          vatLiability: Math.round(vatExpense * 100) / 100,
          outputVAT: Math.round(outputVAT * 100) / 100,
          inputVAT: Math.round(inputVAT * 100) / 100,
          corporateIncomeTax: Math.round(corporateIncomeTax * 100) / 100,
          corporateTaxRate: corporateTaxRate * 100,
          totalTax: Math.round(totalTax * 100) / 100
        },
        
        // NET PROFIT
        netProfit: {
          amount: Math.round(netProfit * 100) / 100,
          marginPercent: Math.round(netMarginPercent * 100) / 100
        },
        
        // Summary for Balance Sheet integration
        balanceSheetFlow: {
          currentPeriodProfit: Math.round(netProfit * 100) / 100,
          flowsToEquity: true
        },
        
        // Additional details
        details: {
          paidInvoicesCount: paidInvoices.length,
          creditNotesCount: creditNotes.length,
          purchasesCount: purchases.length,
          purchaseReturnsCount: purchaseReturnsCountDetailed,
          fixedAssetsCount: fixedAssets.length,
          activeLoansCount: activeLoans.length,
          productsCount: products.length
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get aging report (receivables or payables)
// @route   GET /api/reports/aging
// @access  Private
exports.getAgingReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { type = 'receivables' } = req.query; // type: receivables|payables
    const cacheKey = { companyId, type };
    const now = new Date();
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        if (type === 'receivables') {
          const invoices = await Invoice.find({ balance: { $gt: 0 }, company: companyId }).populate('client', 'name');

          const buckets = { current: [], '1-30': [], '31-60': [], '61-90': [], '90+': [] };

          invoices.forEach(inv => {
            const due = inv.dueDate || inv.invoiceDate;
            const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
            const entry = { invoice: inv, balance: inv.balance, days };

            if (days <= 0) buckets.current.push(entry);
            else if (days <= 30) buckets['1-30'].push(entry);
            else if (days <= 60) buckets['31-60'].push(entry);
            else if (days <= 90) buckets['61-90'].push(entry);
            else buckets['90+'].push(entry);
          });

          return { count: invoices.length, buckets };
        } else {
          // payables
          const purchases = await Purchase.find({ balance: { $gt: 0 }, company: companyId }).populate('supplier', 'name');
          const buckets = { current: [], '1-30': [], '31-60': [], '61-90': [], '90+': [] };

          purchases.forEach(p => {
            const due = p.expectedDeliveryDate || p.purchaseDate;
            const days = Math.floor((now - new Date(due)) / (1000 * 60 * 60 * 24));
            const entry = { purchase: p, balance: p.balance, days };

            if (days <= 0) buckets.current.push(entry);
            else if (days <= 30) buckets['1-30'].push(entry);
            else if (days <= 60) buckets['31-60'].push(entry);
            else if (days <= 90) buckets['61-90'].push(entry);
            else buckets['90+'].push(entry);
          });

          return { count: purchases.length, buckets };
        }
      },
      cacheKey,
      { ttl: 120, useCompanyPrefix: true } // 2 minute cache
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    VAT summary report
// @route   GET /api/reports/vat-summary
// @access  Private
exports.getVATSummaryReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, recalculate } = req.query;
    const cacheKey = { companyId, startDate, endDate };
    
    // If recalculate flag is set, fix tax codes in invoices first
    if (recalculate === 'true') {
      await fixTaxCodesInInvoices(companyId);
    }
    
    const cached = await cacheService.fetchOrExecute(
      'report_vat_summary_v4',
      async () => {
        const match = { status: { $in: ['paid', 'partial', 'confirmed'] }, company: companyId };
        if (startDate || endDate) {
          match.invoiceDate = {};
          if (startDate) match.invoiceDate.$gte = new Date(startDate);
          if (endDate) match.invoiceDate.$lte = new Date(endDate);
        }

        const agg = await Invoice.aggregate([
          { $match: match },
          { $unwind: '$items' },
          { $group: {
            _id: { $ifNull: ['$items.taxCode', 'None'] },
            taxableBase: { $sum: { $subtract: [
              { $multiply: [{ $ifNull: ['$items.quantity', 0] }, { $ifNull: ['$items.unitPrice', 0] }] },
              { $ifNull: ['$items.discount', 0] }
            ]} },
            taxAmount: { $sum: { $ifNull: ['$items.taxAmount', 0] } }
          } }
        ]);

        const summary = {};
        agg.forEach(a => {
          const taxCode = a._id;
          if (taxCode && (a.taxableBase > 0 || a.taxAmount > 0)) {
            summary[taxCode] = { 
              taxableBase: Math.round((a.taxableBase || 0) * 100) / 100, 
              taxAmount: Math.round((a.taxAmount || 0) * 100) / 100 
            };
          }
        });

        return { summary };
      },
      cacheKey,
      { ttl: 30, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to fix tax codes in invoices based on taxRate
async function fixTaxCodesInInvoices(companyId) {
  try {
    // Find all invoices with items that have incorrect taxCode
    const invoices = await Invoice.find({ 
      company: companyId,
      status: { $in: ['paid', 'partial', 'confirmed'] }
    });

    let fixedCount = 0;
    for (const invoice of invoices) {
      let needsSave = false;
      
      for (const item of invoice.items) {
        // Determine correct taxCode based on taxRate
        // If taxRate is 0 or undefined, it should be 'A' (exempt)
        // If taxRate > 0, it should be 'B' (18%)
        const taxRate = item.taxRate || 0;
        
        if (taxRate === 0 && item.taxCode !== 'A') {
          item.taxCode = 'A';
          needsSave = true;
        } else if (taxRate > 0 && item.taxCode !== 'B') {
          item.taxCode = 'B';
          needsSave = true;
        }
      }
      
      if (needsSave) {
        // Recalculate totals before saving
        invoice.markModified('items');
        await invoice.save();
        fixedCount++;
      }
    }
    
    console.log(`Fixed tax codes in ${fixedCount} invoices`);
    return fixedCount;
  } catch (error) {
    console.error('Error fixing tax codes:', error);
    throw error;
  }
}

// @desc    Product performance (sales, quantity, margin)
// @route   GET /api/reports/product-performance
// @access  Private
exports.getProductPerformanceReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, limit = 50 } = req.query;
    const cacheKey = { companyId, startDate, endDate, limit };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const match = { status: { $in: ['paid', 'partial', 'confirmed'] }, company: companyId };
        if (startDate || endDate) {
          match.invoiceDate = {};
          if (startDate) match.invoiceDate.$gte = new Date(startDate);
          if (endDate) match.invoiceDate.$lte = new Date(endDate);
        }

        const agg = await Invoice.aggregate([
          { $match: match },
          { $unwind: '$items' },
          { $group: {
            _id: '$items.product',
            quantitySold: { $sum: '$items.quantity' },
            revenue: { $sum: '$items.totalWithTax' }
          } },
          { $sort: { revenue: -1 } },
          { $limit: parseInt(limit, 10) }
        ]);

        // populate product and compute margin
        const populated = await Product.populate(agg, { path: '_id', select: 'name sku averageCost' });
        const report = populated.map(row => {
          const avgCost = row._id?.averageCost || 0;
          const cogs = avgCost * (row.quantitySold || 0);
          const margin = (row.revenue || 0) - cogs;
          return {
            product: row._id,
            quantitySold: row.quantitySold,
            revenue: row.revenue,
            cogs,
            margin
          };
        });

        return { count: report.length, data: report };
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true } // 5 minute cache
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Customer Lifetime Value (CLV)
// @route   GET /api/reports/clv
// @access  Private
exports.getCLVReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { limit = 100 } = req.query;
    const cacheKey = { companyId, limit };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const match = { status: { $in: ['paid', 'partial', 'confirmed'] }, company: companyId };

        const agg = await Invoice.aggregate([
          { $match: match },
          { $group: {
            _id: '$client',
            totalSales: { $sum: '$grandTotal' },
            orders: { $sum: 1 },
            avgOrder: { $avg: '$grandTotal' },
            firstOrder: { $min: '$invoiceDate' },
            lastOrder: { $max: '$invoiceDate' }
          } },
          { $sort: { totalSales: -1 } },
          { $limit: parseInt(limit, 10) }
        ]);

        await Client.populate(agg, { path: '_id', select: 'name code contact' });

        return { count: agg.length, data: agg };
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true } // 5 minute cache
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Financial Ratios & KPIs
// @route   GET /api/reports/financial-ratios
// @access  Private
exports.getFinancialRatios = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { asOfDate, startDate, endDate } = req.query;

    const asOf = asOfDate ? new Date(asOfDate) : new Date();
    const periodStart = startDate ? new Date(startDate) : new Date(asOf.getFullYear(), 0, 1);
    const periodEnd = endDate ? new Date(endDate) : asOf;

    // Get basic P&L figures using existing helper to ensure consistency
    const pl = await computeCurrentPeriodProfit(companyId, periodStart, periodEnd);
    const netProfit = pl.netProfit || 0;
    const profitBeforeTax = pl.profitBeforeTax || 0;
    const netRevenue = pl.netRevenue || 0;
    const grossProfit = pl.grossProfit || 0;

    // Get Balance Sheet aggregates (minimal set) to compute ratios
    // Use same logic as Balance Sheet for consistency
    const [invoiceAgg, purchaseAgg, productAgg, fixedAssets, loansAgg, company] = await Promise.all([
      Invoice.aggregate([
        { $match: { company: companyId } },
        { $facet: {
          payments: [ { $unwind: '$payments' }, { $group: { _id: null, total: { $sum: '$payments.amount' } } } ],
          receivables: [ { $match: { status: { $in: ['draft','confirmed','partial'] } } }, { $group: { _id: null, total: { $sum: '$balance' } } } ],
          outputVAT: [ { $match: { status: { $in: ['paid','partial','confirmed'] } } }, { $group: { _id: null, total: { $sum: '$totalTax' } } } ]
        } }
      ]),
      Purchase.aggregate([
        { $match: { company: companyId } },
        { $facet: {
          payments: [ { $unwind: '$payments' }, { $group: { _id: null, total: { $sum: '$payments.amount' } } } ],
          payables: [ { $match: { status: { $in: ['draft','ordered','received','partial'] } } }, { $group: { _id: null, totalBalance: { $sum: '$balance' } } } ],
          inputVAT: [ { $match: { status: { $in: ['received','partial','paid'] } } }, { $group: { _id: null, total: { $sum: '$totalTax' } } } ],
          // Get all purchases (not just payables) for Payables Days calculation
          allPurchases: [ { $match: { status: { $in: ['draft','ordered','received','partial','paid'] } } }, { $group: { _id: null, total: { $sum: '$subtotal' } } } ]
        } }
      ]),
      Product.aggregate([
        { $match: { company: companyId, isArchived: false } },
        { $project: { stockValue: { $multiply: ['$currentStock', '$averageCost'] } } },
        { $group: { _id: null, totalValue: { $sum: '$stockValue' } } }
      ]),
      FixedAsset.find({ company: companyId, status: 'active' }),
      Loan.aggregate([{ $match: { company: companyId, status: 'active' } }, { $group: { _id: '$loanType', totalBalance: { $sum: { $subtract: ['$originalAmount', '$amountPaid'] } } } }]),
      Company.findById(companyId).lean()
    ]);

    const invoiceRes = (invoiceAgg[0] || {});
    const totalInflows = invoiceRes.payments?.[0]?.total || 0;
    const accountsReceivable = invoiceRes.receivables?.[0]?.total || 0;
    const outputVAT = invoiceRes.outputVAT?.[0]?.total || 0;

    const purchaseRes = (purchaseAgg[0] || {});
    const totalOutflows = purchaseRes.payments?.[0]?.total || 0;

    // Robust accounts payable: sum outstanding balances on purchases
    // Include ALL purchase statuses that could have a balance (including 'paid' with remaining balance)
    const purchasePayableAgg = await Purchase.aggregate([
      { $match: { company: companyId, balance: { $gt: 0 } } },
      { $group: { _id: null, totalBalance: { $sum: '$balance' } } }
    ]);
    const accountsPayable = purchasePayableAgg[0]?.totalBalance || 0;
    const inputVAT = purchaseRes.inputVAT?.[0]?.total || 0;

    // Get actual purchases (subtotal, excluding VAT and discounts) for Payables Days calculation
    // This represents the total value of purchases made
    const purchasesTotal = purchaseRes.allPurchases?.[0]?.total || 
      (await Purchase.aggregate([
        { $match: { company: companyId, status: { $in: ['received', 'paid', 'partial'] } } },
        { $group: { _id: null, total: { $sum: '$subtotal' } } }
      ]))[0]?.total || 0;

    const inventoryValue = productAgg[0]?.totalValue || 0;

    // Fixed assets gross and depreciation
    let totalFixedGross = 0;
    let totalAccumDep = 0;
    (fixedAssets || []).forEach(a => { totalFixedGross += a.purchaseCost || 0; totalAccumDep += a.accumulatedDepreciation || 0; });

    const vatReceivable = Math.max(0, (inputVAT || 0) - (outputVAT || 0));
    const vatPayable = Math.max(0, (outputVAT || 0) - (inputVAT || 0));

    // Get loans data for liability calculations
    const loansDataAgg = loansAgg[0] || {};
    const loanTotal = loansDataAgg.totalBalance || 0;
    
    // Separate short-term and long-term loans
    const shortTermLoans = loansDataAgg._id === 'short-term' ? loanTotal : 0;
    const longTermLoans = loansDataAgg._id === 'long-term' ? loanTotal : 
      (await Loan.aggregate([
        { $match: { company: companyId, status: 'active' } },
        { $group: { _id: '$loanType', totalBalance: { $sum: { $subtract: ['$originalAmount', '$amountPaid'] } } } }
      ])).reduce((sum, loan) => {
        if (loan._id === 'long-term') return sum + (loan.totalBalance || 0);
        return sum;
      }, 0);

    // Calculate accrued interest on all active loans
    const allActiveLoans = await Loan.find({ company: companyId, status: 'active' });
    const accruedInterest = allActiveLoans.reduce((sum, loan) => {
      const months = loan.durationMonths || 0;
      const P = loan.originalAmount || 0;
      const rate = loan.interestRate || 0;
      if (!months || !P || !rate) return sum;

      if (loan.interestMethod === 'compound') {
        const r = rate / 100 / 12;
        const emi = r > 0 ? (P * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1) : P / months;
        const totalInterest = emi * months - P;
        return sum + Math.max(0, totalInterest);
      } else {
        const totalInterest = (P * rate / 100 / 12) * months;
        return sum + totalInterest;
      }
    }, 0);

    // Get custom liabilities from Company
    const companyCurrLiab = (company?.liabilities?.currentLiabilities || []).reduce((s, c) => s + (c.amount || 0), 0);
    const companyNonCurrLiab = (company?.liabilities?.nonCurrentLiabilities || []).reduce((s, c) => s + (c.amount || 0), 0);
    const accruedExpenses = company?.liabilities?.accruedExpenses || 0;

    // Corporate Income Tax Payable (30% of Profit Before Tax)
    const incomeTaxPayable = Math.max(0, profitBeforeTax * 0.30);

    // Calculate Current Assets - using same logic as Balance Sheet
    // Cash & Bank = payments received from customers (net of credit notes)
    const creditNoteData = await CreditNote.aggregate([
      { $match: { company: companyId, status: { $in: ['issued', 'applied', 'refunded', 'partially_refunded'] } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } }
    ]);
    const totalCreditNoteAmount = creditNoteData[0]?.total || 0;
    const netCashInflows = Math.max(0, totalInflows - totalCreditNoteAmount);
    // Get actual bank account balances - use real bank account data if available
    let cashAndBank = 0;
    try {
      const bankData = await BankAccount.getTotalCashPosition(companyId);
      cashAndBank = bankData.total || netCashInflows;
    } catch (e) {
      cashAndBank = netCashInflows || 0;
    }
    const prepaidExpenses = company?.assets?.prepaidExpenses || 0;

    const totalCurrentAssets = cashAndBank + accountsReceivable + inventoryValue + prepaidExpenses + vatReceivable;
    const totalNonCurrentAssets = Math.max(0, totalFixedGross - totalAccumDep);
    const totalAssets = totalCurrentAssets + totalNonCurrentAssets;

    // Calculate Current Liabilities - using same logic as Balance Sheet
    // Include: accounts payable, VAT payable, short-term loans, income tax payable, accrued expenses, accrued interest, and custom current liabilities
    const totalCurrentLiabilities = accountsPayable + vatPayable + shortTermLoans + incomeTaxPayable + companyCurrLiab + accruedExpenses + accruedInterest;
    const totalNonCurrentLiabilities = longTermLoans + companyNonCurrLiab;
    const totalLiabilities = totalCurrentLiabilities + totalNonCurrentLiabilities;

    const shareCapital = company?.equity?.shareCapital || 0;
    const ownerCapital = company?.equity?.ownerCapital || 0;
    const retainedEarnings = company?.equity?.retainedEarnings || 0;
    const totalEquity = shareCapital + ownerCapital + retainedEarnings + netProfit;

    // Compute ratios (guard divide by zero)
    const safeDiv = (num, den) => (den && den !== 0) ? num / den : null;

    const currentRatio = safeDiv(totalCurrentAssets, totalCurrentLiabilities);
    const quickRatio = safeDiv(totalCurrentAssets - inventoryValue, totalCurrentLiabilities);
    const debtToEquity = safeDiv(totalLiabilities, totalEquity);
    const returnOnAssets = safeDiv(netProfit, totalAssets);
    const returnOnEquity = safeDiv(netProfit, totalEquity);
    const grossMarginPercent = netRevenue ? (grossProfit / netRevenue) * 100 : null;
    const netProfitMarginPercent = netRevenue ? (netProfit / netRevenue) * 100 : null;
    const cogs = (netRevenue - grossProfit) || 0;
    const inventoryTurnover = safeDiv(cogs, inventoryValue || 0);

    // Payables Days = (Accounts Payable × 365) / Actual Purchases
    // Use purchasesTotal (actual purchases from P&L) not payables
    const payablesDaysValue = safeDiv((accountsPayable || 0) * 365, purchasesTotal || 1);

    const ratios = {
      currentRatio: { value: currentRatio, formula: 'Current Assets / Current Liabilities' },
      quickRatio: { value: quickRatio, formula: '(Current Assets - Inventory) / Current Liabilities' },
      debtToEquity: { value: debtToEquity, formula: 'Total Liabilities / Total Equity' },
      returnOnAssets: { value: returnOnAssets, formula: 'Net Profit / Total Assets' },
      returnOnEquity: { value: returnOnEquity, formula: 'Net Profit / Total Equity' },
      grossMargin: { value: grossMarginPercent, formula: 'Gross Profit / Net Revenue × 100' },
      netMargin: { value: netProfitMarginPercent, formula: 'Net Profit / Net Revenue × 100' },
      inventoryTurnover: { value: inventoryTurnover, formula: 'COGS / Average Inventory (approx)' },
      receivablesDays: { value: safeDiv((accountsReceivable || 0) * 365, netRevenue) || null, formula: 'Receivables / Revenue × 365' },
      payablesDays: { value: payablesDaysValue, formula: 'Payables / Purchases × 365' }
    };

    // Simple interpretation heuristics
    const interpretation = {
      liquidity: (currentRatio >= 1.5) ? 'healthy' : (currentRatio >= 1 ? 'caution' : 'risky'),
      profitability: (netProfitMarginPercent >= 10) ? 'healthy' : (netProfitMarginPercent > 0 ? 'caution' : 'risky'),
      efficiency: (inventoryTurnover >= 4) ? 'healthy' : (inventoryTurnover >= 2 ? 'caution' : 'risky'),
      liquidityMessage: '',
      profitabilityMessage: '',
      efficiencyMessage: '',
      keyTakeaways: ''
    };

    interpretation.liquidityMessage = `Current ratio is ${currentRatio?.toFixed?.(2) || 'N/A'}`;
    interpretation.profitabilityMessage = `Net margin is ${netProfitMarginPercent != null ? (netProfitMarginPercent.toFixed(1) + '%') : 'N/A'}`;
    interpretation.efficiencyMessage = `Inventory turnover is ${inventoryTurnover != null ? inventoryTurnover.toFixed(2) : 'N/A'}`;
    interpretation.keyTakeaways = 'Review liquidity and working capital if any ratios are in caution or risky range.';

    const responseData = {
      asOf: asOf,
      periodStart,
      periodEnd,
      liquidity: {
        currentRatio: ratios.currentRatio,
        quickRatio: ratios.quickRatio
      },
      profitability: {
        grossMargin: ratios.grossMargin,
        netMargin: ratios.netMargin,
        roa: { value: returnOnAssets, formula: 'Net Profit / Total Assets × 100' }
      },
      efficiency: {
        inventoryTurnover: ratios.inventoryTurnover,
        receivablesDays: ratios.receivablesDays,
        payablesDays: ratios.payablesDays
      },
      sourceData: {
        currentAssets: totalCurrentAssets,
        currentLiabilities: totalCurrentLiabilities,
        cash: cashAndBank,
        receivables: accountsReceivable,
        grossProfit: grossProfit,
        revenue: netRevenue,
        netProfit: netProfit,
        totalAssets: totalAssets,
        cogs: cogs,
        averageInventory: inventoryValue,
        purchases: purchasesTotal,
        payables: accountsPayable,
        inventory: inventoryValue,
        prepaidExpenses: prepaidExpenses,
        vatReceivable: vatReceivable,
        vatPayable: vatPayable,
        shortTermLoans: shortTermLoans,
        longTermLoans: longTermLoans,
        accruedInterest: accruedInterest,
        accruedExpenses: accruedExpenses,
        incomeTaxPayable: incomeTaxPayable,
        customCurrentLiabilities: companyCurrLiab,
        customNonCurrentLiabilities: companyNonCurrLiab
      },
      interpretation
    };

    res.json({ success: true, data: responseData });
  } catch (error) {
    next(error);
  }
};

// @desc    Cash flow statement (comprehensive - IAS 7 format)
// @route   GET /api/reports/cash-flow
// @access  Private
exports.getCashFlowStatement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, period = 'monthly' } = req.query;
    const cacheKey = { companyId, startDate, endDate, period };
    
    const cached = await cacheService.fetchOrExecute(
      'report_cashflow_v4',
      async () => {
        const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
        const end = endDate ? new Date(endDate) : new Date();

        // Determine date format based on period (for system records)

        // INVESTING ACTIVITIES - Asset Purchases from FixedAsset model (vehicles, equipment, etc.)
        // Query all FixedAssets purchased in the date range and group by period
        // Use a try-catch to handle potential date parsing issues
        let fixedAssetPurchasesAgg = [];
        try {
          fixedAssetPurchasesAgg = await FixedAsset.find({ 
            company: companyId,
            purchaseDate: { $gte: start, $lte: end }
          }).lean();
        } catch (err) {
          console.error('Error querying FixedAssets:', err);
        }
        
        // Group fixed asset purchases by period manually (since purchaseDate might be string or date)
        const fixedAssetByPeriod = {};
        fixedAssetPurchasesAgg.forEach(asset => {
          let periodKey;
          try {
            // Handle both Date objects and string dates
            let purchaseDate;
            if (asset.purchaseDate instanceof Date) {
              purchaseDate = asset.purchaseDate;
            } else if (typeof asset.purchaseDate === 'string') {
              purchaseDate = new Date(asset.purchaseDate);
            } else {
              periodKey = 'N/A';
              return;
            }
            
            if (isNaN(purchaseDate.getTime())) {
              periodKey = 'N/A';
              return;
            }
            
            if (period === 'yearly') {
              periodKey = purchaseDate.getFullYear().toString();
            } else if (period === 'weekly') {
              // Get ISO week number
              const d = new Date(Date.UTC(purchaseDate.getFullYear(), purchaseDate.getMonth(), purchaseDate.getDate()));
              const dayNum = d.getUTCDay() || 7;
              d.setUTCDate(d.getUTCDate() + 4 - dayNum);
              const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
              const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1)/7);
              periodKey = `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
            } else {
              // monthly
              periodKey = `${purchaseDate.getFullYear()}-${(purchaseDate.getMonth() + 1).toString().padStart(2, '0')}`;
            }
          } catch (e) {
            periodKey = 'N/A';
          }
          
          if (!fixedAssetByPeriod[periodKey]) {
            fixedAssetByPeriod[periodKey] = 0;
          }
          fixedAssetByPeriod[periodKey] += asset.purchaseCost || 0;
        });

        const fixedAssetPurchases = Object.entries(fixedAssetByPeriod).map(([period, amount]) => ({
          _id: period,
          amount: amount
        })).sort((a, b) => a._id.localeCompare(b._id));

        // OPERATING ACTIVITIES - Use ACTUAL Bank Transactions
        // This includes BOTH: system-generated transactions (invoices/purchases/expenses paid)
        // AND CSV-imported transactions from bank statements
        // This gives the REAL cash flow based on actual bank account movements
        
        // Get all bank transactions (completed) grouped by period and type
        const bankTransactionsAgg = await BankTransaction.aggregate([
          {
            $match: {
              company: companyId,
              date: { $gte: start, $lte: end },
              status: 'completed'
            }
          },
          {
            $group: {
              _id: {
                period: { $dateToString: { format: period === 'yearly' ? '%Y' : (period === 'weekly' ? '%Y-W%V' : '%Y-%m'), date: '$date' }},
                type: '$type'
              },
              amount: { $sum: '$amount' },
              count: { $sum: 1 }
            }
          },
          { $sort: { '_id.period': 1 } }
        ]);
        
        // Transform into deposits (cash inflows) and withdrawals (cash outflows)
        const depositsByPeriod = {};
        const withdrawalsByPeriod = {};
        let totalBankDeposits = 0;
        let totalBankWithdrawals = 0;
        
        bankTransactionsAgg.forEach(tx => {
          const periodKey = tx._id.period;
          const type = tx._id.type;
          const amount = tx.amount;
          
          // Deposits: deposit, transfer_in, opening (money coming in)
          // Withdrawals: withdrawal, transfer_out, adjustment, closing (money going out)
          const isDeposit = ['deposit', 'transfer_in', 'opening'].includes(type);
          const isWithdrawal = ['withdrawal', 'transfer_out', 'adjustment', 'closing'].includes(type);
          
          if (isDeposit) {
            depositsByPeriod[periodKey] = (depositsByPeriod[periodKey] || 0) + amount;
            totalBankDeposits += amount;
          }
          if (isWithdrawal) {
            withdrawalsByPeriod[periodKey] = (withdrawalsByPeriod[periodKey] || 0) + amount;
            totalBankWithdrawals += amount;
          }
        });
        
        // Get system records for reconciliation comparison (invoices/purchases/expenses paid)
        // These are the 'expected' vs 'actual' from bank
        const invoicePayments = await Invoice.aggregate([
          { $match: { company: companyId } },
          { $unwind: '$payments' },
          { $match: { 'payments.paidDate': { $gte: start, $lte: end } } },
          { $group: {
            _id: { $dateToString: { format: period === 'yearly' ? '%Y' : (period === 'weekly' ? '%Y-W%V' : '%Y-%m'), date: '$payments.paidDate' }},
            cashFromCustomers: { $sum: '$payments.amount' },
            count: { $sum: 1 }
          } },
          { $sort: { _id: 1 } }
        ]);

        const purchasePayments = await Purchase.aggregate([
          { $match: { company: companyId } },
          { $unwind: '$payments' },
          { $match: { 'payments.paidDate': { $gte: start, $lte: end } } },
          { $group: {
            _id: { $dateToString: { format: period === 'yearly' ? '%Y' : (period === 'weekly' ? '%Y-W%V' : '%Y-%m'), date: '$payments.paidDate' }},
            cashToSuppliers: { $sum: '$payments.amount' },
            count: { $sum: 1 }
          } },
          { $sort: { _id: 1 } }
        ]);

        // Merge all data by period - use ACTUAL bank transactions
        const map = {};
        
        // Initialize all periods from bank transactions (deposits)
        Object.keys(depositsByPeriod).forEach(periodKey => {
          map[periodKey] = map[periodKey] || { 
            period: periodKey, 
            cashFromBank: 0, 
            cashToBank: 0, 
            cashFromCustomers: 0, 
            cashToSuppliers: 0, 
            cashForExpenses: 0, 
            taxPaid: 0, 
            assetPurchases: 0, 
            assetDisposals: 0, 
            loanDisbursements: 0, 
            loanRepayments: 0, 
            capitalInjections: 0, 
            dividendsPaid: 0 
          };
          map[periodKey].cashFromBank = depositsByPeriod[periodKey];
        });
        
        // Initialize all periods from bank transactions (withdrawals)
        Object.keys(withdrawalsByPeriod).forEach(periodKey => {
          map[periodKey] = map[periodKey] || { 
            period: periodKey, 
            cashFromBank: 0, 
            cashToBank: 0, 
            cashFromCustomers: 0, 
            cashToSuppliers: 0, 
            cashForExpenses: 0, 
            taxPaid: 0, 
            assetPurchases: 0, 
            assetDisposals: 0, 
            loanDisbursements: 0, 
            loanRepayments: 0, 
            capitalInjections: 0, 
            dividendsPaid: 0 
          };
          map[periodKey].cashToBank = withdrawalsByPeriod[periodKey];
        });
        
        // Add system records for reconciliation comparison
        invoicePayments.forEach(r => { 
          map[r._id] = map[r._id] || { 
            period: r._id, 
            cashFromBank: 0, 
            cashToBank: 0, 
            cashFromCustomers: 0, 
            cashToSuppliers: 0, 
            cashForExpenses: 0, 
            taxPaid: 0, 
            assetPurchases: 0, 
            assetDisposals: 0, 
            loanDisbursements: 0, 
            loanRepayments: 0, 
            capitalInjections: 0, 
            dividendsPaid: 0 
          }; 
          map[r._id].cashFromCustomers = r.cashFromCustomers; 
        });
        purchasePayments.forEach(r => { 
          map[r._id] = map[r._id] || { 
            period: r._id, 
            cashFromBank: 0, 
            cashToBank: 0, 
            cashFromCustomers: 0, 
            cashToSuppliers: 0, 
            cashForExpenses: 0, 
            taxPaid: 0, 
            assetPurchases: 0, 
            assetDisposals: 0, 
            loanDisbursements: 0, 
            loanRepayments: 0, 
            capitalInjections: 0, 
            dividendsPaid: 0 
          }; 
          map[r._id].cashToSuppliers = r.cashToSuppliers; 
        });
        fixedAssetPurchases.forEach(r => {
          map[r._id] = map[r._id] || { period: r._id, cashFromCustomers: 0, cashToSuppliers: 0, cashForExpenses: 0, taxPaid: 0, assetPurchases: 0, assetDisposals: 0, loanDisbursements: 0, loanRepayments: 0, capitalInjections: 0, dividendsPaid: 0 };
          map[r._id].assetPurchases = r.amount;
        });

        const months = Object.values(map).sort((a, b) => a.period.localeCompare(b.period));

        // Calculate summary totals from ACTUAL bank transactions
        const totalCashFromBank = months.reduce((sum, m) => sum + (m.cashFromBank || 0), 0);
        const totalCashToBank = months.reduce((sum, m) => sum + (m.cashToBank || 0), 0);
        const totalCashFromCustomers = months.reduce((sum, m) => sum + (m.cashFromCustomers || 0), 0);
        const totalCashToSuppliers = months.reduce((sum, m) => sum + (m.cashToSuppliers || 0), 0);
        const totalAssetPurchases = months.reduce((sum, m) => sum + (m.assetPurchases || 0), 0);
        const totalAssetDisposals = months.reduce((sum, m) => sum + (m.assetDisposals || 0), 0);

        // Operating = Cash from Bank - Cash to Bank (actual bank transactions)
        const netOperatingCashFlow = totalCashFromBank - totalCashToBank;
        // Investing = Disposals - Purchases
        const netInvestingCashFlow = totalAssetDisposals - totalAssetPurchases;
        // Financing = 0 (no data currently)
        const netFinancingCashFlow = 0;

        // Calculate reconciliation: difference between system records and bank records
        const totalSystemCashIn = totalCashFromCustomers;
        const totalSystemCashOut = totalCashToSuppliers;
        const reconciliation = {
          bankDeposits: totalCashFromBank,
          bankWithdrawals: totalCashToBank,
          systemInvoicePayments: totalCashFromCustomers,
          systemPurchasePayments: totalCashToSuppliers,
          depositsDifference: totalCashFromBank - totalCashFromCustomers,
          withdrawalsDifference: totalCashToBank - totalCashToSuppliers
        };

        const summary = {
          operating: {
            cashFromBank: totalCashFromBank,
            cashToBank: totalCashToBank,
            cashFromCustomers: totalCashFromCustomers,
            cashToSuppliers: totalCashToSuppliers,
            cashForExpenses: 0,
            taxPaid: 0,
            netCashFlow: netOperatingCashFlow
          },
          investing: {
            assetPurchases: totalAssetPurchases,
            assetDisposals: totalAssetDisposals,
            netCashFlow: netInvestingCashFlow
          },
          financing: {
            loanDisbursements: 0,
            loanRepayments: 0,
            capitalInjections: 0,
            dividendsPaid: 0,
            netCashFlow: netFinancingCashFlow
          },
          netChangeInCash: netOperatingCashFlow + netInvestingCashFlow + netFinancingCashFlow,
          reconciliation
        };

        return { period: { start, end }, periodType: period, months, summary };
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true } // 5 minute cache
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Budget vs Actual report
// @route   GET /api/reports/budget-vs-actual
// @access  Private
exports.getBudgetVsActualReport = async (req, res, next) => {
  try {
    const { budgetId } = req.query;
    if (!budgetId) return res.status(400).json({ success: false, message: 'budgetId is required' });

    const budget = await Budget.findById(budgetId);
    if (!budget) return res.status(404).json({ success: false, message: 'Budget not found' });

    const start = budget.periodStart;
    const end = budget.periodEnd || new Date();

    let actual = 0;
    if (budget.type === 'revenue') {
      const invAgg = await Invoice.aggregate([
        { $match: { company: budget.company, invoiceDate: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: '$grandTotal' } } }
      ]);
      actual = invAgg[0]?.total || 0;
    } else {
      const purAgg = await Purchase.aggregate([
        { $match: { company: budget.company, purchaseDate: { $gte: start, $lte: end } } },
        { $group: { _id: null, total: { $sum: '$grandTotal' } } }
      ]);
      actual = purAgg[0]?.total || 0;
    }

    const variance = budget.amount - actual;

    res.json({ success: true, data: { budget, actual, variance } });
  } catch (error) {
    next(error);
  }
};

// @desc    Get supplier purchase report
// @route   GET /api/reports/supplier-purchase
// @access  Private
exports.getSupplierPurchaseReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    const matchStage = { 
      type: 'in',
      reason: 'purchase',
      company: companyId
    };

    if (startDate || endDate) {
      matchStage.movementDate = {};
      if (startDate) matchStage.movementDate.$gte = new Date(startDate);
      if (endDate) matchStage.movementDate.$lte = new Date(endDate);
    }

    const supplierPurchases = await StockMovement.aggregate([
      { $match: matchStage },
      { $group: {
        _id: '$supplier',
        totalPurchases: { $sum: 1 },
        totalQuantity: { $sum: '$quantity' },
        totalCost: { $sum: '$totalCost' }
      }},
      { $sort: { totalCost: -1 } }
    ]);

    await Supplier.populate(supplierPurchases, { 
      path: '_id', 
      select: 'name code contact'
    });

    res.json({
      success: true,
      count: supplierPurchases.length,
      data: supplierPurchases
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client credit limit report
// @route   GET /api/reports/client-credit-limit
// @access  Private
exports.getClientCreditLimitReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    const cacheKey = { companyId, startDate, endDate };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        // Get all active clients with credit limit > 0 or with outstanding balance
        const clientQuery = { 
          company: companyId,
          isActive: true,
          $or: [
            { creditLimit: { $gt: 0 } },
            { outstandingBalance: { $gt: 0 } }
          ]
        };

        const clients = await Client.find(clientQuery)
          .select('name code contact creditLimit outstandingBalance totalPurchases lastPurchaseDate')
          .sort({ outstandingBalance: -1 });

        // Calculate credit utilization for each client
        const report = clients.map(client => {
          const creditLimit = client.creditLimit || 0;
          const outstandingBalance = client.outstandingBalance || 0;
          const creditUtilization = creditLimit > 0 ? (outstandingBalance / creditLimit) * 100 : 0;
          const availableCredit = Math.max(0, creditLimit - outstandingBalance);
          
          return {
            _id: client._id,
            code: client.code,
            name: client.name,
            contact: client.contact,
            creditLimit: creditLimit,
            outstandingBalance: outstandingBalance,
            availableCredit: availableCredit,
            creditUtilization: Math.round(creditUtilization * 100) / 100,
            totalPurchases: client.totalPurchases || 0,
            lastPurchaseDate: client.lastPurchaseDate,
            status: creditUtilization > 100 ? 'over_limit' : (creditUtilization > 80 ? 'warning' : 'ok')
          };
        });

        // Calculate summary
        const summary = {
          totalClients: report.length,
          totalCreditLimit: report.reduce((sum, c) => sum + c.creditLimit, 0),
          totalOutstanding: report.reduce((sum, c) => sum + c.outstandingBalance, 0),
          totalAvailable: report.reduce((sum, c) => sum + c.availableCredit, 0),
          overLimitCount: report.filter(c => c.status === 'over_limit').length,
          warningCount: report.filter(c => c.status === 'warning').length
        };

        return { data: report, summary };
      },
      cacheKey,
      { ttl: 120, useCompanyPrefix: true } // 2 minute cache
    );

    res.json({
      success: true,
      data: cached.data.data,
      summary: cached.data.summary,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get new clients report
// @route   GET /api/reports/new-clients
// @access  Private
exports.getNewClientsReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, limit = 100 } = req.query;
    const cacheKey = { companyId, startDate, endDate, limit };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        // Default to current month if no dates provided
        const now = new Date();
        const start = startDate ? new Date(startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
        const end = endDate ? new Date(endDate) : now;

        const clients = await Client.find({
          company: companyId,
          createdAt: { $gte: start, $lte: end }
        })
        .select('name code contact createdAt totalPurchases outstandingBalance lastPurchaseDate')
        .sort({ createdAt: -1 })
        .limit(parseInt(limit, 10));

        // Get purchase stats for each client in the period
        const report = await Promise.all(clients.map(async (client) => {
          const invoiceStats = await Invoice.aggregate([
            { $match: {
              client: client._id,
              company: companyId,
              invoiceDate: { $gte: start, $lte: end }
            }},
            { $group: {
              _id: null,
              totalInvoices: { $sum: 1 },
              totalSales: { $sum: '$grandTotal' }
            }}
          ]);

          return {
            _id: client._id,
            code: client.code,
            name: client.name,
            contact: client.contact,
            createdAt: client.createdAt,
            totalInvoices: invoiceStats[0]?.totalInvoices || 0,
            totalSales: invoiceStats[0]?.totalSales || 0,
            outstandingBalance: client.outstandingBalance || 0
          };
        }));

        const summary = {
          totalNewClients: report.length,
          totalNewClientSales: report.reduce((sum, c) => sum + c.totalSales, 0),
          periodStart: start,
          periodEnd: end
        };

        return { data: report, summary };
      },
      cacheKey,
      { ttl: 120, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data.data,
      summary: cached.data.summary,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get inactive clients report (no purchase in X days)
// @route   GET /api/reports/inactive-clients
// @access  Private
exports.getInactiveClientsReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { days = 90, limit = 100 } = req.query;
    const cacheKey = { companyId, days, limit };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const inactiveDays = parseInt(days, 10) || 90;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);

        // Get all active clients
        const clients = await Client.find({
          company: companyId,
          isActive: true
        })
        .select('name code contact createdAt totalPurchases outstandingBalance lastPurchaseDate')
        .lean();

        // Filter clients with no purchase since cutoff date
        const inactiveClients = [];
        
        for (const client of clients) {
          const lastPurchase = client.lastPurchaseDate ? new Date(client.lastPurchaseDate) : null;
          
          // Client is inactive if:
          // 1. No lastPurchaseDate OR
          // 2. Last purchase was before cutoff date
          const isInactive = !lastPurchase || lastPurchase < cutoffDate;
          
          if (isInactive) {
            const daysSinceLastPurchase = lastPurchase 
              ? Math.floor((new Date() - lastPurchase) / (1000 * 60 * 60 * 24))
              : null;
            
            inactiveClients.push({
              _id: client._id,
              code: client.code,
              name: client.name,
              contact: client.contact,
              createdAt: client.createdAt,
              lastPurchaseDate: client.lastPurchaseDate,
              daysSinceLastPurchase: daysSinceLastPurchase,
              totalPurchases: client.totalPurchases || 0,
              outstandingBalance: client.outstandingBalance || 0
            });
          }
        }

        // Sort by days since last purchase (most inactive first)
        inactiveClients.sort((a, b) => {
          if (a.daysSinceLastPurchase === null) return -1;
          if (b.daysSinceLastPurchase === null) return 1;
          return b.daysSinceLastPurchase - a.daysSinceLastPurchase;
        });

        // Apply limit
        const report = inactiveClients.slice(0, parseInt(limit, 10));

        const summary = {
          totalInactiveClients: inactiveClients.length,
          daysThreshold: inactiveDays,
          displayedCount: report.length,
          totalOutstandingBalance: report.reduce((sum, c) => sum + c.outstandingBalance, 0)
        };

        return { data: report, summary };
      },
      cacheKey,
      { ttl: 120, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data.data,
      summary: cached.data.summary,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get low stock report (below minimum level)
// @route   GET /api/reports/low-stock
// @access  Private
exports.getLowStockReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { threshold } = req.query;
    const cacheKey = { companyId, threshold };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const data = await reportGeneratorService.generateLowStockReport(companyId, threshold);
        return data;
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get dead stock report (no movement in X days)
// @route   GET /api/reports/dead-stock
// @access  Private
exports.getDeadStockReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { days = 90 } = req.query;
    const cacheKey = { companyId, days };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const data = await reportGeneratorService.generateDeadStockReport(companyId, days);
        return data;
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get stock aging report (how long items have been sitting)
// @route   GET /api/reports/stock-aging
// @access  Private
exports.getStockAgingReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const cacheKey = { companyId };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const data = await reportGeneratorService.generateStockAgingReport(companyId);
        return data;
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get inventory turnover report
// @route   GET /api/reports/inventory-turnover
// @access  Private
exports.getInventoryTurnoverReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    const cacheKey = { companyId, startDate, endDate };
    
    let reportPeriodStart, reportPeriodEnd;
    if (startDate && endDate) {
      reportPeriodStart = new Date(startDate);
      reportPeriodEnd = new Date(endDate);
    } else {
      const now = new Date();
      reportPeriodStart = new Date(now.getFullYear(), 0, 1);
      reportPeriodEnd = now;
    }
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const data = await reportGeneratorService.generateInventoryTurnoverReport(companyId, reportPeriodStart, reportPeriodEnd);
        return data;
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get batch/expiry report (items expiring soon)
// @route   GET /api/reports/batch-expiry
// @access  Private
exports.getBatchExpiryReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { daysAhead = 90 } = req.query;
    const cacheKey = { companyId, daysAhead };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const data = await reportGeneratorService.generateBatchExpiryReport(companyId, daysAhead);
        return data;
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get serial number tracking report
// @route   GET /api/reports/serial-number-tracking
// @access  Private
exports.getSerialNumberTrackingReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { productId, status } = req.query;
    const cacheKey = { companyId, productId, status };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const data = await reportGeneratorService.generateSerialNumberTrackingReport(companyId, productId, status);
        return data;
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get warehouse stock report (stock per warehouse)
// @route   GET /api/reports/warehouse-stock
// @access  Private
exports.getWarehouseStockReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { warehouseId } = req.query;
    const cacheKey = { companyId, warehouseId };
    
    const cached = await cacheService.fetchOrExecute(
      'report',
      async () => {
        const data = await reportGeneratorService.generateWarehouseStockReport(companyId, warehouseId);
        return data;
      },
      cacheKey,
      { ttl: 300, useCompanyPrefix: true }
    );

    res.json({
      success: true,
      data: cached.data,
      fromCache: cached.fromCache
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Export report to Excel
// @route   GET /api/reports/export/excel/:reportType
// @access  Private
exports.exportReportToExcel = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reportType } = req.params;
    const { periodType, year, periodNumber, startDate, endDate } = req.query;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Report');

    let data;
    let reportPeriodStart, reportPeriodEnd;

    // If period parameters provided, use them to determine date range
    if (periodType && year) {
      const periodYear = parseInt(year);
      const periodNum = periodNumber ? parseInt(periodNumber) : 1;
      const periodInfo = reportGeneratorService.getPeriodDates(periodType, periodYear, periodNum);
      reportPeriodStart = new Date(periodInfo.startDate);
      reportPeriodEnd = new Date(periodInfo.endDate);
    } else if (startDate && endDate) {
      reportPeriodStart = new Date(startDate);
      reportPeriodEnd = new Date(endDate);
    } else {
      // Default to current quarter
      const now = new Date();
      reportPeriodStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      reportPeriodEnd = new Date();
    }

    switch (reportType) {
      case 'products':
      case 'stock-valuation':
        const productsExcel = await Product.find({ isArchived: false, company: companyId })
          .populate('category', 'name')
          .populate('supplier', 'name')
          .sort({ name: 1 });

        worksheet.columns = [
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Product Name', key: 'name', width: 30 },
          { header: 'Category', key: 'category', width: 20 },
          { header: 'Supplier', key: 'supplier', width: 20 },
          { header: 'Unit', key: 'unit', width: 10 },
          { header: 'Stock', key: 'stock', width: 12 },
          { header: 'Avg Cost', key: 'cost', width: 12 },
          { header: 'Total Value', key: 'value', width: 15 }
        ];

        productsExcel.forEach(product => {
          worksheet.addRow({
            sku: product.sku,
            name: product.name,
            category: product.category?.name || 'N/A',
            supplier: product.supplier?.name || 'N/A',
            unit: product.unit,
            stock: product.currentStock,
            cost: product.averageCost,
            value: product.currentStock * product.averageCost
          });
        });
        break;

      case 'suppliers':
        const suppliersExcel = await Supplier.find({ company: companyId })
          .sort({ name: 1 });

        worksheet.columns = [
          { header: 'Code', key: 'code', width: 15 },
          { header: 'Supplier Name', key: 'name', width: 30 },
          { header: 'Email', key: 'email', width: 25 },
          { header: 'Phone', key: 'phone', width: 15 },
          { header: 'Address', key: 'address', width: 30 },
          { header: 'City', key: 'city', width: 15 },
          { header: 'Total Purchases', key: 'totalPurchases', width: 15 },
          { header: 'Balance Due', key: 'balance', width: 15 }
        ];

        // Get purchase data for each supplier
        for (const supplier of suppliersExcel) {
          const purchases = await Purchase.find({ supplier: supplier._id, status: { $in: ['received', 'paid', 'partial'] } });
          const totalPurchases = purchases.reduce((sum, p) => sum + (p.grandTotal || 0), 0);
          const balance = purchases.reduce((sum, p) => sum + (p.balance || 0), 0);
          
          worksheet.addRow({
            code: supplier.code,
            name: supplier.name,
            email: supplier.contact?.email || 'N/A',
            phone: supplier.contact?.phone || 'N/A',
            address: supplier.contact?.address || 'N/A',
            city: supplier.contact?.city || 'N/A',
            totalPurchases: totalPurchases,
            balance: balance
          });
        }
        break;

      case 'sales-summary':
        const invoicesExcel = await Invoice.find({ status: { $in: ['paid', 'partial'] }, company: companyId })
          .populate('client', 'name code')
          .sort({ invoiceDate: -1 });

        worksheet.columns = [
          { header: 'Invoice #', key: 'invoiceNumber', width: 20 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Client', key: 'client', width: 25 },
          { header: 'Subtotal', key: 'subtotal', width: 12 },
          { header: 'Tax', key: 'tax', width: 12 },
          { header: 'Total', key: 'total', width: 12 },
          { header: 'Paid', key: 'paid', width: 12 },
          { header: 'Balance', key: 'balance', width: 12 },
          { header: 'Status', key: 'status', width: 12 }
        ];

        invoicesExcel.forEach(invoice => {
          worksheet.addRow({
            invoiceNumber: invoice.invoiceNumber,
            date: invoice.invoiceDate.toLocaleDateString(),
            client: invoice.client?.name || 'N/A',
            subtotal: invoice.subtotal,
            tax: invoice.totalTax,
            total: invoice.grandTotal,
            paid: invoice.amountPaid,
            balance: invoice.balance,
            status: invoice.status
          });
        });
        break;

      case 'profit-loss':
        // Get P&L detailed data for export - use the determined period dates
        const plPeriodStart = reportPeriodStart;
        const plPeriodEnd = reportPeriodEnd;
        
        const plCompany = await Company.findById(companyId);
        const plPaidInvoices = await Invoice.find({ 
          status: 'paid', 
          company: companyId,
          paidDate: { $gte: plPeriodStart, $lte: plPeriodEnd }
        }).populate('items.product', 'averageCost');

        const plCreditNotes = await CreditNote.find({
          company: companyId,
          status: { $in: ['issued', 'applied', 'refunded', 'partially_refunded'] },
          issueDate: { $gte: plPeriodStart, $lte: plPeriodEnd }
        });

        const plPurchases = await Purchase.find({
          company: companyId,
          status: { $in: ['received', 'paid'] },
          purchaseDate: { $gte: plPeriodStart, $lte: plPeriodEnd }
        });

        const plProducts = await Product.find({ company: companyId, isArchived: false });
        const plFixedAssets = await FixedAsset.find({ company: companyId, status: 'active' });
        const plLoans = await Loan.find({ company: companyId, status: 'active', startDate: { $lte: plPeriodEnd } });

        // Calculate P&L values
        const plSalesRevenueExVAT = plPaidInvoices.reduce((sum, inv) => sum + (inv.subtotal || 0), 0);
        const plSalesReturns = plCreditNotes.reduce((sum, cn) => sum + (cn.subtotal || 0), 0);
        const plDiscountsGiven = plPaidInvoices.reduce((sum, inv) => sum + (inv.totalDiscount || 0), 0);
        const plNetRevenue = plSalesRevenueExVAT - plSalesReturns - plDiscountsGiven;

        const plClosingStockValue = plProducts.reduce((sum, product) => sum + (product.currentStock * product.averageCost), 0);
        const plPurchasesExVAT = plPurchases.reduce((sum, p) => sum + ((p.subtotal || 0) - (p.totalDiscount || 0)), 0);

        // Opening Stock: simply use 0
        const plOpeningStockValue = 0;

        // COGS: Formula-based approach - Opening Stock + Purchases - Closing Stock
        const plTotalCOGS = plOpeningStockValue + plPurchasesExVAT - plClosingStockValue;

        const plGrossProfit = plNetRevenue - plTotalCOGS;
        const plGrossMarginPercent = plNetRevenue > 0 ? (plGrossProfit / plNetRevenue) * 100 : 0;

        // Depreciation — period-aware, starts from 1st of purchase month
        const plDepreciationExpense = calculateDepreciationForPeriod(plFixedAssets, plPeriodStart, plPeriodEnd);

        // Interest expense
        let plInterestExpense = 0;
        // Calculate number of months in the period
        const plPeriodMonths = Math.ceil((plPeriodEnd - plPeriodStart) / (1000 * 60 * 60 * 24 * 30)) || 1;
        
        plLoans.forEach(loan => {
          const monthlyInterest = (loan.originalAmount * (loan.interestRate || 0) / 100) / 12;
          plInterestExpense += monthlyInterest * plPeriodMonths;
        });

        // VAT
        const plOutputVAT = plPaidInvoices.reduce((sum, inv) => sum + (inv.totalTax || 0), 0);
        const plInputVAT = plPurchases.reduce((sum, p) => sum + (p.totalTax || 0), 0);

        const plOperatingExpenses = plDepreciationExpense;
        const plOperatingProfit = plGrossProfit - plOperatingExpenses;
        const plNetOtherIncome = -plInterestExpense;
        const plProfitBeforeTax = plOperatingProfit + plNetOtherIncome;
        const plCorporateIncomeTax = Math.max(0, plProfitBeforeTax * 0.30);
        const plTotalTax = plCorporateIncomeTax;
        const plNetProfit = plProfitBeforeTax - plTotalTax;
        const plNetMarginPercent = plNetRevenue > 0 ? (plNetProfit / plNetRevenue) * 100 : 0;

        worksheet.columns = [
          { header: 'Item', key: 'item', width: 30 },
          { header: 'Amount', key: 'amount', width: 20 },
          { header: 'Notes', key: 'notes', width: 40 }
        ];

        // Header
        worksheet.addRow({ item: 'PROFIT & LOSS STATEMENT', amount: '', notes: `Period: ${plPeriodStart.toLocaleDateString()} - ${plPeriodEnd.toLocaleDateString()}` });
        worksheet.addRow({ item: 'Company: ' + (plCompany?.name || 'N/A'), amount: '', notes: 'TIN: ' + (plCompany?.tin || 'N/A') });
        worksheet.addRow({ item: '', amount: '', notes: '' });

        // Revenue Section
        worksheet.addRow({ item: 'REVENUE', amount: '', notes: '' });
        worksheet.addRow({ item: '  Sales Revenue (ex. VAT)', amount: plSalesRevenueExVAT, notes: `${plPaidInvoices.length} paid invoices` });
        worksheet.addRow({ item: '  Less: Sales Returns', amount: -plSalesReturns, notes: `${plCreditNotes.length} credit notes` });
        worksheet.addRow({ item: '  Less: Discounts Given', amount: -plDiscountsGiven, notes: '' });
        worksheet.addRow({ item: 'NET REVENUE', amount: plNetRevenue, notes: `Margin: ${plGrossMarginPercent.toFixed(1)}%` });
        worksheet.addRow({ item: '', amount: '', notes: '' });

        // COGS Section
        worksheet.addRow({ item: 'COST OF GOODS SOLD', amount: '', notes: '' });
        worksheet.addRow({ item: '  Opening Stock', amount: plOpeningStockValue, notes: '' });
        worksheet.addRow({ item: '  Add: Purchases (ex. VAT)', amount: plPurchasesExVAT, notes: `${plPurchases.length} purchases` });
        worksheet.addRow({ item: '  Less: Closing Stock', amount: -plClosingStockValue, notes: '' });
        worksheet.addRow({ item: 'TOTAL COGS', amount: plTotalCOGS, notes: '' });
        worksheet.addRow({ item: '', amount: '', notes: '' });

        // Gross Profit
        worksheet.addRow({ item: 'GROSS PROFIT', amount: plGrossProfit, notes: `Margin: ${plGrossMarginPercent.toFixed(1)}%` });
        worksheet.addRow({ item: '', amount: '', notes: '' });

        // Operating Expenses
        worksheet.addRow({ item: 'OPERATING EXPENSES', amount: '', notes: '' });
        worksheet.addRow({ item: '  Depreciation', amount: -plDepreciationExpense, notes: `${plFixedAssets.length} fixed assets` });
        worksheet.addRow({ item: 'TOTAL OPERATING EXPENSES', amount: -plOperatingExpenses, notes: '' });
        worksheet.addRow({ item: '', amount: '', notes: '' });

        // Operating Profit
        worksheet.addRow({ item: 'OPERATING PROFIT', amount: plOperatingProfit, notes: '' });
        worksheet.addRow({ item: '', amount: '', notes: '' });

        // Other Income / Expenses
        worksheet.addRow({ item: 'OTHER INCOME / EXPENSES', amount: '', notes: '' });
        worksheet.addRow({ item: '  Interest Expense', amount: -plInterestExpense, notes: `${plLoans.length} active loans` });
        worksheet.addRow({ item: 'NET OTHER INCOME', amount: plNetOtherIncome, notes: '' });
        worksheet.addRow({ item: '', amount: '', notes: '' });

        // Tax & Net Profit
        worksheet.addRow({ item: 'PROFIT BEFORE TAX', amount: plProfitBeforeTax, notes: '' });
        worksheet.addRow({ item: '  Less: Corporate Tax (30%)', amount: -plCorporateIncomeTax, notes: '' });
        worksheet.addRow({ item: 'NET PROFIT', amount: plNetProfit, notes: `Margin: ${plNetMarginPercent.toFixed(1)}%` });
        break;

      case 'top-clients':
      case 'client-sales':
        const topClientsExcel = await Invoice.aggregate([
          { $match: { company: companyId, status: { $in: ['paid', 'partial'] }, invoiceDate: { $gte: reportPeriodStart, $lte: reportPeriodEnd } } },
          { $group: { _id: '$client', revenue: { $sum: '$grandTotal' }, invoiceCount: { $sum: 1 } } },
          { $sort: { revenue: -1 } },
          { $limit: 50 }
        ]);
        await Client.populate(topClientsExcel, { path: '_id', select: 'name code' });

        worksheet.columns = [
          { header: 'Client Code', key: 'code', width: 15 },
          { header: 'Client Name', key: 'name', width: 30 },
          { header: 'Invoice Count', key: 'count', width: 15 },
          { header: 'Total Revenue', key: 'revenue', width: 20 }
        ];

        topClientsExcel.forEach(c => {
          worksheet.addRow({
            code: c._id?.code || 'N/A',
            name: c._id?.name || 'Unknown',
            count: c.invoiceCount,
            revenue: c.revenue
          });
        });
        break;

      case 'top-suppliers':
      case 'supplier-purchase':
        const topSuppliersExcel = await Purchase.aggregate([
          { $match: { company: companyId, status: { $in: ['received', 'paid', 'partial'] }, purchaseDate: { $gte: reportPeriodStart, $lte: reportPeriodEnd } } },
          { $group: { _id: '$supplier', total: { $sum: '$grandTotal' }, purchaseCount: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 50 }
        ]);
        await Supplier.populate(topSuppliersExcel, { path: '_id', select: 'name code' });

        worksheet.columns = [
          { header: 'Supplier Code', key: 'code', width: 15 },
          { header: 'Supplier Name', key: 'name', width: 30 },
          { header: 'Purchase Count', key: 'count', width: 15 },
          { header: 'Total Purchases', key: 'total', width: 20 }
        ];

        topSuppliersExcel.forEach(s => {
          worksheet.addRow({
            code: s._id?.code || 'N/A',
            name: s._id?.name || 'Unknown',
            count: s.purchaseCount,
            total: s.total
          });
        });
        break;

      case 'credit-limit':
        const creditLimitClients = await Client.find({ company: companyId, isActive: true })
          .select('name code creditLimit outstandingBalance')
          .lean();

        worksheet.columns = [
          { header: 'Client Code', key: 'code', width: 15 },
          { header: 'Client Name', key: 'name', width: 30 },
          { header: 'Credit Limit', key: 'limit', width: 15 },
          { header: 'Outstanding', key: 'outstanding', width: 15 },
          { header: 'Utilization %', key: 'utilization', width: 15 }
        ];

        creditLimitClients.forEach(c => {
          const limit = c.creditLimit || 0;
          const outstanding = c.outstandingBalance || 0;
          const utilization = limit > 0 ? (outstanding / limit) * 100 : 0;
          worksheet.addRow({
            code: c.code || 'N/A',
            name: c.name,
            limit: limit,
            outstanding: outstanding,
            utilization: utilization.toFixed(1)
          });
        });
        break;

      case 'new-clients':
        const newClients = await Client.find({
          company: companyId,
          createdAt: { $gte: reportPeriodStart, $lte: reportPeriodEnd }
        })
        .select('name code createdAt')
        .sort({ createdAt: -1 });

        worksheet.columns = [
          { header: 'Client Code', key: 'code', width: 15 },
          { header: 'Client Name', key: 'name', width: 30 },
          { header: 'Registration Date', key: 'date', width: 20 }
        ];

        newClients.forEach(c => {
          worksheet.addRow({
            code: c.code || 'N/A',
            name: c.name,
            date: c.createdAt ? new Date(c.createdAt).toLocaleDateString() : 'N/A'
          });
        });
        break;

      case 'inactive-clients':
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 90);
        
        const allClients = await Client.find({ company: companyId, isActive: true })
          .select('name code lastPurchaseDate')
          .lean();

        const inactiveClients = allClients.filter(c => {
          if (!c.lastPurchaseDate) return true;
          return new Date(c.lastPurchaseDate) < cutoffDate;
        });

        worksheet.columns = [
          { header: 'Client Code', key: 'code', width: 15 },
          { header: 'Client Name', key: 'name', width: 30 },
          { header: 'Last Purchase', key: 'lastDate', width: 20 },
          { header: 'Days Inactive', key: 'days', width: 15 }
        ];

        inactiveClients.forEach(c => {
          const lastDate = c.lastPurchaseDate ? new Date(c.lastPurchaseDate) : null;
          const days = lastDate ? Math.floor((new Date() - lastDate) / (1000 * 60 * 60 * 24)) : 'N/A';
          worksheet.addRow({
            code: c.code || 'N/A',
            name: c.name,
            lastDate: lastDate ? lastDate.toLocaleDateString() : 'No purchases',
            days: typeof days === 'number' ? days : 'N/A'
          });
        });
        break;

      // ============================================
      // NEW SALES REPORTS
      // ============================================
      case 'sales-by-product':
        const salesByProductData = await reportGeneratorService.generateSalesByProductReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Product Name', key: 'name', width: 30 },
          { header: 'Quantity Sold', key: 'quantity', width: 15 },
          { header: 'Revenue', key: 'revenue', width: 20 }
        ];
        if (salesByProductData && salesByProductData.data) {
          salesByProductData.data.forEach(item => {
            worksheet.addRow({
              sku: item.product?.sku || 'N/A',
              name: item.product?.name || 'Unknown',
              quantity: item.quantitySold || 0,
              revenue: item.revenue || 0
            });
          });
        }
        break;

      case 'sales-by-category':
        const salesByCategoryData = await reportGeneratorService.generateSalesByCategoryReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Category', key: 'category', width: 30 },
          { header: 'Products', key: 'products', width: 15 },
          { header: 'Quantity Sold', key: 'quantity', width: 15 },
          { header: 'Revenue', key: 'revenue', width: 20 }
        ];
        if (salesByCategoryData && salesByCategoryData.data) {
          salesByCategoryData.data.forEach(item => {
            worksheet.addRow({
              category: item.category || 'Uncategorized',
              products: item.productCount || 0,
              quantity: item.quantitySold || 0,
              revenue: item.revenue || 0
            });
          });
        }
        break;

      case 'sales-by-client':
        const salesByClientData = await reportGeneratorService.generateSalesByClientReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Client Code', key: 'code', width: 15 },
          { header: 'Client Name', key: 'name', width: 30 },
          { header: 'Invoice Count', key: 'count', width: 15 },
          { header: 'Total Sales', key: 'sales', width: 20 }
        ];
        if (salesByClientData && salesByClientData.data) {
          salesByClientData.data.forEach(item => {
            worksheet.addRow({
              code: item.client?.code || 'N/A',
              name: item.client?.name || 'Unknown',
              count: item.invoiceCount || 0,
              sales: item.totalSales || 0
            });
          });
        }
        break;

      case 'sales-by-salesperson':
        const salesBySalespersonData = await reportGeneratorService.generateSalesBySalespersonReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Salesperson', key: 'name', width: 30 },
          { header: 'Invoice Count', key: 'count', width: 15 },
          { header: 'Total Sales', key: 'sales', width: 20 }
        ];
        if (salesBySalespersonData && salesBySalespersonData.data) {
          salesBySalespersonData.data.forEach(item => {
            worksheet.addRow({
              name: item.salesperson?.name || 'Unknown',
              count: item.invoiceCount || 0,
              sales: item.totalSales || 0
            });
          });
        }
        break;

      case 'invoice-aging':
        const invoiceAgingData = await reportGeneratorService.generateInvoiceAgingReport(companyId);
        worksheet.columns = [
          { header: 'Invoice #', key: 'invoice', width: 20 },
          { header: 'Client', key: 'client', width: 25 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Due Date', key: 'dueDate', width: 15 },
          { header: 'Days Overdue', key: 'days', width: 15 },
          { header: 'Balance', key: 'balance', width: 15 }
        ];
        if (invoiceAgingData && invoiceAgingData.buckets) {
          const allInvoices = [...(invoiceAgingData.buckets.current || []), ...(invoiceAgingData.buckets['1-30'] || []), ...(invoiceAgingData.buckets['31-60'] || []), ...(invoiceAgingData.buckets['61-90'] || []), ...(invoiceAgingData.buckets['90+'] || [])];
          allInvoices.forEach(item => {
            worksheet.addRow({
              invoice: item.invoice?.invoiceNumber || 'N/A',
              client: item.invoice?.client?.name || 'N/A',
              date: item.invoice?.invoiceDate ? new Date(item.invoice.invoiceDate).toLocaleDateString() : 'N/A',
              dueDate: item.invoice?.dueDate ? new Date(item.invoice.dueDate).toLocaleDateString() : 'N/A',
              days: item.days || 0,
              balance: item.balance || 0
            });
          });
        }
        break;

      case 'accounts-receivable':
        const accountsReceivableData = await reportGeneratorService.generateAccountsReceivableReport(companyId);
        worksheet.columns = [
          { header: 'Invoice #', key: 'invoice', width: 20 },
          { header: 'Client', key: 'client', width: 25 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Total', key: 'total', width: 15 },
          { header: 'Paid', key: 'paid', width: 15 },
          { header: 'Balance', key: 'balance', width: 15 }
        ];
        if (accountsReceivableData && accountsReceivableData.data) {
          accountsReceivableData.data.forEach(item => {
            worksheet.addRow({
              invoice: item.invoiceNumber || 'N/A',
              client: item.client?.name || 'N/A',
              date: item.invoiceDate ? new Date(item.invoiceDate).toLocaleDateString() : 'N/A',
              total: item.total || 0,
              paid: item.paid || 0,
              balance: item.balance || 0
            });
          });
        }
        break;

      case 'credit-notes':
      case 'credit-notes-report':
        const creditNotesData = await reportGeneratorService.generateCreditNotesReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Credit Note #', key: 'number', width: 20 },
          { header: 'Client', key: 'client', width: 25 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Amount', key: 'amount', width: 15 },
          { header: 'Status', key: 'status', width: 15 }
        ];
        if (creditNotesData && creditNotesData.data) {
          creditNotesData.data.forEach(item => {
            worksheet.addRow({
              number: item.creditNoteNumber || 'N/A',
              client: item.client?.name || 'N/A',
              date: item.issueDate ? new Date(item.issueDate).toLocaleDateString() : 'N/A',
              amount: item.grandTotal || 0,
              status: item.status || 'N/A'
            });
          });
        }
        break;

      case 'quotation-conversion':
        const quotationConversionData = await reportGeneratorService.generateQuotationConversionReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Quotation #', key: 'quotation', width: 20 },
          { header: 'Client', key: 'client', width: 25 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Amount', key: 'amount', width: 15 },
          { header: 'Status', key: 'status', width: 15 }
        ];
        if (quotationConversionData && quotationConversionData.data) {
          quotationConversionData.data.forEach(item => {
            worksheet.addRow({
              quotation: item.quotationNumber || 'N/A',
              client: item.client?.name || 'N/A',
              date: item.quotationDate ? new Date(item.quotationDate).toLocaleDateString() : 'N/A',
              amount: item.grandTotal || 0,
              status: item.status || 'N/A'
            });
          });
        }
        break;

      case 'recurring-invoice':
        const recurringInvoiceData = await reportGeneratorService.generateRecurringInvoiceReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Invoice #', key: 'invoice', width: 20 },
          { header: 'Client', key: 'client', width: 25 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Amount', key: 'amount', width: 15 },
          { header: 'Status', key: 'status', width: 15 }
        ];
        if (recurringInvoiceData && recurringInvoiceData.data) {
          recurringInvoiceData.data.forEach(item => {
            worksheet.addRow({
              invoice: item.invoiceNumber || 'N/A',
              client: item.client?.name || 'N/A',
              date: item.invoiceDate ? new Date(item.invoiceDate).toLocaleDateString() : 'N/A',
              amount: item.grandTotal || 0,
              status: item.status || 'N/A'
            });
          });
        }
        break;

      case 'discount-report':
        const discountData = await reportGeneratorService.generateDiscountReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Invoice #', key: 'invoice', width: 20 },
          { header: 'Client', key: 'client', width: 25 },
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Subtotal', key: 'subtotal', width: 15 },
          { header: 'Discount', key: 'discount', width: 15 },
          { header: 'Discount %', key: 'discountPercent', width: 15 }
        ];
        if (discountData && discountData.data) {
          discountData.data.forEach(item => {
            worksheet.addRow({
              invoice: item.invoiceNumber || 'N/A',
              client: item.client?.name || 'N/A',
              date: item.invoiceDate ? new Date(item.invoiceDate).toLocaleDateString() : 'N/A',
              subtotal: item.subtotal || 0,
              discount: item.totalDiscount || 0,
              discountPercent: item.discountPercent || 0
            });
          });
        }
        break;

      case 'daily-sales-summary':
        const dailySalesData = await reportGeneratorService.generateDailySalesSummaryReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Invoices', key: 'invoices', width: 15 },
          { header: 'Sales', key: 'sales', width: 20 },
          { header: 'Tax', key: 'tax', width: 15 },
          { header: 'Discounts', key: 'discounts', width: 15 },
          { header: 'Net Sales', key: 'netSales', width: 20 }
        ];
        if (dailySalesData && dailySalesData.dailyData) {
          dailySalesData.dailyData.forEach(item => {
            worksheet.addRow({
              date: item.date || 'N/A',
              invoices: item.invoiceCount || 0,
              sales: item.totalSales || 0,
              taxes: item.totalTax || 0,
              discounts: item.totalDiscounts || 0,
              netSales: item.netSales || 0
            });
          });
        }
        break;

      // ============================================
      // EXPENSE REPORTS
      // ============================================
      case 'expense-by-category':
        const expenseByCategoryData = await reportGeneratorService.generateExpenseByCategoryReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Category', key: 'category', width: 30 },
          { header: 'Description', key: 'description', width: 40 },
          { header: 'Amount', key: 'amount', width: 20 }
        ];
        if (expenseByCategoryData && expenseByCategoryData.data) {
          expenseByCategoryData.data.forEach(item => {
            worksheet.addRow({
              category: item.category || 'N/A',
              description: item.description || '',
              amount: item.total || 0
            });
          });
        }
        break;

      case 'expense-by-period':
        const expenseByPeriodData = await reportGeneratorService.generateExpenseByPeriodReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Period', key: 'period', width: 20 },
          { header: 'Category', key: 'category', width: 25 },
          { header: 'Amount', key: 'amount', width: 20 }
        ];
        if (expenseByPeriodData && expenseByPeriodData.data) {
          expenseByPeriodData.data.forEach(item => {
            worksheet.addRow({
              period: item.period || 'N/A',
              category: item.category || 'N/A',
              amount: item.total || 0
            });
          });
        }
        break;

      case 'expense-vs-budget':
        const expenseVsBudgetData = await reportGeneratorService.generateExpenseVsBudgetReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Category', key: 'category', width: 30 },
          { header: 'Budget', key: 'budget', width: 20 },
          { header: 'Actual', key: 'actual', width: 20 },
          { header: 'Variance', key: 'variance', width: 20 },
          { header: 'Variance %', key: 'variancePercent', width: 15 }
        ];
        if (expenseVsBudgetData && expenseVsBudgetData.data) {
          expenseVsBudgetData.data.forEach(item => {
            worksheet.addRow({
              category: item.category || 'N/A',
              budget: item.budget || 0,
              actual: item.actual || 0,
              variance: item.variance || 0,
              variancePercent: item.variancePercent || 0
            });
          });
        }
        break;

      case 'employee-expense':
        const employeeExpenseData = await reportGeneratorService.generateEmployeeExpenseReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Employee', key: 'employee', width: 30 },
          { header: 'Category', key: 'category', width: 25 },
          { header: 'Count', key: 'count', width: 15 },
          { header: 'Total Amount', key: 'amount', width: 20 }
        ];
        if (employeeExpenseData && employeeExpenseData.data) {
          employeeExpenseData.data.forEach(item => {
            worksheet.addRow({
              employee: item.employee || 'N/A',
              category: item.category || 'N/A',
              count: item.count || 0,
              amount: item.total || 0
            });
          });
        }
        break;

      case 'petty-cash':
        const pettyCashData = await reportGeneratorService.generatePettyCashReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Description', key: 'description', width: 40 },
          { header: 'Category', key: 'category', width: 25 },
          { header: 'Amount', key: 'amount', width: 20 },
          { header: 'Status', key: 'status', width: 15 }
        ];
        if (pettyCashData && pettyCashData.data) {
          pettyCashData.data.forEach(item => {
            worksheet.addRow({
              date: item.date ? new Date(item.date).toLocaleDateString() : 'N/A',
              description: item.description || '',
              category: item.category || 'N/A',
              amount: item.amount || 0,
              status: item.status || 'N/A'
            });
          });
        }
        break;

      // ============================================
      // TAX REPORTS
      // ============================================
      case 'vat-return':
        const vatReturnData = await reportGeneratorService.generateVATReturnReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Amount', key: 'amount', width: 20 }
        ];
        if (vatReturnData && vatReturnData.data) {
          worksheet.addRow({ description: 'Output VAT (Sales)', amount: vatReturnData.data.outputVAT.totalVAT || 0 });
          worksheet.addRow({ description: 'Input VAT (Purchases)', amount: vatReturnData.data.inputVAT.totalVAT || 0 });
          worksheet.addRow({ description: 'Net VAT', amount: vatReturnData.data.netVAT || 0 });
        }
        break;

      case 'paye-report':
        const payeData = await reportGeneratorService.generatePAYEReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Amount', key: 'amount', width: 20 }
        ];
        if (payeData && payeData.data) {
          worksheet.addRow({ description: 'Total Employees', amount: payeData.data.totalEmployees || 0 });
          worksheet.addRow({ description: 'Total Gross Salary', amount: payeData.data.totalGrossSalary || 0 });
          worksheet.addRow({ description: 'Total PAYE', amount: payeData.data.totalPAYE || 0 });
          worksheet.addRow({ description: 'Total RSSB', amount: payeData.data.totalRSSB || 0 });
        }
        break;

      case 'withholding-tax':
        const whtData = await reportGeneratorService.generateWithholdingTaxReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Amount', key: 'amount', width: 20 }
        ];
        if (whtData && whtData.data) {
          worksheet.addRow({ description: 'Withholding Tax Collected', amount: whtData.data.withholdingTaxCollected.amount || 0 });
          worksheet.addRow({ description: 'Withholding Tax Paid', amount: whtData.data.withholdingTaxPaid.amount || 0 });
          worksheet.addRow({ description: 'Net Withholding', amount: whtData.data.netWithholding || 0 });
        }
        break;

      case 'corporate-tax':
        const corpTaxData = await reportGeneratorService.generateCorporateTaxReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Amount', key: 'amount', width: 20 }
        ];
        if (corpTaxData && corpTaxData.data) {
          worksheet.addRow({ description: 'Gross Income', amount: corpTaxData.data.grossIncome || 0 });
          worksheet.addRow({ description: 'Total Deductions', amount: corpTaxData.data.deductions.total || 0 });
          worksheet.addRow({ description: 'Taxable Income', amount: corpTaxData.data.taxableIncome || 0 });
          worksheet.addRow({ description: 'Corporate Tax (30%)', amount: corpTaxData.data.corporateTax || 0 });
        }
        break;

      case 'tax-payment-history':
        const taxPayData = await reportGeneratorService.generateTaxPaymentHistory(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Date', key: 'date', width: 15 },
          { header: 'Tax Type', key: 'taxType', width: 20 },
          { header: 'Amount', key: 'amount', width: 15 },
          { header: 'Status', key: 'status', width: 15 }
        ];
        if (taxPayData && taxPayData.data && taxPayData.data.payments) {
          taxPayData.data.payments.forEach(item => {
            worksheet.addRow({
              date: item.date ? new Date(item.date).toLocaleDateString() : 'N/A',
              taxType: item.taxType || 'N/A',
              amount: item.amount || 0,
              status: item.status || 'N/A'
            });
          });
        }
        break;

      case 'tax-calendar':
        const taxCalData = await reportGeneratorService.generateTaxCalendarReport(companyId, reportPeriodStart ? new Date(reportPeriodStart).getFullYear().toString() : null);
        worksheet.columns = [
          { header: 'Tax Type', key: 'taxType', width: 20 },
          { header: 'Period', key: 'period', width: 20 },
          { header: 'Due Date', key: 'dueDate', width: 15 },
          { header: 'Status', key: 'status', width: 15 }
        ];
        if (taxCalData && taxCalData.data && taxCalData.data.calendar) {
          taxCalData.data.calendar.forEach(item => {
            worksheet.addRow({
              taxType: item.taxName || 'N/A',
              period: item.period || 'N/A',
              dueDate: item.dueDate ? new Date(item.dueDate).toLocaleDateString() : 'N/A',
              status: item.status || 'N/A'
            });
          });
        }
        break;

      // ============================================
      // ASSET REPORTS
      // ============================================
      case 'asset-register':
        const assetRegData = await reportGeneratorService.generateAssetRegisterReport(companyId);
        worksheet.columns = [
          { header: 'Asset Code', key: 'assetCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Category', key: 'category', width: 15 },
          { header: 'Status', key: 'status', width: 12 },
          { header: 'Location', key: 'location', width: 15 },
          { header: 'Purchase Date', key: 'purchaseDate', width: 15 },
          { header: 'Purchase Cost', key: 'purchaseCost', width: 15 },
          { header: 'Accum. Depreciation', key: 'accumulatedDepreciation', width: 18 },
          { header: 'Net Book Value', key: 'netBookValue', width: 15 },
          { header: 'Useful Life (Years)', key: 'usefulLifeYears', width: 18 }
        ];
        if (assetRegData && assetRegData.data) {
          assetRegData.data.forEach(item => {
            worksheet.addRow({
              assetCode: item.assetCode || 'N/A',
              name: item.name || 'N/A',
              category: item.category || 'N/A',
              status: item.status || 'N/A',
              location: item.location || 'N/A',
              purchaseDate: item.purchaseDate ? new Date(item.purchaseDate).toLocaleDateString() : 'N/A',
              purchaseCost: item.purchaseCost || 0,
              accumulatedDepreciation: item.accumulatedDepreciation || 0,
              netBookValue: item.netBookValue || 0,
              usefulLifeYears: item.usefulLifeYears || 0
            });
          });
        }
        break;

      case 'depreciation-schedule':
        const depSchedData = await reportGeneratorService.generateDepreciationScheduleReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Asset Code', key: 'assetCode', width: 15 },
          { header: 'Asset Name', key: 'assetName', width: 25 },
          { header: 'Category', key: 'category', width: 15 },
          { header: 'Year', key: 'year', width: 10 },
          { header: 'Annual Depreciation', key: 'annualDepreciation', width: 18 },
          { header: 'Accumulated Depreciation', key: 'accumulatedDepreciation', width: 20 },
          { header: 'Net Book Value', key: 'netBookValue', width: 15 }
        ];
        if (depSchedData && depSchedData.data) {
          depSchedData.data.forEach(asset => {
            if (asset.schedule) {
              asset.schedule.forEach(period => {
                worksheet.addRow({
                  assetCode: asset.assetCode || 'N/A',
                  assetName: asset.assetName || 'N/A',
                  category: asset.category || 'N/A',
                  year: period.year || 'N/A',
                  annualDepreciation: period.annualDepreciation || 0,
                  accumulatedDepreciation: period.accumulatedDepreciation || 0,
                  netBookValue: period.netBookValue || 0
                });
              });
            }
          });
        }
        break;

      case 'asset-disposal':
        const assetDispData = await reportGeneratorService.generateAssetDisposalReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Asset Code', key: 'assetCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Category', key: 'category', width: 15 },
          { header: 'Purchase Date', key: 'purchaseDate', width: 15 },
          { header: 'Purchase Cost', key: 'purchaseCost', width: 15 },
          { header: 'Accum. Depreciation', key: 'accumulatedDepreciation', width: 18 },
          { header: 'Net Book Value', key: 'netBookValue', width: 15 },
          { header: 'Disposal Date', key: 'disposalDate', width: 15 },
          { header: 'Disposal Amount', key: 'disposalAmount', width: 15 },
          { header: 'Disposal Method', key: 'disposalMethod', width: 15 },
          { header: 'Gain/Loss', key: 'gainLoss', width: 12 }
        ];
        if (assetDispData && assetDispData.data) {
          assetDispData.data.forEach(item => {
            worksheet.addRow({
              assetCode: item.assetCode || 'N/A',
              name: item.name || 'N/A',
              category: item.category || 'N/A',
              purchaseDate: item.purchaseDate ? new Date(item.purchaseDate).toLocaleDateString() : 'N/A',
              purchaseCost: item.purchaseCost || 0,
              accumulatedDepreciation: item.accumulatedDepreciation || 0,
              netBookValue: item.netBookValue || 0,
              disposalDate: item.disposalDate ? new Date(item.disposalDate).toLocaleDateString() : 'N/A',
              disposalAmount: item.disposalAmount || 0,
              disposalMethod: item.disposalMethod || 'N/A',
              gainLoss: item.gainLoss || 0
            });
          });
        }
        break;

      case 'asset-maintenance':
        const assetMaintData = await reportGeneratorService.generateAssetMaintenanceReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Asset Code', key: 'assetCode', width: 15 },
          { header: 'Asset Name', key: 'assetName', width: 25 },
          { header: 'Category', key: 'category', width: 15 },
          { header: 'Maintenance Date', key: 'date', width: 15 },
          { header: 'Type', key: 'type', width: 12 },
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Cost', key: 'cost', width: 12 },
          { header: 'Vendor', key: 'vendor', width: 20 }
        ];
        if (assetMaintData && assetMaintData.data) {
          assetMaintData.data.forEach(asset => {
            if (asset.maintenanceRecords) {
              asset.maintenanceRecords.forEach(record => {
                worksheet.addRow({
                  assetCode: asset.assetCode || 'N/A',
                  assetName: asset.assetName || 'N/A',
                  category: asset.category || 'N/A',
                  date: record.date ? new Date(record.date).toLocaleDateString() : 'N/A',
                  type: record.type || 'N/A',
                  description: record.description || 'N/A',
                  cost: record.cost || 0,
                  vendor: record.vendor || 'N/A'
                });
              });
            }
          });
        }
        break;

      case 'net-book-value':
        const nbvData = await reportGeneratorService.generateNetBookValueReport(companyId);
        worksheet.columns = [
          { header: 'Asset Code', key: 'assetCode', width: 15 },
          { header: 'Name', key: 'name', width: 25 },
          { header: 'Category', key: 'category', width: 15 },
          { header: 'Status', key: 'status', width: 12 },
          { header: 'Location', key: 'location', width: 15 },
          { header: 'Purchase Cost', key: 'purchaseCost', width: 15 },
          { header: 'Accum. Depreciation', key: 'accumulatedDepreciation', width: 18 },
          { header: 'Net Book Value', key: 'netBookValue', width: 15 },
          { header: 'Remaining Life (Years)', key: 'remainingLife', width: 20 }
        ];
        if (nbvData && nbvData.data) {
          nbvData.data.forEach(item => {
            worksheet.addRow({
              assetCode: item.assetCode || 'N/A',
              name: item.name || 'N/A',
              category: item.category || 'N/A',
              status: item.status || 'N/A',
              location: item.location || 'N/A',
              purchaseCost: item.purchaseCost || 0,
              accumulatedDepreciation: item.accumulatedDepreciation || 0,
              netBookValue: item.netBookValue || 0,
              remainingLife: item.remainingLife ? item.remainingLife.toFixed(1) : '0'
            });
          });
        }
        break;

      // ============================================
      // STOCK & INVENTORY REPORTS
      // ============================================
      case 'stock-movement':
        const stockMovData = await reportGeneratorService.generateStockMovementReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Product Name', key: 'name', width: 30 },
          { header: 'Total In', key: 'totalIn', width: 12 },
          { header: 'Total Out', key: 'totalOut', width: 12 },
          { header: 'Net Change', key: 'netChange', width: 12 },
          { header: 'Movements', key: 'movements', width: 12 }
        ];
        if (stockMovData && stockMovData.data) {
          stockMovData.data.forEach(item => {
            worksheet.addRow({
              sku: item.product?.sku || 'N/A',
              name: item.product?.name || 'Unknown',
              totalIn: item.totalIn || 0,
              totalOut: item.totalOut || 0,
              netChange: item.netChange || 0,
              movements: item.movementCount || 0
            });
          });
        }
        break;

      case 'low-stock':
        const lowStockData = await reportGeneratorService.generateLowStockReport(companyId);
        worksheet.columns = [
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Product Name', key: 'name', width: 30 },
          { header: 'Current Stock', key: 'stock', width: 12 },
          { header: 'Threshold', key: 'threshold', width: 12 },
          { header: 'Shortage', key: 'shortage', width: 12 },
          { header: 'Est. Reorder Cost', key: 'reorderCost', width: 15 }
        ];
        if (lowStockData && lowStockData.data) {
          lowStockData.data.forEach(item => {
            worksheet.addRow({
              sku: item.sku || 'N/A',
              name: item.name || 'Unknown',
              stock: item.currentStock || 0,
              threshold: item.lowStockThreshold || 0,
              shortage: item.shortage || 0,
              reorderCost: item.estimatedReorderCost || 0
            });
          });
        }
        break;

      case 'dead-stock':
        const deadStockData = await reportGeneratorService.generateDeadStockReport(companyId);
        worksheet.columns = [
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Product Name', key: 'name', width: 30 },
          { header: 'Current Stock', key: 'stock', width: 12 },
          { header: 'Stock Value', key: 'value', width: 15 },
          { header: 'Days Since Movement', key: 'days', width: 15 }
        ];
        if (deadStockData && deadStockData.data) {
          deadStockData.data.forEach(item => {
            worksheet.addRow({
              sku: item.sku || 'N/A',
              name: item.name || 'Unknown',
              stock: item.currentStock || 0,
              value: item.stockValue || 0,
              days: item.daysSinceMovement || 0
            });
          });
        }
        break;

      case 'stock-aging':
        const stockAgingData = await reportGeneratorService.generateStockAgingReport(companyId);
        worksheet.columns = [
          { header: 'Batch', key: 'batch', width: 15 },
          { header: 'Product', key: 'product', width: 25 },
          { header: 'Quantity', key: 'quantity', width: 12 },
          { header: 'Value', key: 'value', width: 15 },
          { header: 'Days Old', key: 'days', width: 12 },
          { header: 'Status', key: 'status', width: 12 }
        ];
        if (stockAgingData && stockAgingData.data) {
          const allBatches = [
            ...(stockAgingData.data['0-30'] || []),
            ...(stockAgingData.data['31-60'] || []),
            ...(stockAgingData.data['61-90'] || []),
            ...(stockAgingData.data['91-180'] || []),
            ...(stockAgingData.data['180+'] || [])
          ];
          allBatches.forEach(item => {
            worksheet.addRow({
              batch: item.batchNumber || 'N/A',
              product: item.product?.name || 'Unknown',
              quantity: item.quantity || 0,
              value: item.totalValue || 0,
              days: item.daysOld || 0,
              status: item.status || 'N/A'
            });
          });
        }
        break;

      case 'inventory-turnover':
        const invTurnoverData = await reportGeneratorService.generateInventoryTurnoverReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Product Name', key: 'name', width: 30 },
          { header: 'Inventory Value', key: 'value', width: 15 },
          { header: 'COGS', key: 'cogs', width: 15 },
          { header: 'Turnover', key: 'turnover', width: 12 },
          { header: 'Turnover Days', key: 'days', width: 12 }
        ];
        if (invTurnoverData && invTurnoverData.data) {
          invTurnoverData.data.forEach(item => {
            worksheet.addRow({
              sku: item.sku || 'N/A',
              name: item.name || 'Unknown',
              value: item.inventoryValue || 0,
              cogs: item.cogs || 0,
              turnover: item.turnover || 0,
              days: item.turnoverDays || 0
            });
          });
        }
        break;

      case 'batch-expiry':
        const batchExpiryData = await reportGeneratorService.generateBatchExpiryReport(companyId);
        worksheet.columns = [
          { header: 'Batch', key: 'batch', width: 15 },
          { header: 'Product', key: 'product', width: 25 },
          { header: 'Quantity', key: 'quantity', width: 12 },
          { header: 'Expiry Date', key: 'expiry', width: 15 },
          { header: 'Days Left', key: 'days', width: 12 },
          { header: 'Status', key: 'status', width: 12 }
        ];
        if (batchExpiryData && batchExpiryData.data) {
          batchExpiryData.data.forEach(item => {
            worksheet.addRow({
              batch: item.batchNumber || 'N/A',
              product: item.product?.name || 'Unknown',
              quantity: item.quantity || 0,
              expiry: item.expiryDate ? new Date(item.expiryDate).toLocaleDateString() : 'N/A',
              days: item.daysUntilExpiry || 0,
              status: item.status || 'N/A'
            });
          });
        }
        break;

      case 'serial-number-tracking':
        const serialData = await reportGeneratorService.generateSerialNumberTrackingReport(companyId);
        worksheet.columns = [
          { header: 'Serial Number', key: 'serial', width: 20 },
          { header: 'Product', key: 'product', width: 25 },
          { header: 'Status', key: 'status', width: 12 },
          { header: 'Purchase Date', key: 'purchase', width: 15 },
          { header: 'Sale Date', key: 'sale', width: 15 },
          { header: 'Client', key: 'client', width: 20 }
        ];
        if (serialData && serialData.data) {
          serialData.data.forEach(item => {
            worksheet.addRow({
              serial: item.serialNumber || 'N/A',
              product: item.product?.name || 'Unknown',
              status: item.status || 'N/A',
              purchase: item.purchaseDate ? new Date(item.purchaseDate).toLocaleDateString() : 'N/A',
              sale: item.saleDate ? new Date(item.saleDate).toLocaleDateString() : 'N/A',
              client: item.client?.name || 'N/A'
            });
          });
        }
        break;

      case 'warehouse-stock':
        const warehouseStockData = await reportGeneratorService.generateWarehouseStockReport(companyId);
        worksheet.columns = [
          { header: 'Warehouse', key: 'warehouse', width: 25 },
          { header: 'Code', key: 'code', width: 10 },
          { header: 'Products', key: 'products', width: 12 },
          { header: 'Total Quantity', key: 'quantity', width: 15 },
          { header: 'Total Value', key: 'value', width: 15 }
        ];
        if (warehouseStockData && warehouseStockData.data) {
          warehouseStockData.data.forEach(item => {
            worksheet.addRow({
              warehouse: item.name || 'Unknown',
              code: item.code || 'N/A',
              products: item.totalProducts || 0,
              quantity: item.totalQuantity || 0,
              value: item.totalValue || 0
            });
          });
        }
        break;

      // ============================================
      // BANK & CASH REPORTS
      // ============================================
      case 'bank-reconciliation':
        const bankReconData = await reportGeneratorService.generateBankReconciliationReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Account', key: 'accountName', width: 25 },
          { header: 'Type', key: 'accountType', width: 15 },
          { header: 'Bank', key: 'bankName', width: 20 },
          { header: 'Opening Balance', key: 'openingBalance', width: 15 },
          { header: 'Deposits', key: 'totalDeposits', width: 15 },
          { header: 'Withdrawals', key: 'totalWithdrawals', width: 15 },
          { header: 'Closing Balance', key: 'closingBalance', width: 15 },
          { header: 'Reconciled', key: 'reconciledAmount', width: 15 },
          { header: 'Unreconciled', key: 'unreconciledAmount', width: 15 }
        ];
        if (bankReconData && bankReconData.data) {
          bankReconData.data.forEach(item => {
            worksheet.addRow({
              accountName: item.accountName || 'N/A',
              accountType: item.accountType || 'N/A',
              bankName: item.bankName || 'N/A',
              openingBalance: item.openingBalance || 0,
              totalDeposits: item.totalDeposits || 0,
              totalWithdrawals: item.totalWithdrawals || 0,
              closingBalance: item.closingBalance || 0,
              reconciledAmount: item.reconciledAmount || 0,
              unreconciledAmount: item.unreconciledAmount || 0
            });
          });
        }
        break;

      case 'cash-position':
        const cashPosData = await reportGeneratorService.generateCashPositionReport(companyId);
        worksheet.columns = [
          { header: 'Account Name', key: 'name', width: 25 },
          { header: 'Type', key: 'accountType', width: 15 },
          { header: 'Bank', key: 'bankName', width: 20 },
          { header: 'Account Number', key: 'accountNumber', width: 20 },
          { header: 'Current Balance', key: 'currentBalance', width: 15 },
          { header: 'Target Balance', key: 'targetBalance', width: 15 },
          { header: 'Currency', key: 'currency', width: 10 },
          { header: 'Primary', key: 'isPrimary', width: 10 }
        ];
        if (cashPosData && cashPosData.data) {
          cashPosData.data.forEach(item => {
            worksheet.addRow({
              name: item.name || 'N/A',
              accountType: item.accountType || 'N/A',
              bankName: item.bankName || 'N/A',
              accountNumber: item.accountNumber || 'N/A',
              currentBalance: item.currentBalance || 0,
              targetBalance: item.targetBalance || 0,
              currency: item.currency || 'FRW',
              isPrimary: item.isPrimary ? 'Yes' : 'No'
            });
          });
        }
        break;

      case 'bank-transaction':
        const bankTxnData = await reportGeneratorService.generateBankTransactionReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Date', key: 'date', width: 12 },
          { header: 'Account', key: 'accountName', width: 20 },
          { header: 'Type', key: 'type', width: 12 },
          { header: 'Amount', key: 'amount', width: 15 },
          { header: 'Balance After', key: 'balanceAfter', width: 15 },
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Reference', key: 'referenceNumber', width: 20 },
          { header: 'Status', key: 'status', width: 12 }
        ];
        if (bankTxnData && bankTxnData.data) {
          bankTxnData.data.forEach(item => {
            worksheet.addRow({
              date: item.date ? new Date(item.date).toLocaleDateString() : 'N/A',
              accountName: item.accountName || 'N/A',
              type: item.type || 'N/A',
              amount: item.amount || 0,
              balanceAfter: item.balanceAfter || 0,
              description: item.description || '',
              referenceNumber: item.referenceNumber || '',
              status: item.status || 'N/A'
            });
          });
        }
        break;

      case 'unreconciled-transactions':
        const unreconciledData = await reportGeneratorService.generateUnreconciledTransactionsReport(companyId, reportPeriodStart, reportPeriodEnd);
        worksheet.columns = [
          { header: 'Date', key: 'date', width: 12 },
          { header: 'Account', key: 'accountName', width: 20 },
          { header: 'Type', key: 'type', width: 12 },
          { header: 'Amount', key: 'amount', width: 15 },
          { header: 'Description', key: 'description', width: 30 },
          { header: 'Reference Number', key: 'referenceNumber', width: 20 },
          { header: 'Status', key: 'status', width: 12 }
        ];
        if (unreconciledData && unreconciledData.data) {
          unreconciledData.data.forEach(item => {
            worksheet.addRow({
              date: item.date ? new Date(item.date).toLocaleDateString() : 'N/A',
              accountName: item.accountName || 'N/A',
              type: item.type || 'N/A',
              amount: item.amount || 0,
              description: item.description || '',
              referenceNumber: item.referenceNumber || '',
              status: item.status || 'N/A'
            });
          });
        }
        break;

      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid report type'
        });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${reportType}-report.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

// @desc    Export report to PDF
// @route   GET /api/reports/export/pdf/:reportType
// @access  Private

// Helper function to truncate text to fit within a width
function truncateText(text, maxLength) {
  if (!text) return '-';
  const str = String(text);
  // Ensure maxLength is at least 10 to prevent overly short text
  const safeMax = Math.max(10, maxLength);
  return str.length > safeMax ? str.substring(0, safeMax - 3) + '...' : str;
};

// Helper to render table header with proper styling
function renderTableHeader(doc, headers, colWidths, leftMargin = 30) {
  const headerHeight = 25;
  doc.rect(leftMargin - 5, doc.y - 2, colWidths.reduce((a, b) => a + b, 0) + 10, headerHeight).fill('#1e40af');
  doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
  
  let x = leftMargin;
  headers.forEach((header, i) => {
    doc.text(header, x, doc.y + 3, { width: colWidths[i], align: 'left' });
    x += colWidths[i];
  });
  
  doc.moveDown(1);
  doc.fillColor('#000000').font('Helvetica').fontSize(8);
  return doc.y;
};

// Helper to render a table row with borders and proper spacing
function renderTableRow(doc, rowData, colWidths, leftMargin = 30, rowIndex = 0, options = {}) {
  const { zebraColor = '#f3f4f6', minHeight = 20 } = options;
  
  // Zebra striping
  if (rowIndex % 2 === 0) {
    doc.rect(leftMargin - 5, doc.y - 2, colWidths.reduce((a, b) => a + b, 0) + 10, minHeight).fill(zebraColor);
  }
  
  doc.fillColor('#111827').fontSize(8);
  let x = leftMargin;
  rowData.forEach((cell, i) => {
    const text = String(cell || '-');
    // Right-align numeric columns (last 3 columns typically)
    const align = i >= colWidths.length - 3 ? 'right' : 'left';
    doc.text(text, x, doc.y, { width: colWidths[i], align });
    x += colWidths[i];
  });
  
  doc.moveDown(0.5);
};

// Improved helper to calculate optimal column widths based on content
function calculateOptimalColumnWidths(doc, headers, data, options = {}) {
  const { leftMargin = 30, rightMargin = 30, minWidth = 40, maxWidth = 200 } = options;
  const pageWidth = doc.page?.width || 612; // Default to letter size (612pt)
  const availableWidth = pageWidth - leftMargin - rightMargin;
  const numCols = headers.length;
  
  // Calculate max content width for each column
  const maxContentWidths = headers.map((header, i) => {
    // Base width on header length (minimum 50pt for headers)
    let maxW = Math.max(header.length * 8, 50);
    
    // Check all data rows for this column
    data.forEach(row => {
      if (row && row[i]) {
        // Estimate width: each character is about 6-7pt in Helvetica 8pt
        const cellWidth = String(row[i]).length * 7;
        maxW = Math.max(maxW, cellWidth);
      }
    });
    
    // Cap at maxWidth
    return Math.max(minWidth, Math.min(maxW, maxWidth));
  });
  
  // Normalize to fit page exactly
  const totalContentWidth = maxContentWidths.reduce((a, b) => a + b, 0);
  
  if (totalContentWidth > availableWidth) {
    // Scale down proportionally
    const scale = availableWidth / totalContentWidth;
    return maxContentWidths.map(w => Math.max(minWidth, Math.floor(w * scale)));
  }
  
  // If we have extra space, distribute proportionally
  const extraSpace = availableWidth - totalContentWidth;
  const bonusPerColumn = Math.floor(extraSpace / numCols);
  return maxContentWidths.map(w => w + bonusPerColumn);
};

// NEW: Helper function to get responsive column widths based on page size
function getResponsiveColumnWidths(doc, colPercents, leftMargin = 30, rightMargin = 30) {
  const pageWidth = doc.page?.width || 612; // Default to letter size
  const availableWidth = Math.round(pageWidth - leftMargin - rightMargin);
  
  let colWidths = colPercents.map(p => Math.floor(availableWidth * p));
  
  // Fix rounding error by ensuring last column fills remainder
  const widthsSum = colWidths.reduce((s, v) => s + v, 0);
  if (widthsSum < availableWidth) {
    colWidths[colWidths.length - 1] += (availableWidth - widthsSum);
  }
  
  return colWidths;
}

// NEW: Helper function to check and add new page if needed
function checkPageOverflow(doc, requiredSpace = 80) {
  if (doc.y > doc.page.height - requiredSpace) {
    doc.addPage();
    return true;
  }
  return false;
}

// NEW: Standardized table renderer for consistent formatting across all reports
function renderStandardTable(doc, options) {
  const {
    headers,
    data,
    colWidths: initialColWidths,
    leftMargin = 30,
    rightMargin = 30,
    headerBgColor = '#1e40af',
    headerTextColor = '#ffffff',
    zebraColor = '#f9fafb',
    fontSize = 9,
    rowHeight = 18,
    alignLastRight = true
  } = options;

  // Calculate optimal column widths if not provided
  let colWidths = initialColWidths;
  if (!colWidths || colWidths.length === 0) {
    colWidths = calculateOptimalColumnWidths(doc, headers, data, { leftMargin, rightMargin });
  } else if (typeof colWidths[0] === 'number' && colWidths[0] < 1) {
    // If values are decimals (percentages), convert to absolute widths
    colWidths = getResponsiveColumnWidths(doc, colWidths, leftMargin, rightMargin);
  }

  // Render header
  doc.rect(leftMargin - 5, doc.y - 2, colWidths.reduce((a, b) => a + b, 0) + 10, rowHeight).fill(headerBgColor);
  doc.fillColor(headerTextColor).fontSize(fontSize).font('Helvetica-Bold');
  
  let x = leftMargin;
  headers.forEach((header, i) => {
    doc.text(header, x, doc.y + 3, { width: colWidths[i], align: 'left' });
    x += colWidths[i];
  });
  
  doc.moveDown(0.5);
  doc.fillColor('#000000').font('Helvetica').fontSize(fontSize - 1);

  // Render rows
  data.forEach((row, idx) => {
    // Check for page overflow
    if (checkPageOverflow(doc, 60)) {
      // Reprint header on new page
      doc.rect(leftMargin - 5, doc.y - 2, colWidths.reduce((a, b) => a + b, 0) + 10, rowHeight).fill(headerBgColor);
      doc.fillColor(headerTextColor).fontSize(fontSize).font('Helvetica-Bold');
      x = leftMargin;
      headers.forEach((header, i) => {
        doc.text(header, x, doc.y + 3, { width: colWidths[i], align: 'left' });
        x += colWidths[i];
      });
      doc.moveDown(0.5);
      doc.fillColor('#000000').font('Helvetica').fontSize(fontSize - 1);
    }
    
    // Zebra striping
    if (idx % 2 === 0) {
      doc.rect(leftMargin - 5, doc.y - 2, colWidths.reduce((a, b) => a + b, 0) + 10, rowHeight).fill(zebraColor);
    }
    
    x = leftMargin;
    row.forEach((cell, i) => {
      const cellText = truncateText(String(cell || '-'), colWidths[i] / 6);
      const align = (alignLastRight && i >= row.length - 1) ? 'right' : 'left';
      doc.text(cellText, x, doc.y, { width: colWidths[i], align });
      x += colWidths[i];
    });
    doc.moveDown(0.4);
  });

  return colWidths;
}

exports.exportReportToPDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reportType } = req.params;
    const { periodType, year, periodNumber, startDate, endDate, clientId, supplierId } = req.query;
    const doc = new PDFDocument({ margin: 50 });

    // Determine period dates for the report
    let reportPeriodStart, reportPeriodEnd;
    if (periodType && year) {
      const periodYear = parseInt(year);
      const periodNum = periodNumber ? parseInt(periodNumber) : 1;
      const periodInfo = reportGeneratorService.getPeriodDates(periodType, periodYear, periodNum);
      reportPeriodStart = new Date(periodInfo.startDate);
      reportPeriodEnd = new Date(periodInfo.endDate);
    } else if (startDate && endDate) {
      reportPeriodStart = new Date(startDate);
      reportPeriodEnd = new Date(endDate);
    } else {
      // Default to current quarter
      const now = new Date();
      reportPeriodStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      reportPeriodEnd = new Date();
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${reportType}-report.pdf`);

    doc.pipe(res);

    // Helper function to print a label and amount on the same line (used by P&L reports)
    function printLine(label, amount, y, indent = 0) {
      const leftMargin = 50 + indent;
      const amountX = 400;
      const formattedAmount = typeof amount === 'number' 
        ? amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) 
        : '0.00';
      doc.text(label, leftMargin, y || doc.y, { width: 300, align: 'left' });
      doc.text(formattedAmount, amountX, y || doc.y, { width: 100, align: 'right' });
    }

    // Helper function to calculate responsive column widths from percentages
    function getResponsiveColWidths(percentages, leftMargin = 50, rightMargin = 50) {
      const pageWidth = doc.page.width || 595; // Default A4 width
      const availableWidth = Math.round(pageWidth - leftMargin - rightMargin);
      return percentages.map(p => Math.floor(availableWidth * p));
    }

    doc.fontSize(20).text(`${reportType.toUpperCase().replace('-', ' ')} REPORT`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    switch (reportType) {
      case 'products':
      case 'stock-valuation':
        const productsPdf = await Product.find({ isArchived: false, company: companyId })
          .populate('category', 'name')
          .sort({ name: 1 });

        // Get company info
        const companyPdf = await Company.findById(companyId);
        
        doc.fontSize(16).text(companyPdf?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyPdf?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('PRODUCTS INVENTORY REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);

        // Use same approach as Suppliers report
        const productHeaders = ['SKU', 'Product Name', 'Category', 'Unit', 'Stock', 'Unit Cost', 'Total Value'];
        
        // Compute responsive column widths - use fallback if page.width is undefined
        const prodLeftMargin = 30;
        const prodRightMargin = 30;
        const pageWidth = doc.page?.width || 612; // Default to letter size (612pt)
        const prodAvailableWidth = Math.round(pageWidth - prodLeftMargin - prodRightMargin);
        const productColPercents = [0.10, 0.25, 0.15, 0.06, 0.10, 0.12, 0.12];
        let productColWidths = productColPercents.map(p => Math.floor(prodAvailableWidth * p));
        // Fix rounding error by ensuring last column fills remainder
        const prodWidthsSum = productColWidths.reduce((s, v) => s + v, 0);
        if (prodWidthsSum < prodAvailableWidth) productColWidths[productColWidths.length - 1] += (prodAvailableWidth - prodWidthsSum);

        const prodTruncateText = (text, width) => {
          if (!text) return '-';
          const approxChars = Math.max(6, Math.floor(width / 6));
          if (String(text).length <= approxChars) return String(text);
          return String(text).substring(0, approxChars - 3) + '...';
        };

        const renderProductHeader = (y) => {
          doc.rect(prodLeftMargin - 5, y - 2, productColWidths.reduce((a, b) => a + b, 0) + 10, 28).fill('#1e40af');
          doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
          let x = prodLeftMargin;
          productHeaders.forEach((h, i) => {
            doc.text(h, x, y + 8, { width: productColWidths[i] });
            x += productColWidths[i];
          });
        };

        // Render header
        renderProductHeader(doc.y);
        let prodX = prodLeftMargin;
        doc.moveDown(0.5);
        doc.fillColor('#000000').font('Helvetica').fontSize(8);

        let totalProductValue = 0;
        productsPdf.forEach((product, idx) => {
          // Check for page overflow
          if (doc.y > doc.page.height - 80) {
            doc.addPage();
            // Reprint header
            renderProductHeader(doc.y);
            prodX = prodLeftMargin;
            doc.moveDown(0.5);
            doc.fillColor('#000000').font('Helvetica').fontSize(8);
          }
          
          const value = product.currentStock * product.averageCost;
          totalProductValue += value;
          
          // Zebra striping
          if (idx % 2 === 0) {
            doc.rect(prodLeftMargin - 5, doc.y - 2, productColWidths.reduce((a, b) => a + b, 0) + 10, 18).fill('#f3f4f6');
          }
          
          const rowData = [
            prodTruncateText(product.sku || '-', productColWidths[0]),
            prodTruncateText(product.name || '-', productColWidths[1]),
            prodTruncateText(product.category?.name || '-', productColWidths[2]),
            prodTruncateText(product.unit || '-', productColWidths[3]),
            product.currentStock.toString(),
            product.averageCost.toFixed(2),
            value.toFixed(2)
          ];
          
          prodX = prodLeftMargin;
          rowData.forEach((cell, i) => {
            // Right-align numeric columns
            const align = i >= 4 ? 'right' : 'left';
            doc.text(String(cell), prodX, doc.y, { width: productColWidths[i], align });
            prodX += productColWidths[i];
          });
          doc.moveDown(0.4);
        });

        doc.moveDown(1);
        // Draw border around totals
        doc.rect(25, doc.y - 2, doc.page.width - 50, 30).stroke('#e5e7eb');
        doc.fontSize(10).font('Helvetica-Bold');
        doc.fillColor('#111827');
        doc.text(`Total Products: ${productsPdf.length}`, 30, doc.y + 2);
        doc.text(`Total Inventory Value: ${totalProductValue.toFixed(2)}`, doc.page.width - 180, doc.y + 2, { width: 150, align: 'right' });
        break;

      case 'suppliers':
        // Fetch suppliers and company info
        const suppliersPdf = await Supplier.find({ company: companyId }).sort({ name: 1 });
        const companySupPdf = await Company.findById(companyId);

        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companySupPdf?.name || 'Company',
          companyTin: companySupPdf?.tin || 'N/A',
          reportTitle: 'SUPPLIERS LIST',
          reportDate: new Date().toLocaleDateString()
        });

        let totalSupplierPurchases = 0;
        let totalSupplierBalance = 0;

        if (suppliersPdf.length === 0) {
          doc.fontSize(10).text('No suppliers found.', { align: 'center' });
          break;
        }

        // Helpers for layout and pagination
        const currencyFmt = (v) => Number(v || 0).toFixed(2);
        let pageNum = 1;

        const drawFooter = (p) => {
          const bottom = doc.page.height - 40;
          doc.fontSize(8).fillColor('#9ca3af').font('Helvetica');
          doc.text(`Generated: ${new Date().toLocaleString()}`, 50, bottom, { align: 'left' });
          doc.text(`Page ${p}`, 0, bottom, { align: 'right' });
        };

        const supHeaders = ['Code', 'Supplier Name', 'Email', 'Phone', 'Address', 'Total Purchases', 'Balance'];

        // Compute responsive column widths so total equals available page space
        const leftMargin = 48;
        const rightMargin = 48;
        const availWidth = Math.round(doc.page.width - leftMargin - rightMargin);
        const supColPercents = [0.07, 0.20, 0.16, 0.10, 0.25, 0.11, 0.11];
        let supColWidths = supColPercents.map(p => Math.floor(availWidth * p));
        // Fix rounding error by ensuring last column fills remainder
        const widthsSum = supColWidths.reduce((s, v) => s + v, 0);
        if (widthsSum < availWidth) supColWidths[supColWidths.length - 1] += (availWidth - widthsSum);

        const supTruncateText = (text, width) => {
          if (!text) return '-';
          const approxChars = Math.max(6, Math.floor(width / 6));
          if (String(text).length <= approxChars) return String(text);
          return String(text).substring(0, approxChars - 3) + '...';
        };

        const renderTableHeader = (y) => {
          doc.rect(leftMargin - 8, y, availWidth + 16, 28).fill('#111827');
          doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
          let x = leftMargin;
          supHeaders.forEach((h, i) => {
            doc.text(h, x, y + 8, { width: supColWidths[i] });
            x += supColWidths[i];
          });
        };

        // Start table
        let y = doc.y;
        renderTableHeader(y);
        y += 36;
        doc.font('Helvetica').fontSize(9).fillColor('#111827');

        for (const [idx, supplier] of suppliersPdf.entries()) {
          // Pagination: start new page if low space
          if (y > doc.page.height - 150) {
            drawFooter(pageNum);
            doc.addPage();
            pageNum += 1;
            // reprint title header on new page
            doc.fontSize(14).text('SUPPLIERS LIST', { align: 'center', underline: true });
            doc.moveDown(0.5);
            renderTableHeader(120);
            y = 156;
            doc.font('Helvetica').fontSize(9).fillColor('#111827');
          }

          // compute totals
          const purchases = await Purchase.find({ supplier: supplier._id, status: { $in: ['received', 'paid', 'partial'] } });
          const totalPurchases = purchases.reduce((sum, p) => sum + (p.grandTotal || 0), 0);
          const balance = purchases.reduce((sum, p) => sum + (p.balance || 0), 0);
          totalSupplierPurchases += totalPurchases;
          totalSupplierBalance += balance;

          // Alternate row shading
          if (idx % 2 === 0) {
            doc.rect(40, y - 6, doc.page.width - 80, 18).fill('#f9fafb');
            doc.fillColor('#111827');
          }

          // Row values: show full text (no truncation). Calculate wrapping heights and render rows with dynamic height.
          const rowTexts = [
            supplier.code || '-',
            supplier.name || '-',
            supplier.contact?.email || '-',
            supplier.contact?.phone || '-',
            supplier.contact?.address || '-',
            currencyFmt(totalPurchases),
            currencyFmt(balance)
          ];

          doc.font('Helvetica').fontSize(9);
          // compute height for each cell (text may wrap)
          const cellHeights = rowTexts.map((t, i) => {
            // numeric columns shouldn't wrap much, but measure anyway
            try {
              return doc.heightOfString(String(t), { width: supColWidths[i] });
            } catch (e) {
              return 12;
            }
          });
          const maxHeight = Math.max(...cellHeights, 12);

          // If not enough space on page, add new page and re-render header
          if (y + maxHeight > doc.page.height - 150) {
            drawFooter(pageNum);
            doc.addPage();
            pageNum += 1;
            doc.fontSize(14).text('SUPPLIERS LIST', { align: 'center', underline: true });
            doc.moveDown(0.5);
            renderTableHeader(120);
            y = 156;
            doc.font('Helvetica').fontSize(9).fillColor('#111827');
          }

          // Alternate row shading with dynamic height
          if (idx % 2 === 0) {
            doc.rect(leftMargin - 8, y - 6, availWidth + 16, maxHeight + 8).fill('#f9fafb');
            doc.fillColor('#111827');
          }

          // Render each cell; numeric columns are right-aligned
          let x = leftMargin;
          rowTexts.forEach((cellText, i) => {
            if (i >= 5) {
              doc.text(String(cellText), x, y, { width: supColWidths[i], align: 'right' });
            } else {
              doc.text(String(cellText), x, y, { width: supColWidths[i] });
            }
            x += supColWidths[i];
          });

          // advance y by the row height plus small padding
          y += maxHeight + 8;
        }

        // Totals area
        if (y > doc.page.height - 180) {
          drawFooter(pageNum);
          doc.addPage();
          pageNum += 1;
          y = 120;
        }

        doc.moveTo(leftMargin - 8, y).lineTo(doc.page.width - rightMargin + 8, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
        y += 10;
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827');
        doc.text(`Total Suppliers: ${suppliersPdf.length}`, leftMargin, y);
        doc.text(`Total Purchases: ${totalSupplierPurchases.toFixed(2)}`, leftMargin, y + 16);
        doc.text(`Total Balance Due: ${totalSupplierBalance.toFixed(2)}`, leftMargin + Math.floor(availWidth * 0.5), y + 16);
        drawFooter(pageNum);
        break;

      case 'sales-summary':
        const invoicesPdf = await Invoice.find({ status: { $in: ['paid', 'partial', 'confirmed', 'draft'] }, company: companyId })
          .populate('client', 'name')
          .sort({ invoiceDate: -1 })
          .limit(100);

        const companyInvPdf = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyInvPdf?.name || 'Company',
          companyTin: companyInvPdf?.tin || 'N/A',
          reportTitle: 'SALES INVOICES REPORT',
          reportDate: new Date().toLocaleDateString()
        });

        // Summary
        const totalInvoices = invoicesPdf.length;
        const totalSales = invoicesPdf.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
        const totalPaid = invoicesPdf.reduce((sum, inv) => sum + (inv.amountPaid || 0), 0);
        const totalBalance = invoicesPdf.reduce((sum, inv) => sum + (inv.balance || 0), 0);

        // Draw summary box
        doc.rect(25, doc.y - 5, doc.page.width - 50, 60).fill('#f3f4f6');
        doc.fillColor('#111827').fontSize(10);
        doc.font('Helvetica-Bold');
        doc.text(`Total Invoices: ${totalInvoices}`, 35, doc.y + 5);
        doc.text(`Total Sales: ${totalSales.toFixed(2)}`, 180, doc.y + 5);
        doc.text(`Total Paid: ${totalPaid.toFixed(2)}`, 35, doc.y + 25);
        doc.text(`Total Balance: ${totalBalance.toFixed(2)}`, 180, doc.y + 25);
        doc.moveDown(3);

        // Table header
        const invHeaders = ['Invoice #', 'Date', 'Client', 'Total', 'Paid', 'Balance', 'Status'];
        
        // Calculate optimal column widths
        const invDataForWidth = invoicesPdf.slice(0, 10).map(inv => [
          inv.invoiceNumber || '-',
          inv.invoiceDate ? inv.invoiceDate.toLocaleDateString() : '-',
          inv.client?.name || '-',
          (inv.grandTotal || 0).toFixed(2),
          (inv.amountPaid || 0).toFixed(2),
          (inv.balance || 0).toFixed(2),
          inv.status || '-'
        ]);
        
        const invColWidths = calculateOptimalColumnWidths(doc, invHeaders, invDataForWidth, { leftMargin: 25, rightMargin: 25 });
        
        // Render header with styled background
        const invLeft = 25;
        doc.rect(invLeft - 5, doc.y - 2, invColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
        doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
        let invX = invLeft;
        invHeaders.forEach((header, i) => {
          doc.text(header, invX, doc.y + 3, { width: invColWidths[i], align: 'left' });
          invX += invColWidths[i];
        });
        doc.moveDown(1);
        doc.font('Helvetica').fontSize(8);
        doc.fillColor('#000000');

        invoicesPdf.forEach((invoice, idx) => {
          // Check for page overflow
          if (doc.y > doc.page.height - 80) {
            doc.addPage();
            // Reprint header
            doc.rect(invLeft - 5, doc.y - 2, invColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
            doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
            invX = invLeft;
            invHeaders.forEach((header, i) => {
              doc.text(header, invX, doc.y + 3, { width: invColWidths[i], align: 'left' });
              invX += invColWidths[i];
            });
            doc.moveDown(1);
            doc.font('Helvetica').fontSize(8);
            doc.fillColor('#000000');
          }
          
          // Zebra striping
          if (idx % 2 === 0) {
            doc.rect(invLeft - 5, doc.y - 2, invColWidths.reduce((a, b) => a + b, 0) + 10, 18).fill('#f3f4f6');
          }
          
          const rowData = [
            truncateText(invoice.invoiceNumber || '-', 12),
            invoice.invoiceDate ? invoice.invoiceDate.toLocaleDateString() : '-',
            truncateText(invoice.client?.name || '-', 20),
            (invoice.grandTotal || 0).toFixed(2),
            (invoice.amountPaid || 0).toFixed(2),
            (invoice.balance || 0).toFixed(2),
            invoice.status || '-'
          ];
          
          invX = invLeft;
          rowData.forEach((cell, i) => {
            // Right-align numeric columns
            const align = (i >= 3 && i <= 5) ? 'right' : 'left';
            doc.text(cell, invX, doc.y, { width: invColWidths[i], align });
            invX += invColWidths[i];
          });
          doc.moveDown(0.4);
        });
        break;

      case 'profit-loss':
        // Get P&L detailed data for PDF export - use the determined period dates
        const pdfPeriodStart = reportPeriodStart;
        const pdfPeriodEnd = reportPeriodEnd;
        
        const pdfPlCompany = await Company.findById(companyId);
        const pdfPlInvoices = await Invoice.find({ 
          status: 'paid', 
          company: companyId,
          paidDate: { $gte: pdfPeriodStart, $lte: pdfPeriodEnd }
        }).populate('items.product', 'averageCost');

        const pdfPlCreditNotes = await CreditNote.find({
          company: companyId,
          status: { $in: ['issued', 'applied', 'refunded', 'partially_refunded'] },
          issueDate: { $gte: pdfPeriodStart, $lte: pdfPeriodEnd }
        });

        const pdfPlPurchases = await Purchase.find({
          company: companyId,
          status: { $in: ['received', 'paid'] },
          purchaseDate: { $gte: pdfPeriodStart, $lte: pdfPeriodEnd }
        });

        const pdfPlProducts = await Product.find({ company: companyId, isArchived: false });
        const pdfPlFixedAssets = await FixedAsset.find({ company: companyId, status: 'active' });
        const pdfPlLoans = await Loan.find({ company: companyId, status: 'active', startDate: { $lte: pdfPeriodEnd } });

        // Calculate P&L values
        const pdfPlSalesRevenueExVAT = pdfPlInvoices.reduce((sum, inv) => sum + (inv.subtotal || 0), 0);
        const pdfPlSalesReturns = pdfPlCreditNotes.reduce((sum, cn) => sum + (cn.subtotal || 0), 0);
        const pdfPlDiscountsGiven = pdfPlInvoices.reduce((sum, inv) => sum + (inv.totalDiscount || 0), 0);
        const pdfPlNetRevenue = pdfPlSalesRevenueExVAT - pdfPlSalesReturns - pdfPlDiscountsGiven;

        const pdfPlClosingStockValue = pdfPlProducts.reduce((sum, product) => sum + (product.currentStock * product.averageCost), 0);
        const pdfPlPurchasesExVAT = pdfPlPurchases.reduce((sum, p) => sum + ((p.subtotal || 0) - (p.totalDiscount || 0)), 0);

        // Opening Stock: simply use 0
        const pdfPlOpeningStockValue = 0;

        // COGS: Formula-based approach - Opening Stock + Purchases - Closing Stock
        const pdfPlTotalCOGS = pdfPlOpeningStockValue + pdfPlPurchasesExVAT - pdfPlClosingStockValue;

        const pdfPlGrossProfit = pdfPlNetRevenue - pdfPlTotalCOGS;
        const pdfPlGrossMarginPercent = pdfPlNetRevenue > 0 ? (pdfPlGrossProfit / pdfPlNetRevenue) * 100 : 0;

        // Depreciation — period-aware, starts from 1st of purchase month
        const pdfPlDepreciationExpense = calculateDepreciationForPeriod(pdfPlFixedAssets, pdfPeriodStart, pdfPeriodEnd);

        // Interest expense
        let pdfPlInterestExpense = 0;
        // Calculate number of months in the period
        const pdfPlPeriodMonths = Math.ceil((pdfPeriodEnd - pdfPeriodStart) / (1000 * 60 * 60 * 24 * 30)) || 1;
        
        pdfPlLoans.forEach(loan => {
          const monthlyInterest = (loan.originalAmount * (loan.interestRate || 0) / 100) / 12;
          pdfPlInterestExpense += monthlyInterest * pdfPlPeriodMonths;
        });

        // VAT
        const pdfPlOutputVAT = pdfPlInvoices.reduce((sum, inv) => sum + (inv.totalTax || 0), 0);
        const pdfPlInputVAT = pdfPlPurchases.reduce((sum, p) => sum + (p.totalTax || 0), 0);

        const pdfPlOperatingExpenses = pdfPlDepreciationExpense;
        const pdfPlOperatingProfit = pdfPlGrossProfit - pdfPlOperatingExpenses;
        const pdfPlNetOtherIncome = -pdfPlInterestExpense;
        const pdfPlProfitBeforeTax = pdfPlOperatingProfit + pdfPlNetOtherIncome;
        const pdfPlCorporateIncomeTax = Math.max(0, pdfPlProfitBeforeTax * 0.30);
        const pdfPlTotalTax = pdfPlCorporateIncomeTax;
        const pdfPlNetProfit = pdfPlProfitBeforeTax - pdfPlTotalTax;
        const pdfPlNetMarginPercent = pdfPlNetRevenue > 0 ? (pdfPlNetProfit / pdfPlNetRevenue) * 100 : 0;

        // PDF Header - Use pdfRenderer for consistent formatting
        const plLeft = 40;
        const plRight = 48;
        const plAmountX = doc.page.width - plRight - 110; // position for amounts
        const plItemWidth = plAmountX - plLeft - 10;

        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: pdfPlCompany?.name || 'Company',
          companyTin: pdfPlCompany?.tin || 'N/A',
          reportTitle: 'PROFIT & LOSS STATEMENT',
          reportDate: new Date().toLocaleDateString(),
          period: `${pdfPeriodStart.toLocaleDateString()} - ${pdfPeriodEnd.toLocaleDateString()}`
        });
        doc.moveDown(1.2);

        // Compact summary block
        let ypl = doc.y;
        printLine('Net Revenue', pdfPlNetRevenue, ypl);
        ypl += 16;
        printLine('Total COGS', pdfPlTotalCOGS, ypl);
        ypl += 16;
        printLine('Gross Profit', pdfPlGrossProfit, ypl);
        ypl += 16;
        printLine('Operating Profit', pdfPlOperatingProfit, ypl);
        ypl += 20;
        doc.font('Helvetica-Bold').fontSize(11);
        printLine('NET PROFIT', pdfPlNetProfit, ypl);
        doc.font('Helvetica').fontSize(10);
        doc.moveDown(1.5);

        // Sections
        const section = (title, rows) => {
          doc.font('Helvetica-Bold').fontSize(11).text(title, plLeft);
          let yy = doc.y + 6;
          doc.font('Helvetica').fontSize(10);
          rows.forEach(r => {
            printLine(r.label, r.amount, yy, r.indent || 0);
            yy += 14;
          });
          doc.moveDown(0.5);
        };

        section('REVENUE', [
          { label: 'Sales Revenue (ex. VAT)', amount: pdfPlSalesRevenueExVAT },
          { label: 'Less: Sales Returns', amount: -pdfPlSalesReturns, indent: 1 },
          { label: 'Less: Discounts Given', amount: -pdfPlDiscountsGiven, indent: 1 },
          { label: 'NET REVENUE', amount: pdfPlNetRevenue }
        ]);

        section('COST OF GOODS SOLD', [
          { label: 'Opening Stock', amount: pdfPlOpeningStockValue },
          { label: 'Add: Purchases (ex. VAT)', amount: pdfPlPurchasesExVAT },
          { label: 'Less: Closing Stock', amount: -pdfPlClosingStockValue },
          { label: 'TOTAL COGS', amount: pdfPlTotalCOGS }
        ]);

        section('OPERATING EXPENSES', [
          { label: 'Depreciation', amount: -pdfPlDepreciationExpense },
          { label: 'TOTAL OPERATING EXPENSES', amount: -pdfPlOperatingExpenses }
        ]);

        section('OTHER INCOME / EXPENSES', [
          { label: 'Interest Expense', amount: -pdfPlInterestExpense, indent: 1 },
          { label: 'NET OTHER INCOME', amount: pdfPlNetOtherIncome }
        ]);

        const yfinal = doc.y + 8;
        doc.font('Helvetica-Bold').fontSize(12);
        printLine('PROFIT BEFORE TAX', pdfPlProfitBeforeTax, yfinal);
        doc.moveDown(0.6);
        doc.font('Helvetica-Bold').fontSize(11);
        printLine('Less: Corporate Tax (30%)', -pdfPlCorporateIncomeTax, doc.y);
        doc.moveDown(0.8);
        doc.fontSize(12).font('Helvetica-Bold');
        printLine('NET PROFIT', pdfPlNetProfit, doc.y);
        break;

      case 'top-clients':
      case 'client-sales':
        const topClientsPdfData = await Invoice.aggregate([
          { $match: { company: companyId, status: { $in: ['paid', 'partial'] }, invoiceDate: { $gte: reportPeriodStart, $lte: reportPeriodEnd } } },
          { $group: { _id: '$client', revenue: { $sum: '$grandTotal' }, invoiceCount: { $sum: 1 } } },
          { $sort: { revenue: -1 } },
          { $limit: 50 }
        ]);
        await Client.populate(topClientsPdfData, { path: '_id', select: 'name code' });

        const companyTopClients = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyTopClients?.name || 'Company',
          companyTin: companyTopClients?.tin || 'N/A',
          reportTitle: 'TOP CLIENTS BY REVENUE',
          reportDate: new Date().toLocaleDateString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });

        const tcHeaders = ['Code', 'Client Name', 'Invoices', 'Total Revenue'];
        
        // Calculate optimal column widths
        const tcDataForWidth = topClientsPdfData.slice(0, 10).map(c => [
          c._id?.code || 'N/A',
          c._id?.name || 'Unknown',
          c.invoiceCount?.toString() || '0',
          (c.revenue || 0).toFixed(2)
        ]);
        
        const tcColWidths = calculateOptimalColumnWidths(doc, tcHeaders, tcDataForWidth, { leftMargin: 25, rightMargin: 25 });
        
        // Render header
        const tcLeft = 25;
        doc.rect(tcLeft - 5, doc.y - 2, tcColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
        doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
        let tcX = tcLeft;
        tcHeaders.forEach((header, i) => {
          doc.text(header, tcX, doc.y + 3, { width: tcColWidths[i], align: 'left' });
          tcX += tcColWidths[i];
        });
        doc.moveDown(1);
        doc.font('Helvetica').fontSize(8);
        doc.fillColor('#000000');

        let totalClientRevenue = 0;
        topClientsPdfData.forEach((c, idx) => {
          // Check for page overflow
          if (doc.y > doc.page.height - 80) {
            doc.addPage();
            // Reprint header
            doc.rect(tcLeft - 5, doc.y - 2, tcColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
            doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
            tcX = tcLeft;
            tcHeaders.forEach((header, i) => {
              doc.text(header, tcX, doc.y + 3, { width: tcColWidths[i], align: 'left' });
              tcX += tcColWidths[i];
            });
            doc.moveDown(1);
            doc.font('Helvetica').fontSize(8);
            doc.fillColor('#000000');
          }
          
          totalClientRevenue += c.revenue || 0;
          
          // Zebra striping
          if (idx % 2 === 0) {
            doc.rect(tcLeft - 5, doc.y - 2, tcColWidths.reduce((a, b) => a + b, 0) + 10, 18).fill('#f3f4f6');
          }
          
          const rowData = [
            truncateText(c._id?.code || 'N/A', 10),
            truncateText(c._id?.name || 'Unknown', 35),
            c.invoiceCount?.toString() || '0',
            (c.revenue || 0).toFixed(2)
          ];
          tcX = tcLeft;
          rowData.forEach((cell, i) => {
            const align = i === 3 ? 'right' : 'left';
            doc.text(cell, tcX, doc.y, { width: tcColWidths[i], align });
            tcX += tcColWidths[i];
          });
          doc.moveDown(0.4);
        });
        
        doc.moveDown(1);
        // Draw totals box
        doc.rect(25, doc.y - 2, doc.page.width - 50, 25).fill('#e5e7eb');
        doc.fontSize(10).font('Helvetica-Bold');
        doc.fillColor('#111827');
        doc.text(`Total Clients: ${topClientsPdfData.length}`, 30, doc.y + 2);
        doc.text(`Total Revenue: ${totalClientRevenue.toFixed(2)}`, doc.page.width - 180, doc.y + 2, { width: 150, align: 'right' });
        break;

      case 'top-suppliers':
      case 'supplier-purchase':
        const topSuppliersPdfData = await Purchase.aggregate([
          { $match: { company: companyId, status: { $in: ['received', 'paid', 'partial'] }, purchaseDate: { $gte: reportPeriodStart, $lte: reportPeriodEnd } } },
          { $group: { _id: '$supplier', total: { $sum: '$grandTotal' }, purchaseCount: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 50 }
        ]);
        await Supplier.populate(topSuppliersPdfData, { path: '_id', select: 'name code' });

        const companyTopSup = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyTopSup?.name || 'Company',
          companyTin: companyTopSup?.tin || 'N/A',
          reportTitle: 'TOP SUPPLIERS BY PURCHASE',
          reportDate: new Date().toLocaleDateString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });

        const tsHeaders = ['Code', 'Supplier Name', 'Purchases', 'Total Purchases'];
        
        // Calculate optimal column widths
        const tsDataForWidth = topSuppliersPdfData.slice(0, 10).map(s => [
          s._id?.code || 'N/A',
          s._id?.name || 'Unknown',
          s.purchaseCount?.toString() || '0',
          (s.total || 0).toFixed(2)
        ]);
        
        const tsColWidths = calculateOptimalColumnWidths(doc, tsHeaders, tsDataForWidth, { leftMargin: 25, rightMargin: 25 });
        
        // Render header
        const tsLeft = 25;
        doc.rect(tsLeft - 5, doc.y - 2, tsColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
        doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
        tsX = tsLeft;
        tsHeaders.forEach((header, i) => {
          doc.text(header, tsX, doc.y + 3, { width: tsColWidths[i], align: 'left' });
          tsX += tsColWidths[i];
        });
        doc.moveDown(1);
        doc.font('Helvetica').fontSize(8);
        doc.fillColor('#000000');

        let totalSupplierPurchase = 0;
        topSuppliersPdfData.forEach((s, idx) => {
          // Check for page overflow
          if (doc.y > doc.page.height - 80) {
            doc.addPage();
            // Reprint header
            doc.rect(tsLeft - 5, doc.y - 2, tsColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
            doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
            tsX = tsLeft;
            tsHeaders.forEach((header, i) => {
              doc.text(header, tsX, doc.y + 3, { width: tsColWidths[i], align: 'left' });
              tsX += tsColWidths[i];
            });
            doc.moveDown(1);
            doc.font('Helvetica').fontSize(8);
            doc.fillColor('#000000');
          }
          
          totalSupplierPurchase += s.total || 0;
          
          // Zebra striping
          if (idx % 2 === 0) {
            doc.rect(tsLeft - 5, doc.y - 2, tsColWidths.reduce((a, b) => a + b, 0) + 10, 18).fill('#f3f4f6');
          }
          
          const rowData = [
            truncateText(s._id?.code || 'N/A', 10),
            truncateText(s._id?.name || 'Unknown', 35),
            s.purchaseCount?.toString() || '0',
            (s.total || 0).toFixed(2)
          ];
          tsX = tsLeft;
          rowData.forEach((cell, i) => {
            const align = i === 3 ? 'right' : 'left';
            doc.text(cell, tsX, doc.y, { width: tsColWidths[i], align });
            tsX += tsColWidths[i];
          });
          doc.moveDown(0.4);
        });
        
        doc.moveDown(1);
        // Draw totals box
        doc.rect(25, doc.y - 2, doc.page.width - 50, 25).fill('#e5e7eb');
        doc.fontSize(10).font('Helvetica-Bold');
        doc.fillColor('#111827');
        doc.text(`Total Suppliers: ${topSuppliersPdfData.length}`, 30, doc.y + 2);
        doc.text(`Total Purchases: ${totalSupplierPurchase.toFixed(2)}`, doc.page.width - 180, doc.y + 2, { width: 150, align: 'right' });
        break;

      case 'credit-limit':
        const creditLimitPdfClients = await Client.find({ company: companyId, isActive: true })
          .select('name code creditLimit outstandingBalance')
          .lean();

        const companyCreditLimit = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyCreditLimit?.name || 'Company',
          companyTin: companyCreditLimit?.tin || 'N/A',
          reportTitle: 'CLIENT CREDIT LIMIT REPORT',
          reportDate: new Date().toLocaleDateString()
        });

        const clHeaders = ['Code', 'Client Name', 'Credit Limit', 'Outstanding', 'Utilization %'];
        
        // Calculate optimal column widths
        const clDataForWidth = creditLimitPdfClients.slice(0, 10).map(c => {
          const limit = c.creditLimit || 0;
          const outstanding = c.outstandingBalance || 0;
          const utilization = limit > 0 ? (outstanding / limit) * 100 : 0;
          return [
            c.code || 'N/A',
            c.name || '-',
            limit.toFixed(2),
            outstanding.toFixed(2),
            utilization.toFixed(1) + '%'
          ];
        });
        
        const clColWidths = calculateOptimalColumnWidths(doc, clHeaders, clDataForWidth, { leftMargin: 25, rightMargin: 25 });
        
        // Render header
        const clLeft = 25;
        doc.rect(clLeft - 5, doc.y - 2, clColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
        doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
        let clX = clLeft;
        clHeaders.forEach((header, i) => {
          doc.text(header, clX, doc.y + 3, { width: clColWidths[i], align: 'left' });
          clX += clColWidths[i];
        });
        doc.moveDown(1);
        doc.font('Helvetica').fontSize(8);
        doc.fillColor('#000000');

        let totalCreditLimit = 0;
        let totalOutstanding = 0;
        creditLimitPdfClients.forEach((c, idx) => {
          // Check for page overflow
          if (doc.y > doc.page.height - 80) {
            doc.addPage();
            // Reprint header
            doc.rect(clLeft - 5, doc.y - 2, clColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
            doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
            clX = clLeft;
            clHeaders.forEach((header, i) => {
              doc.text(header, clX, doc.y + 3, { width: clColWidths[i], align: 'left' });
              clX += clColWidths[i];
            });
            doc.moveDown(1);
            doc.font('Helvetica').fontSize(8);
            doc.fillColor('#000000');
          }
          
          const limit = c.creditLimit || 0;
          const outstanding = c.outstandingBalance || 0;
          const utilization = limit > 0 ? (outstanding / limit) * 100 : 0;
          totalCreditLimit += limit;
          totalOutstanding += outstanding;
          
          // Zebra striping
          if (idx % 2 === 0) {
            doc.rect(clLeft - 5, doc.y - 2, clColWidths.reduce((a, b) => a + b, 0) + 10, 18).fill('#f3f4f6');
          }
          
          const rowData = [
            truncateText(c.code || 'N/A', 10),
            truncateText(c.name || '-', 25),
            limit.toFixed(2),
            outstanding.toFixed(2),
            utilization.toFixed(1) + '%'
          ];
          clX = clLeft;
          rowData.forEach((cell, i) => {
            const align = i >= 2 ? 'right' : 'left';
            doc.text(cell, clX, doc.y, { width: clColWidths[i], align });
            clX += clColWidths[i];
          });
          doc.moveDown(0.4);
        });
        
        doc.moveDown(1);
        // Draw totals box
        doc.rect(25, doc.y - 2, doc.page.width - 50, 25).fill('#e5e7eb');
        doc.fontSize(10).font('Helvetica-Bold');
        doc.fillColor('#111827');
        doc.text(`Total Clients: ${creditLimitPdfClients.length}`, 30, doc.y + 2);
        doc.text(`Total Credit Limit: ${totalCreditLimit.toFixed(2)}`, 180, doc.y + 2);
        doc.text(`Total Outstanding: ${totalOutstanding.toFixed(2)}`, doc.page.width - 100, doc.y + 2, { width: 90, align: 'right' });
        break;

      case 'new-clients':
        const newClientsPdf = await Client.find({
          company: companyId,
          createdAt: { $gte: reportPeriodStart, $lte: reportPeriodEnd }
        })
        .select('name code createdAt')
        .sort({ createdAt: -1 });

        const companyNewClients = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyNewClients?.name || 'Company',
          companyTin: companyNewClients?.tin || 'N/A',
          reportTitle: 'NEW CLIENTS REPORT',
          reportDate: new Date().toLocaleDateString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });

        const ncHeaders = ['Code', 'Client Name', 'Registration Date'];
        
        // Calculate optimal column widths
        const ncDataForWidth = newClientsPdf.slice(0, 10).map(c => [
          c.code || 'N/A',
          c.name || '-',
          c.createdAt ? new Date(c.createdAt).toLocaleDateString() : 'N/A'
        ]);
        
        const ncColWidths = calculateOptimalColumnWidths(doc, ncHeaders, ncDataForWidth, { leftMargin: 25, rightMargin: 25 });
        
        // Render header
        const ncLeft = 25;
        doc.rect(ncLeft - 5, doc.y - 2, ncColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
        doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
        let ncX = ncLeft;
        ncHeaders.forEach((header, i) => {
          doc.text(header, ncX, doc.y + 3, { width: ncColWidths[i], align: 'left' });
          ncX += ncColWidths[i];
        });
        doc.moveDown(1);
        doc.font('Helvetica').fontSize(8);
        doc.fillColor('#000000');

        newClientsPdf.forEach((c, idx) => {
          // Check for page overflow
          if (doc.y > doc.page.height - 80) {
            doc.addPage();
            // Reprint header
            doc.rect(ncLeft - 5, doc.y - 2, ncColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
            doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
            ncX = ncLeft;
            ncHeaders.forEach((header, i) => {
              doc.text(header, ncX, doc.y + 3, { width: ncColWidths[i], align: 'left' });
              ncX += ncColWidths[i];
            });
            doc.moveDown(1);
            doc.font('Helvetica').fontSize(8);
            doc.fillColor('#000000');
          }
          
          // Zebra striping
          if (idx % 2 === 0) {
            doc.rect(ncLeft - 5, doc.y - 2, ncColWidths.reduce((a, b) => a + b, 0) + 10, 18).fill('#f3f4f6');
          }
          
          const rowData = [
            truncateText(c.code || 'N/A', 12),
            truncateText(c.name || '-', 40),
            c.createdAt ? new Date(c.createdAt).toLocaleDateString() : 'N/A'
          ];
          ncX = ncLeft;
          rowData.forEach((cell, i) => {
            doc.text(cell, ncX, doc.y, { width: ncColWidths[i], align: 'left' });
            ncX += ncColWidths[i];
          });
          doc.moveDown(0.4);
        });
        
        doc.moveDown(1);
        // Draw totals box
        doc.rect(25, doc.y - 2, doc.page.width - 50, 25).fill('#e5e7eb');
        doc.fontSize(10).font('Helvetica-Bold');
        doc.fillColor('#111827');
        doc.text(`Total New Clients: ${newClientsPdf.length}`, 30, doc.y + 2);
        break;

      case 'inactive-clients':
        const cutoffDatePdf = new Date();
        cutoffDatePdf.setDate(cutoffDatePdf.getDate() - 90);
        
        const allClientsPdf = await Client.find({ company: companyId, isActive: true })
          .select('name code lastPurchaseDate outstandingBalance')
          .lean();

        const inactiveClientsPdf = allClientsPdf.filter(c => {
          if (!c.lastPurchaseDate) return true;
          return new Date(c.lastPurchaseDate) < cutoffDatePdf;
        });

        const companyInactive = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyInactive?.name || 'Company',
          companyTin: companyInactive?.tin || 'N/A',
          reportTitle: 'INACTIVE CLIENTS REPORT',
          reportDate: new Date().toLocaleDateString(),
          period: 'Clients with no purchase in 90+ days'
        });

        const icHeaders = ['Code', 'Client Name', 'Last Purchase', 'Days Inactive', 'Outstanding'];
        
        // Calculate optimal column widths
        const icDataForWidth = inactiveClientsPdf.slice(0, 10).map(c => {
          const lastDate = c.lastPurchaseDate ? new Date(c.lastPurchaseDate) : null;
          const days = lastDate ? Math.floor((new Date() - lastDate) / (1000 * 60 * 60 * 24)) : 'N/A';
          return [
            c.code || 'N/A',
            c.name || '-',
            lastDate ? lastDate.toLocaleDateString() : 'No purchases',
            typeof days === 'number' ? days + ' days' : 'N/A',
            (c.outstandingBalance || 0).toFixed(2)
          ];
        });
        
        const icColWidths = calculateOptimalColumnWidths(doc, icHeaders, icDataForWidth, { leftMargin: 25, rightMargin: 25 });
        
        // Render header
        const icLeft = 25;
        doc.rect(icLeft - 5, doc.y - 2, icColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
        doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
        let icX = icLeft;
        icHeaders.forEach((header, i) => {
          doc.text(header, icX, doc.y + 3, { width: icColWidths[i], align: 'left' });
          icX += icColWidths[i];
        });
        doc.moveDown(1);
        doc.font('Helvetica').fontSize(8);
        doc.fillColor('#000000');

        inactiveClientsPdf.forEach((c, idx) => {
          // Check for page overflow
          if (doc.y > doc.page.height - 80) {
            doc.addPage();
            // Reprint header
            doc.rect(icLeft - 5, doc.y - 2, icColWidths.reduce((a, b) => a + b, 0) + 10, 25).fill('#1e40af');
            doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
            icX = icLeft;
            icHeaders.forEach((header, i) => {
              doc.text(header, icX, doc.y + 3, { width: icColWidths[i], align: 'left' });
              icX += icColWidths[i];
            });
            doc.moveDown(1);
            doc.font('Helvetica').fontSize(8);
            doc.fillColor('#000000');
          }
          
          const lastDate = c.lastPurchaseDate ? new Date(c.lastPurchaseDate) : null;
          const days = lastDate ? Math.floor((new Date() - lastDate) / (1000 * 60 * 60 * 24)) : 'N/A';
          
          // Zebra striping
          if (idx % 2 === 0) {
            doc.rect(icLeft - 5, doc.y - 2, icColWidths.reduce((a, b) => a + b, 0) + 10, 18).fill('#f3f4f6');
          }
          
          const rowData = [
            truncateText(c.code || 'N/A', 10),
            truncateText(c.name || '-', 25),
            lastDate ? lastDate.toLocaleDateString() : 'No purchases',
            typeof days === 'number' ? days + ' days' : 'N/A',
            (c.outstandingBalance || 0).toFixed(2)
          ];
          icX = icLeft;
          rowData.forEach((cell, i) => {
            const align = i === 4 ? 'right' : 'left';
            doc.text(cell, icX, doc.y, { width: icColWidths[i], align });
            icX += icColWidths[i];
          });
          doc.moveDown(0.4);
        });
        
        doc.moveDown(1);
        // Draw totals box
        doc.rect(25, doc.y - 2, doc.page.width - 50, 25).fill('#e5e7eb');
        doc.fontSize(10).font('Helvetica-Bold');
        doc.fillColor('#111827');
        doc.text(`Total Inactive Clients: ${inactiveClientsPdf.length}`, 30, doc.y + 2);
        break;

      case 'client-statement':
        const companyClientStmt = await Company.findById(companyId);
        doc.fontSize(16).text(companyClientStmt?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyClientStmt?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('CLIENT STATEMENT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        // Generate client statement data - either for all clients or specific client
        const clientStmtReport = await reportGeneratorService.generateClientStatementReport(
          companyId,
          reportPeriodStart,
          reportPeriodEnd,
          clientId
        );
        
        if (clientStmtReport && clientStmtReport.length > 0 && clientStmtReport[0].transactions) {
          const clientData = clientStmtReport[0];
          
          // Summary
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text('Summary:', 30);
          doc.font('Helvetica').fontSize(9);
          doc.text(`Total Invoiced: ${(clientData.totalInvoiced || 0).toFixed(2)}`, 50);
          doc.text(`Total Paid: ${(clientData.totalPaid || 0).toFixed(2)}`, 50);
          doc.text(`Balance Due: ${(clientData.balance || 0).toFixed(2)}`, 50);
          doc.moveDown(1);
          
          // Transactions table
          const stmtHeaders = ['Date', 'Type', 'Reference', 'Amount', 'Paid', 'Balance'];
          const stmtColPercents = [0.12, 0.14, 0.18, 0.14, 0.14, 0.14];
          const stmtColWidths = getResponsiveColWidths(stmtColPercents, 30, 30);
          doc.fontSize(9).font('Helvetica-Bold');
          let stmtX = 30;
          stmtHeaders.forEach((header, i) => {
            doc.text(header, stmtX, doc.y, { width: stmtColWidths[i] });
            stmtX += stmtColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          clientData.transactions.forEach(tx => {
            stmtX = 30;
            const rowData = [
              tx.date ? new Date(tx.date).toLocaleDateString() : '-',
              tx.type || '-',
              tx.reference || '-',
              (tx.amount || 0).toFixed(2),
              (tx.paid || 0).toFixed(2),
              (tx.balance || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), stmtX, doc.y, { width: stmtColWidths[i] });
              stmtX += stmtColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else if (clientId) {
          doc.fontSize(10).text('No transactions found for the selected client in this period.', { align: 'center' });
        } else {
          doc.fontSize(10).text('Note: Please use the client filter to generate a statement for a specific client.', { align: 'center' });
        }
        break;

      case 'supplier-statement':
        const companySupplierStmt = await Company.findById(companyId);
        doc.fontSize(16).text(companySupplierStmt?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companySupplierStmt?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('SUPPLIER STATEMENT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        // Generate supplier statement data - either for all suppliers or specific supplier
        const supplierStmtReport = await reportGeneratorService.generateSupplierStatementReport(
          companyId,
          reportPeriodStart,
          reportPeriodEnd,
          supplierId
        );
        
        if (supplierStmtReport && supplierStmtReport.length > 0 && supplierStmtReport[0].transactions) {
          const supplierData = supplierStmtReport[0];
          
          // Summary
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text('Summary:', 30);
          doc.font('Helvetica').fontSize(9);
          doc.text(`Total Purchases: ${(supplierData.totalInvoiced || 0).toFixed(2)}`, 50);
          doc.text(`Total Paid: ${(supplierData.totalPaid || 0).toFixed(2)}`, 50);
          doc.text(`Balance Due: ${(supplierData.balance || 0).toFixed(2)}`, 50);
          doc.moveDown(1);
          
          // Transactions table
          const suppStmtHeaders = ['Date', 'Type', 'Reference', 'Amount', 'Paid', 'Balance'];
          const suppStmtColPercents = [0.12, 0.14, 0.18, 0.14, 0.14, 0.14];
          const suppStmtColWidths = getResponsiveColWidths(suppStmtColPercents, 30, 30);
          doc.fontSize(9).font('Helvetica-Bold');
          let suppStmtX = 30;
          suppStmtHeaders.forEach((header, i) => {
            doc.text(header, suppStmtX, doc.y, { width: suppStmtColWidths[i] });
            suppStmtX += suppStmtColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          supplierData.transactions.forEach(tx => {
            suppStmtX = 30;
            const rowData = [
              tx.date ? new Date(tx.date).toLocaleDateString() : '-',
              tx.type || '-',
              tx.reference || '-',
              (tx.amount || 0).toFixed(2),
              (tx.paid || 0).toFixed(2),
              (tx.balance || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), suppStmtX, doc.y, { width: suppStmtColWidths[i] });
              suppStmtX += suppStmtColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else if (supplierId) {
          doc.fontSize(10).text('No transactions found for the selected supplier in this period.', { align: 'center' });
        } else {
          doc.fontSize(10).text('Note: Please use the supplier filter to generate a statement for a specific supplier.', { align: 'center' });
        }
        break;

      case 'purchase-by-product':
        const companyPurchaseProduct = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyPurchaseProduct?.name || 'Company',
          companyTin: companyPurchaseProduct?.tin || 'N/A',
          reportTitle: 'PURCHASE BY PRODUCT REPORT',
          reportDate: new Date().toLocaleDateString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });
        
        const purchaseByProductData = await reportGeneratorService.generatePurchaseByProductReport(companyId, reportPeriodStart, reportPeriodEnd);
        
        if (purchaseByProductData && purchaseByProductData.data && purchaseByProductData.data.length > 0) {
          const ppHeaders = ['Product', 'SKU', 'Quantity', 'Total Amount'];
          const ppColPercents = [0.35, 0.18, 0.18, 0.24];
          const ppColWidths = getResponsiveColWidths(ppColPercents);
          doc.fontSize(9).font('Helvetica-Bold');
          let ppX = 30;
          ppHeaders.forEach((header, i) => {
            doc.text(header, ppX, doc.y, { width: ppColWidths[i] });
            ppX += ppColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalAmount = 0;
          purchaseByProductData.data.forEach(item => {
            ppX = 30;
            totalAmount += item.totalAmount || 0;
            const rowData = [
              (item.product?.name || '-').substring(0, 25),
              item.product?.sku || '-',
              (item.totalQuantity || 0).toString(),
              (item.totalAmount || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), ppX, doc.y, { width: ppColWidths[i] });
              ppX += ppColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Products: ${purchaseByProductData.data.length}`, 30);
          doc.text(`Total Amount: ${totalAmount.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No purchase data found for this period.', { align: 'center' });
        }
        break;

      case 'purchase-by-category':
        const companyPurchaseCategory = await Company.findById(companyId);
        doc.fontSize(16).text(companyPurchaseCategory?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyPurchaseCategory?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('PURCHASE BY CATEGORY REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const purchaseByCategoryData = await reportGeneratorService.generatePurchaseByCategoryReport(companyId, reportPeriodStart, reportPeriodEnd);
        
        if (purchaseByCategoryData && purchaseByCategoryData.data && purchaseByCategoryData.data.length > 0) {
          const pcHeaders = ['Category', 'Products', 'Quantity', 'Total Amount'];
          const pcColPercents = [0.35, 0.18, 0.18, 0.24];
          const pcColWidths = getResponsiveColWidths(pcColPercents);
          doc.fontSize(9).font('Helvetica-Bold');
          let pcX = 30;
          pcHeaders.forEach((header, i) => {
            doc.text(header, pcX, doc.y, { width: pcColWidths[i] });
            pcX += pcColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalAmount = 0;
          purchaseByCategoryData.data.forEach(item => {
            pcX = 30;
            totalAmount += item.totalAmount || 0;
            const rowData = [
              (item.category || '-').substring(0, 25),
              (item.productCount || 0).toString(),
              (item.totalQuantity || 0).toString(),
              (item.totalAmount || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), pcX, doc.y, { width: pcColWidths[i] });
              pcX += pcColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Categories: ${purchaseByCategoryData.data.length}`, 30);
          doc.text(`Total Amount: ${totalAmount.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No purchase data found for this period.', { align: 'center' });
        }
        break;

      case 'accounts-payable':
        const companyAP = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyAP?.name || 'Company',
          companyTin: companyAP?.tin || 'N/A',
          reportTitle: 'ACCOUNTS PAYABLE REPORT',
          reportDate: new Date().toLocaleDateString()
        });
        
        const accountsPayableData = await reportGeneratorService.generateAccountsPayableReport(companyId);
        
        if (accountsPayableData && accountsPayableData.data && accountsPayableData.data.length > 0) {
          const apHeaders = ['Invoice #', 'Supplier', 'Date', 'Total', 'Paid', 'Balance'];
          const apColPercents = [0.10, 0.22, 0.14, 0.14, 0.14, 0.14];
          const apColWidths = getResponsiveColWidths(apColPercents);
          doc.fontSize(9).font('Helvetica-Bold');
          let apX = 30;
          apHeaders.forEach((header, i) => {
            doc.text(header, apX, doc.y, { width: apColWidths[i] });
            apX += apColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalBalance = 0;
          accountsPayableData.data.forEach(item => {
            apX = 30;
            totalBalance += item.balance || 0;
            const rowData = [
              item.purchaseNumber || '-',
              (item.supplier?.name || '-').substring(0, 20),
              item.purchaseDate ? new Date(item.purchaseDate).toLocaleDateString() : '-',
              (item.total || 0).toFixed(2),
              (item.paid || 0).toFixed(2),
              (item.balance || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), apX, doc.y, { width: apColWidths[i] });
              apX += apColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Invoices: ${accountsPayableData.data.length}`, 30);
          doc.text(`Total Payable: ${totalBalance.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No accounts payable found.', { align: 'center' });
        }
        break;

      case 'supplier-aging':
        const companySA = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companySA?.name || 'Company',
          companyTin: companySA?.tin || 'N/A',
          reportTitle: 'SUPPLIER AGING REPORT',
          reportDate: new Date().toLocaleDateString()
        });
        
        const supplierAgingData = await reportGeneratorService.generateSupplierAgingReport(companyId);
        
        if (supplierAgingData && supplierAgingData.data && supplierAgingData.data.length > 0) {
          const saHeaders = ['Supplier', 'Code', 'Total Balance', 'Invoices'];
          const saColWidths = [120, 60, 80, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let saX = 30;
          saHeaders.forEach((header, i) => {
            doc.text(header, saX, doc.y, { width: saColWidths[i] });
            saX += saColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalOutstanding = 0;
          supplierAgingData.data.forEach(item => {
            saX = 30;
            totalOutstanding += item.totalBalance || 0;
            const rowData = [
              (item.supplier?.name || '-').substring(0, 25),
              item.supplier?.code || '-',
              (item.totalBalance || 0).toFixed(2),
              (item.invoices?.length || 0).toString()
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), saX, doc.y, { width: saColWidths[i] });
              saX += saColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Suppliers: ${supplierAgingData.data.length}`, 30);
          doc.text(`Total Outstanding: ${totalOutstanding.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No supplier aging data found.', { align: 'center' });
        }
        break;

      case 'purchase-returns':
        const companyPR = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyPR?.name || 'Company',
          companyTin: companyPR?.tin || 'N/A',
          reportTitle: 'PURCHASE RETURNS REPORT',
          reportDate: new Date().toLocaleDateString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });
        
        const purchaseReturnsData = await reportGeneratorService.generatePurchaseReturnsReport(companyId, reportPeriodStart, reportPeriodEnd);
        
        if (purchaseReturnsData && purchaseReturnsData.data && purchaseReturnsData.data.length > 0) {
          // Use same approach as Suppliers report - percentage-based widths
          const prHeaders = ['Return #', 'Supplier', 'Date', 'Amount', 'Status'];
          
          // Compute responsive column widths - use fallback if page.width is undefined
          const prLeftMargin = 30;
          const prRightMargin = 30;
          const prPageWidth = doc.page?.width || 612; // Default to letter size
          const prAvailableWidth = Math.round(prPageWidth - prLeftMargin - prRightMargin);
          const prColPercents = [0.12, 0.30, 0.15, 0.18, 0.15];
          let prColWidths = prColPercents.map(p => Math.floor(prAvailableWidth * p));
          // Fix rounding error by ensuring last column fills remainder
          const prWidthsSum = prColWidths.reduce((s, v) => s + v, 0);
          if (prWidthsSum < prAvailableWidth) prColWidths[prColWidths.length - 1] += (prAvailableWidth - prWidthsSum);

          const prTruncateText = (text, width) => {
            if (!text) return '-';
            const approxChars = Math.max(6, Math.floor(width / 6));
            if (String(text).length <= approxChars) return String(text);
            return String(text).substring(0, approxChars - 3) + '...';
          };

          const renderPRHeader = (y) => {
            doc.rect(prLeftMargin - 5, y - 2, prColWidths.reduce((a, b) => a + b, 0) + 10, 28).fill('#1e40af');
            doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
            let x = prLeftMargin;
            prHeaders.forEach((h, i) => {
              doc.text(h, x, y + 8, { width: prColWidths[i] });
              x += prColWidths[i];
            });
          };

          // Render header
          renderPRHeader(doc.y);
          doc.moveDown(0.5);
          doc.fillColor('#000000').font('Helvetica').fontSize(8);
          
          let totalAmount = 0;
          purchaseReturnsData.data.forEach((item, idx) => {
            // Check for page overflow
            if (doc.y > doc.page.height - 80) {
              doc.addPage();
              // Reprint header - use helper function
              renderPRHeader(doc.y);
              doc.moveDown(0.5);
              doc.fillColor('#000000').font('Helvetica').fontSize(8);
            }
            
            // Zebra striping
            if (idx % 2 === 0) {
              doc.rect(prLeftMargin - 5, doc.y - 2, prColWidths.reduce((a, b) => a + b, 0) + 10, 18).fill('#f3f4f6');
            }
            
            let prRowX = prLeftMargin;
            totalAmount += item.total || 0;
            const rowData = [
              prTruncateText(item.returnNumber || '-', prColWidths[0]),
              prTruncateText(item.supplier?.name || '-', prColWidths[1]),
              item.returnDate ? new Date(item.returnDate).toLocaleDateString() : '-',
              (item.total || 0).toFixed(2),
              item.status || '-'
            ];
            rowData.forEach((cell, i) => {
              const align = i === 3 ? 'right' : 'left'; // Amount is right-aligned
              doc.text(String(cell), prRowX, doc.y, { width: prColWidths[i], align });
              prRowX += prColWidths[i];
            });
            doc.moveDown(0.4);
          });
          
          doc.moveDown(1);
          // Draw totals box
          doc.rect(25, doc.y - 2, doc.page.width - 50, 25).fill('#e5e7eb');
          doc.fontSize(10).font('Helvetica-Bold');
          doc.fillColor('#111827');
          doc.text(`Total Returns: ${purchaseReturnsData.data.length}`, 30, doc.y + 2);
          doc.text(`Total Amount: ${totalAmount.toFixed(2)}`, doc.page.width - 100, doc.y + 2, { width: 90, align: 'right' });
        } else {
          doc.fontSize(10).text('No purchase returns found for this period.', { align: 'center' });
        }
        break;

      case 'purchase-order-status':
        const companyPOS = await Company.findById(companyId);
        doc.fontSize(16).text(companyPOS?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyPOS?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('PURCHASE ORDER STATUS REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const purchaseOrderStatusData = await reportGeneratorService.generatePurchaseOrderStatusReport(companyId, reportPeriodStart, reportPeriodEnd);
        
        if (purchaseOrderStatusData && purchaseOrderStatusData.summary) {
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text('Summary by Status:', 30);
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(9);
          
          const statusSummary = purchaseOrderStatusData.summary.byStatus;
          doc.text(`Draft: ${statusSummary.draft?.count || 0} orders, Total: ${(statusSummary.draft?.total || 0).toFixed(2)}`, 50);
          doc.text(`Ordered: ${statusSummary.ordered?.count || 0} orders, Total: ${(statusSummary.ordered?.total || 0).toFixed(2)}`, 50);
          doc.text(`Received: ${statusSummary.received?.count || 0} orders, Total: ${(statusSummary.received?.total || 0).toFixed(2)}`, 50);
          doc.text(`Partial: ${statusSummary.partial?.count || 0} orders, Total: ${(statusSummary.partial?.total || 0).toFixed(2)}`, 50);
          doc.text(`Paid: ${statusSummary.paid?.count || 0} orders, Total: ${(statusSummary.paid?.total || 0).toFixed(2)}`, 50);
          doc.text(`Cancelled: ${statusSummary.cancelled?.count || 0} orders, Total: ${(statusSummary.cancelled?.total || 0).toFixed(2)}`, 50);
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Orders: ${purchaseOrderStatusData.summary.totalOrders || 0}`, 30);
        } else {
          doc.fontSize(10).text('No purchase order data found for this period.', { align: 'center' });
        }
        break;

      case 'supplier-performance':
        const companySP = await Company.findById(companyId);
        doc.fontSize(16).text(companySP?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companySP?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('SUPPLIER PERFORMANCE REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const supplierPerformanceData = await reportGeneratorService.generateSupplierPerformanceReport(companyId, reportPeriodStart, reportPeriodEnd);
        
        if (supplierPerformanceData && supplierPerformanceData.data && supplierPerformanceData.data.length > 0) {
          const spHeaders = ['Supplier', 'Orders', 'Total Amount', 'On-Time %', 'Avg Order'];
          const spColWidths = [100, 50, 80, 60, 70];
          doc.fontSize(9).font('Helvetica-Bold');
          let spX = 30;
          spHeaders.forEach((header, i) => {
            doc.text(header, spX, doc.y, { width: spColWidths[i] });
            spX += spColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          supplierPerformanceData.data.forEach(item => {
            spX = 30;
            const rowData = [
              (item.supplier?.name || '-').substring(0, 20),
              (item.totalOrders || 0).toString(),
              (item.totalAmount || 0).toFixed(2),
              (item.onTimeRate || 0).toFixed(1) + '%',
              (item.avgOrderValue || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), spX, doc.y, { width: spColWidths[i] });
              spX += spColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Suppliers: ${supplierPerformanceData.data.length}`, 30);
          doc.text(`Avg On-Time Rate: ${(supplierPerformanceData.summary?.avgOnTimeRate || 0).toFixed(1)}%`, 200);
        } else {
          doc.fontSize(10).text('No supplier performance data found for this period.', { align: 'center' });
        }
        break;

      // ============================================
      // NEW SALES REPORTS
      // ============================================
      case 'sales-by-product': {
        const companySBP = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companySBP?.name || 'Company',
          companyTin: companySBP?.tin || 'N/A',
          reportTitle: 'SALES BY PRODUCT REPORT',
          reportDate: new Date().toLocaleString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });
        
        const salesByProductPdf = await reportGeneratorService.generateSalesByProductReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (salesByProductPdf && salesByProductPdf.data && salesByProductPdf.data.length > 0) {
          const sbpHeaders = ['SKU', 'Product Name', 'Qty Sold', 'Revenue'];
          const sbpColWidths = [60, 150, 60, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let sbpX = 30;
          sbpHeaders.forEach((header, i) => {
            doc.text(header, sbpX, doc.y, { width: sbpColWidths[i] });
            sbpX += sbpColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalRevenue = 0;
          salesByProductPdf.data.forEach(item => {
            totalRevenue += item.revenue || 0;
            sbpX = 30;
            const rowData = [
              item.product?.sku || '-',
              (item.product?.name || 'Unknown').substring(0, 30),
              (item.quantitySold || 0).toString(),
              (item.revenue || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), sbpX, doc.y, { width: sbpColWidths[i] });
              sbpX += sbpColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Products: ${salesByProductPdf.data.length}`, 30);
          doc.text(`Total Revenue: ${totalRevenue.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No sales data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'sales-by-category': {
        const companySBC = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companySBC?.name || 'Company',
          companyTin: companySBC?.tin || 'N/A',
          reportTitle: 'SALES BY CATEGORY REPORT',
          reportDate: new Date().toLocaleString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });
        
        const salesByCategoryPdf = await reportGeneratorService.generateSalesByCategoryReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (salesByCategoryPdf && salesByCategoryPdf.data && salesByCategoryPdf.data.length > 0) {
          const sbcHeaders = ['Category', 'Products', 'Qty Sold', 'Revenue'];
          const sbcColWidths = [100, 60, 60, 100];
          doc.fontSize(9).font('Helvetica-Bold');
          let sbcX = 30;
          sbcHeaders.forEach((header, i) => {
            doc.text(header, sbcX, doc.y, { width: sbcColWidths[i] });
            sbcX += sbcColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalRevenue = 0;
          salesByCategoryPdf.data.forEach(item => {
            totalRevenue += item.revenue || 0;
            sbcX = 30;
            const rowData = [
              (item.category || 'Uncategorized').substring(0, 20),
              (item.productCount || 0).toString(),
              (item.quantitySold || 0).toString(),
              (item.revenue || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), sbcX, doc.y, { width: sbcColWidths[i] });
              sbcX += sbcColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Categories: ${salesByCategoryPdf.data.length}`, 30);
          doc.text(`Total Revenue: ${totalRevenue.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No sales data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'sales-by-client': {
        const companySBCt = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companySBCt?.name || 'Company',
          companyTin: companySBCt?.tin || 'N/A',
          reportTitle: 'SALES BY CLIENT REPORT',
          reportDate: new Date().toLocaleString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });
        
        const salesByClientPdf = await reportGeneratorService.generateSalesByClientReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (salesByClientPdf && salesByClientPdf.data && salesByClientPdf.data.length > 0) {
          const sbcHeaders = ['Code', 'Client Name', 'Invoices', 'Total Sales'];
          const sbcColWidths = [60, 150, 60, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let sbcX = 30;
          sbcHeaders.forEach((header, i) => {
            doc.text(header, sbcX, doc.y, { width: sbcColWidths[i] });
            sbcX += sbcColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalSales = 0;
          salesByClientPdf.data.forEach(item => {
            totalSales += item.totalSales || 0;
            sbcX = 30;
            const rowData = [
              item.client?.code || '-',
              (item.client?.name || 'Unknown').substring(0, 30),
              (item.invoiceCount || 0).toString(),
              (item.totalSales || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), sbcX, doc.y, { width: sbcColWidths[i] });
              sbcX += sbcColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Clients: ${salesByClientPdf.data.length}`, 30);
          doc.text(`Total Sales: ${totalSales.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No sales data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'sales-by-salesperson': {
        const companySBS = await Company.findById(companyId);
        doc.fontSize(16).text(companySBS?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companySBS?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('SALES BY SALESPERSON REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const salesBySalespersonPdf = await reportGeneratorService.generateSalesBySalespersonReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (salesBySalespersonPdf && salesBySalespersonPdf.data && salesBySalespersonPdf.data.length > 0) {
          const sbsHeaders = ['Salesperson', 'Invoices', 'Total Sales'];
          const sbsColWidths = [150, 80, 120];
          doc.fontSize(9).font('Helvetica-Bold');
          let sbsX = 30;
          sbsHeaders.forEach((header, i) => {
            doc.text(header, sbsX, doc.y, { width: sbsColWidths[i] });
            sbsX += sbsColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalSales = 0;
          salesBySalespersonPdf.data.forEach(item => {
            totalSales += item.totalSales || 0;
            sbsX = 30;
            const rowData = [
              (item.salesperson?.name || 'Unknown').substring(0, 30),
              (item.invoiceCount || 0).toString(),
              (item.totalSales || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), sbsX, doc.y, { width: sbsColWidths[i] });
              sbsX += sbsColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Salespersons: ${salesBySalespersonPdf.data.length}`, 30);
          doc.text(`Total Sales: ${totalSales.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No sales data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'invoice-aging': {
        const companyIA = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyIA?.name || 'Company',
          companyTin: companyIA?.tin || 'N/A',
          reportTitle: 'INVOICE AGING REPORT',
          reportDate: new Date().toLocaleString()
        });
        
        const invoiceAgingPdf = await reportGeneratorService.generateInvoiceAgingReport(companyId);
        if (invoiceAgingPdf && invoiceAgingPdf.buckets) {
          const allInvoices = [...(invoiceAgingPdf.buckets.current || []), ...(invoiceAgingPdf.buckets['1-30'] || []), ...(invoiceAgingPdf.buckets['31-60'] || []), ...(invoiceAgingPdf.buckets['61-90'] || []), ...(invoiceAgingPdf.buckets['90+'] || [])];
          
          if (allInvoices.length > 0) {
            const iaHeaders = ['Invoice #', 'Client', 'Due Date', 'Days', 'Balance'];
            const iaColWidths = [60, 120, 60, 50, 80];
            doc.fontSize(9).font('Helvetica-Bold');
            let iaX = 30;
            iaHeaders.forEach((header, i) => {
              doc.text(header, iaX, doc.y, { width: iaColWidths[i] });
              iaX += iaColWidths[i];
            });
            doc.moveDown(0.5);
            doc.font('Helvetica').fontSize(8);
            
            let totalBalance = 0;
            allInvoices.forEach(item => {
              totalBalance += item.balance || 0;
              iaX = 30;
              const rowData = [
                item.invoice?.invoiceNumber || '-',
                (item.invoice?.client?.name || '-').substring(0, 25),
                item.invoice?.dueDate ? new Date(item.invoice.dueDate).toLocaleDateString() : '-',
                (item.days || 0).toString(),
                (item.balance || 0).toFixed(2)
              ];
              rowData.forEach((cell, i) => {
                doc.text(String(cell), iaX, doc.y, { width: iaColWidths[i] });
                iaX += iaColWidths[i];
              });
              doc.moveDown(0.3);
            });
            doc.moveDown(1);
            doc.fontSize(10).font('Helvetica-Bold');
            doc.text(`Total Invoices: ${allInvoices.length}`, 30);
            doc.text(`Total Balance: ${totalBalance.toFixed(2)}`, 200);
          } else {
            doc.fontSize(10).text('No outstanding invoices found.', { align: 'center' });
          }
        } else {
          doc.fontSize(10).text('No aging data found.', { align: 'center' });
        }
        break;
      }

      case 'accounts-receivable': {
        const companyAR = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyAR?.name || 'Company',
          companyTin: companyAR?.tin || 'N/A',
          reportTitle: 'ACCOUNTS RECEIVABLE REPORT',
          reportDate: new Date().toLocaleString()
        });
        
        const arPdf = await reportGeneratorService.generateAccountsReceivableReport(companyId);
        if (arPdf && arPdf.data && arPdf.data.length > 0) {
          const arHeaders = ['Invoice #', 'Client', 'Date', 'Total', 'Paid', 'Balance'];
          const arColWidths = [50, 100, 50, 60, 60, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let arX = 30;
          arHeaders.forEach((header, i) => {
            doc.text(header, arX, doc.y, { width: arColWidths[i] });
            arX += arColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalBalance = 0;
          arPdf.data.forEach(item => {
            totalBalance += item.balance || 0;
            arX = 30;
            const rowData = [
              item.invoiceNumber || '-',
              (item.client?.name || '-').substring(0, 20),
              item.invoiceDate ? new Date(item.invoiceDate).toLocaleDateString() : '-',
              (item.total || 0).toFixed(2),
              (item.paid || 0).toFixed(2),
              (item.balance || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), arX, doc.y, { width: arColWidths[i] });
              arX += arColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Invoices: ${arPdf.data.length}`, 30);
          doc.text(`Total Receivable: ${totalBalance.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No accounts receivable found.', { align: 'center' });
        }
        break;
      }

      case 'credit-notes':
      case 'credit-notes-report': {
        const companyCNR = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyCNR?.name || 'Company',
          companyTin: companyCNR?.tin || 'N/A',
          reportTitle: 'CREDIT NOTES REPORT',
          reportDate: new Date().toLocaleString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });
        
        const cnPdf = await reportGeneratorService.generateCreditNotesReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (cnPdf && cnPdf.data && cnPdf.data.length > 0) {
          const cnHeaders = ['Credit Note #', 'Client', 'Date', 'Amount', 'Status'];
          const cnColWidths = [60, 100, 60, 80, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let cnX = 30;
          cnHeaders.forEach((header, i) => {
            doc.text(header, cnX, doc.y, { width: cnColWidths[i] });
            cnX += cnColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalAmount = 0;
          cnPdf.data.forEach(item => {
            totalAmount += item.grandTotal || 0;
            cnX = 30;
            const rowData = [
              item.creditNoteNumber || '-',
              (item.client?.name || '-').substring(0, 20),
              item.issueDate ? new Date(item.issueDate).toLocaleDateString() : '-',
              (item.grandTotal || 0).toFixed(2),
              item.status || '-'
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), cnX, doc.y, { width: cnColWidths[i] });
              cnX += cnColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Credit Notes: ${cnPdf.data.length}`, 30);
          doc.text(`Total Amount: ${totalAmount.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No credit notes found for this period.', { align: 'center' });
        }
        break;
      }

      case 'quotation-conversion': {
        const companyQCR = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyQCR?.name || 'Company',
          companyTin: companyQCR?.tin || 'N/A',
          reportTitle: 'QUOTATION CONVERSION REPORT',
          reportDate: new Date().toLocaleString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });
        
        const qcPdf = await reportGeneratorService.generateQuotationConversionReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (qcPdf && qcPdf.data && qcPdf.data.length > 0) {
          const qcHeaders = ['Quotation #', 'Client', 'Date', 'Amount', 'Status'];
          const qcColWidths = [60, 100, 60, 80, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let qcX = 30;
          qcHeaders.forEach((header, i) => {
            doc.text(header, qcX, doc.y, { width: qcColWidths[i] });
            qcX += qcColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          qcPdf.data.forEach(item => {
            qcX = 30;
            const rowData = [
              item.quotationNumber || '-',
              (item.client?.name || '-').substring(0, 20),
              item.quotationDate ? new Date(item.quotationDate).toLocaleDateString() : '-',
              (item.grandTotal || 0).toFixed(2),
              item.status || '-'
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), qcX, doc.y, { width: qcColWidths[i] });
              qcX += qcColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Quotations: ${qcPdf.data.length}`, 30);
        } else {
          doc.fontSize(10).text('No quotation data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'recurring-invoice': {
        const companyRIR = await Company.findById(companyId);
        
        // Use pdfRenderer for consistent header
        pdfRenderer.renderReportHeader(doc, {
          companyName: companyRIR?.name || 'Company',
          companyTin: companyRIR?.tin || 'N/A',
          reportTitle: 'RECURRING INVOICE REPORT',
          reportDate: new Date().toLocaleString(),
          period: `${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`
        });
        
        const riPdf = await reportGeneratorService.generateRecurringInvoiceReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (riPdf && riPdf.data && riPdf.data.length > 0) {
          const riHeaders = ['Invoice #', 'Client', 'Date', 'Amount', 'Status'];
          const riColWidths = [60, 100, 60, 80, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let riX = 30;
          riHeaders.forEach((header, i) => {
            doc.text(header, riX, doc.y, { width: riColWidths[i] });
            riX += riColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalAmount = 0;
          riPdf.data.forEach(item => {
            totalAmount += item.grandTotal || 0;
            riX = 30;
            const rowData = [
              item.invoiceNumber || '-',
              (item.client?.name || '-').substring(0, 20),
              item.invoiceDate ? new Date(item.invoiceDate).toLocaleDateString() : '-',
              (item.grandTotal || 0).toFixed(2),
              item.status || '-'
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), riX, doc.y, { width: riColWidths[i] });
              riX += riColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Invoices: ${riPdf.data.length}`, 30);
          doc.text(`Total Amount: ${totalAmount.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No recurring invoice data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'discount-report': {
        const companyDR = await Company.findById(companyId);
        doc.fontSize(16).text(companyDR?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyDR?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('DISCOUNT REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const drPdf = await reportGeneratorService.generateDiscountReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (drPdf && drPdf.data && drPdf.data.length > 0) {
          const drHeaders = ['Invoice #', 'Client', 'Subtotal', 'Discount', 'Disc %'];
          const drColWidths = [60, 100, 70, 70, 50];
          doc.fontSize(9).font('Helvetica-Bold');
          let drX = 30;
          drHeaders.forEach((header, i) => {
            doc.text(header, drX, doc.y, { width: drColWidths[i] });
            drX += drColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalDiscounts = 0;
          drPdf.data.forEach(item => {
            totalDiscounts += item.totalDiscount || 0;
            drX = 30;
            const rowData = [
              item.invoiceNumber || '-',
              (item.client?.name || '-').substring(0, 20),
              (item.subtotal || 0).toFixed(2),
              (item.totalDiscount || 0).toFixed(2),
              (item.discountPercent || 0).toFixed(1) + '%'
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), drX, doc.y, { width: drColWidths[i] });
              drX += drColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Invoices with Discounts: ${drPdf.data.length}`, 30);
          doc.text(`Total Discounts: ${totalDiscounts.toFixed(2)}`, 200);
        } else {
          doc.fontSize(10).text('No discount data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'daily-sales-summary': {
        const companyDSS = await Company.findById(companyId);
        doc.fontSize(16).text(companyDSS?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyDSS?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('DAILY SALES SUMMARY', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const dssPdf = await reportGeneratorService.generateDailySalesSummaryReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (dssPdf && dssPdf.dailyData && dssPdf.dailyData.length > 0) {
          const dssHeaders = ['Date', 'Invoices', 'Sales', 'Tax', 'Discounts', 'Net Sales'];
          const dssColWidths = [50, 40, 70, 60, 60, 70];
          doc.fontSize(9).font('Helvetica-Bold');
          let dssX = 30;
          dssHeaders.forEach((header, i) => {
            doc.text(header, dssX, doc.y, { width: dssColWidths[i] });
            dssX += dssColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          dssPdf.dailyData.forEach(item => {
            dssX = 30;
            const rowData = [
              item.date || '-',
              (item.invoiceCount || 0).toString(),
              (item.totalSales || 0).toFixed(2),
              (item.totalTax || 0).toFixed(2),
              (item.totalDiscounts || 0).toFixed(2),
              (item.netSales || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), dssX, doc.y, { width: dssColWidths[i] });
              dssX += dssColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Days: ${dssPdf.dailyData.length}`, 30);
          if (dssPdf.summary) {
            doc.text(`Total Sales: ${(dssPdf.summary.totalSales || 0).toFixed(2)}`, 200);
          }
        } else {
          doc.fontSize(10).text('No daily sales data found for this period.', { align: 'center' });
        }
        break;
      }

      // ============================================
      // EXPENSE REPORTS
      // ============================================
      case 'expense-by-category': {
        const companyEBC = await Company.findById(companyId);
        doc.fontSize(16).text(companyEBC?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyEBC?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('EXPENSE BY CATEGORY REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);

        const expenseByCategoryPdfData = await reportGeneratorService.generateExpenseByCategoryReport(companyId, reportPeriodStart, reportPeriodEnd);

        // Calculate total
        let totalExpense = 0;
        if (expenseByCategoryPdfData && expenseByCategoryPdfData.data) {
          expenseByCategoryPdfData.data.forEach(d => {
            totalExpense += d.total || 0;
          });
        }

        doc.fontSize(10);
        doc.text(`Total Expenses: ${totalExpense.toFixed(2)}`, 30);
        doc.moveDown(2);

        // Table header
        const ebcHeaders = ['Category', 'Description', 'Amount'];
        const ebcColWidths = [120, 200, 100];
        
        doc.fontSize(9).font('Helvetica-Bold');
        let ebcX = 30;
        ebcHeaders.forEach((header, i) => {
          doc.text(header, ebcX, doc.y, { width: ebcColWidths[i] });
          ebcX += ebcColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(8);

        if (expenseByCategoryPdfData && expenseByCategoryPdfData.data) {
          expenseByCategoryPdfData.data.forEach(item => {
            const rowData = [
              item.category || '-',
              (item.description || '').substring(0, 50),
              (item.total || 0).toFixed(2)
            ];
            
            ebcX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, ebcX, doc.y, { width: ebcColWidths[i] });
              ebcX += ebcColWidths[i];
            });
            doc.moveDown(0.3);
          });
        }
        break;
      }

      case 'expense-by-period': {
        const companyEBP = await Company.findById(companyId);
        doc.fontSize(16).text(companyEBP?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyEBP?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('EXPENSE BY PERIOD REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);

        const expenseByPeriodPdfData = await reportGeneratorService.generateExpenseByPeriodReport(companyId, reportPeriodStart, reportPeriodEnd);

        // Calculate total
        let totalExpensePeriod = 0;
        if (expenseByPeriodPdfData && expenseByPeriodPdfData.data) {
          expenseByPeriodPdfData.data.forEach(d => {
            totalExpensePeriod += d.total || 0;
          });
        }

        doc.fontSize(10);
        doc.text(`Total Expenses: ${totalExpensePeriod.toFixed(2)}`, 30);
        doc.moveDown(2);

        // Table header
        const ebpHeaders = ['Period', 'Category', 'Amount'];
        const ebpColWidths = [100, 150, 100];
        
        doc.fontSize(9).font('Helvetica-Bold');
        let ebpX = 30;
        ebpHeaders.forEach((header, i) => {
          doc.text(header, ebpX, doc.y, { width: ebpColWidths[i] });
          ebpX += ebpColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(8);

        if (expenseByPeriodPdfData && expenseByPeriodPdfData.data) {
          expenseByPeriodPdfData.data.forEach(item => {
            const rowData = [
              item.period || '-',
              item.category || '-',
              (item.total || 0).toFixed(2)
            ];
            
            ebpX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, ebpX, doc.y, { width: ebpColWidths[i] });
              ebpX += ebpColWidths[i];
            });
            doc.moveDown(0.3);
          });
        }
        break;
      }

      case 'expense-vs-budget': {
        const companyEVB = await Company.findById(companyId);
        doc.fontSize(16).text(companyEVB?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyEVB?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('EXPENSE VS BUDGET REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);

        const expenseVsBudgetPdfData = await reportGeneratorService.generateExpenseVsBudgetReport(companyId, reportPeriodStart, reportPeriodEnd);

        // Calculate totals
        let totalBudget = 0, totalActual = 0;
        if (expenseVsBudgetPdfData && expenseVsBudgetPdfData.data) {
          expenseVsBudgetPdfData.data.forEach(d => {
            totalBudget += d.budget || 0;
            totalActual += d.actual || 0;
          });
        }

        doc.fontSize(10);
        doc.text(`Total Budget: ${totalBudget.toFixed(2)}`, 30);
        doc.text(`Total Actual: ${totalActual.toFixed(2)}`, 200);
        doc.moveDown(0.5);
        doc.text(`Variance: ${(totalBudget - totalActual).toFixed(2)}`, 30);
        doc.moveDown(2);

        // Table header
        const evbHeaders = ['Category', 'Budget', 'Actual', 'Variance', 'Variance %'];
        const evbColWidths = [100, 80, 80, 80, 70];
        
        doc.fontSize(9).font('Helvetica-Bold');
        let evbX = 30;
        evbHeaders.forEach((header, i) => {
          doc.text(header, evbX, doc.y, { width: evbColWidths[i] });
          evbX += evbColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(8);

        if (expenseVsBudgetPdfData && expenseVsBudgetPdfData.data) {
          expenseVsBudgetPdfData.data.forEach(item => {
            const rowData = [
              item.category || '-',
              (item.budget || 0).toFixed(2),
              (item.actual || 0).toFixed(2),
              (item.variance || 0).toFixed(2),
              (item.variancePercent || 0).toFixed(1) + '%'
            ];
            
            evbX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, evbX, doc.y, { width: evbColWidths[i] });
              evbX += evbColWidths[i];
            });
            doc.moveDown(0.3);
          });
        }
        break;
      }

      case 'employee-expense': {
        const companyEE = await Company.findById(companyId);
        doc.fontSize(16).text(companyEE?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyEE?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('EMPLOYEE EXPENSE REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);

        const employeeExpensePdfData = await reportGeneratorService.generateEmployeeExpenseReport(companyId, reportPeriodStart, reportPeriodEnd);

        // Calculate total
        let totalEmployeeExpense = 0;
        if (employeeExpensePdfData && employeeExpensePdfData.data) {
          employeeExpensePdfData.data.forEach(d => {
            totalEmployeeExpense += d.total || 0;
          });
        }

        doc.fontSize(10);
        doc.text(`Total Employee Expenses: ${totalEmployeeExpense.toFixed(2)}`, 30);
        doc.moveDown(2);

        // Table header
        const eeHeaders = ['Employee', 'Category', 'Count', 'Total Amount'];
        const eeColWidths = [120, 100, 60, 100];
        
        doc.fontSize(9).font('Helvetica-Bold');
        let eeX = 30;
        eeHeaders.forEach((header, i) => {
          doc.text(header, eeX, doc.y, { width: eeColWidths[i] });
          eeX += eeColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(8);

        if (employeeExpensePdfData && employeeExpensePdfData.data) {
          employeeExpensePdfData.data.forEach(item => {
            const rowData = [
              item.employee || '-',
              item.category || '-',
              (item.count || 0).toString(),
              (item.total || 0).toFixed(2)
            ];
            
            eeX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, eeX, doc.y, { width: eeColWidths[i] });
              eeX += eeColWidths[i];
            });
            doc.moveDown(0.3);
          });
        }
        break;
      }

      case 'petty-cash': {
        const companyPC = await Company.findById(companyId);
        doc.fontSize(16).text(companyPC?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyPC?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('PETTY CASH REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);

        const pettyCashPdfData = await reportGeneratorService.generatePettyCashReport(companyId, reportPeriodStart, reportPeriodEnd);

        // Calculate total
        let totalPettyCash = 0;
        if (pettyCashPdfData && pettyCashPdfData.data) {
          pettyCashPdfData.data.forEach(d => {
            totalPettyCash += d.amount || 0;
          });
        }

        doc.fontSize(10);
        doc.text(`Total Petty Cash: ${totalPettyCash.toFixed(2)}`, 30);
        doc.moveDown(2);

        // Table header
        const pcHeaders = ['Date', 'Description', 'Category', 'Amount', 'Status'];
        const pcColWidths = [60, 150, 80, 80, 60];
        
        doc.fontSize(9).font('Helvetica-Bold');
        let pcX = 30;
        pcHeaders.forEach((header, i) => {
          doc.text(header, pcX, doc.y, { width: pcColWidths[i] });
          pcX += pcColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(8);

        if (pettyCashPdfData && pettyCashPdfData.data) {
          pettyCashPdfData.data.forEach(item => {
            const rowData = [
              item.date ? new Date(item.date).toLocaleDateString() : '-',
              (item.description || '').substring(0, 35),
              item.category || '-',
              (item.amount || 0).toFixed(2),
              item.status || '-'
            ];
            
            pcX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, pcX, doc.y, { width: pcColWidths[i] });
              pcX += pcColWidths[i];
            });
            doc.moveDown(0.3);
          });
        }
        break;
      }

      // ============================================
      // TAX REPORTS
      // ============================================
      case 'vat-return': {
        const vatPdfData = await reportGeneratorService.generateVATReturnReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companyVat = await Company.findById(companyId);
        doc.fontSize(16).text(companyVat?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyVat?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('VAT RETURN REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        if (vatPdfData && vatPdfData.data) {
          doc.fontSize(11).text('Output VAT (Sales)', { underline: true });
          doc.fontSize(10).text(`Total Sales: ${(vatPdfData.data.outputVAT.totalSales || 0).toFixed(2)}`, 30);
          doc.text(`Total VAT: ${(vatPdfData.data.outputVAT.totalVAT || 0).toFixed(2)}`, 30);
          doc.moveDown(1);
          doc.fontSize(11).text('Input VAT (Purchases)', { underline: true });
          doc.fontSize(10).text(`Total Purchases: ${(vatPdfData.data.inputVAT.totalPurchases || 0).toFixed(2)}`, 30);
          doc.text(`Total VAT: ${(vatPdfData.data.inputVAT.totalVAT || 0).toFixed(2)}`, 30);
          doc.moveDown(1);
          doc.fontSize(12).font('Helvetica-Bold');
          doc.text(`NET VAT: ${(vatPdfData.data.netVAT || 0).toFixed(2)} (${vatPdfData.data.status})`, 30);
          doc.font('Helvetica').fontSize(9);
          doc.moveDown(1);
          doc.text(`RRA Form: ${vatPdfData.data.rraFilingInfo.formType}`, 30);
          doc.text(`Due Date: ${new Date(vatPdfData.data.rraFilingInfo.dueDate).toLocaleDateString()}`, 30);
        }
        break;
      }

      case 'paye-report': {
        const payePdfData = await reportGeneratorService.generatePAYEReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companyPaye = await Company.findById(companyId);
        doc.fontSize(16).text(companyPaye?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyPaye?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('PAYE REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        if (payePdfData && payePdfData.data) {
          doc.fontSize(10).text(`Total Employees: ${payePdfData.data.totalEmployees}`, 30);
          doc.text(`Total Gross Salary: ${(payePdfData.data.totalGrossSalary || 0).toFixed(2)}`, 30);
          doc.moveDown(0.5);
          doc.fontSize(12).font('Helvetica-Bold');
          doc.text(`Total PAYE: ${(payePdfData.data.totalPAYE || 0).toFixed(2)}`, 30);
          doc.font('Helvetica').fontSize(9);
          doc.moveDown(1);
          doc.text(`RRA Form: ${payePdfData.data.rraFilingInfo.formType}`, 30);
          doc.text(`Due Date: ${new Date(payePdfData.data.rraFilingInfo.dueDate).toLocaleDateString()}`, 30);
        }
        break;
      }

      case 'withholding-tax': {
        const whtPdfData = await reportGeneratorService.generateWithholdingTaxReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companyWht = await Company.findById(companyId);
        doc.fontSize(16).text(companyWht?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyWht?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('WITHHOLDING TAX REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        if (whtPdfData && whtPdfData.data) {
          doc.fontSize(10).text(`Withholding Tax Collected: ${(whtPdfData.data.withholdingTaxCollected.amount || 0).toFixed(2)}`, 30);
          doc.text(`Withholding Tax Paid: ${(whtPdfData.data.withholdingTaxPaid.amount || 0).toFixed(2)}`, 30);
          doc.moveDown(0.5);
          doc.fontSize(12).font('Helvetica-Bold');
          doc.text(`Net Withholding: ${(whtPdfData.data.netWithholding || 0).toFixed(2)}`, 30);
          doc.font('Helvetica').fontSize(9);
          doc.moveDown(1);
          doc.text(`RRA Form: ${whtPdfData.data.rraFilingInfo.formType}`, 30);
          doc.text(`Due Date: ${new Date(whtPdfData.data.rraFilingInfo.dueDate).toLocaleDateString()}`, 30);
        }
        break;
      }

      case 'corporate-tax': {
        const corpTaxPdfData = await reportGeneratorService.generateCorporateTaxReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companyCorpTax = await Company.findById(companyId);
        doc.fontSize(16).text(companyCorpTax?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyCorpTax?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('CORPORATE TAX REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        if (corpTaxPdfData && corpTaxPdfData.data) {
          doc.fontSize(10).text(`Gross Income: ${(corpTaxPdfData.data.grossIncome || 0).toFixed(2)}`, 30);
          doc.text(`Total Deductions: ${(corpTaxPdfData.data.deductions.total || 0).toFixed(2)}`, 30);
          doc.moveDown(0.5);
          doc.fontSize(11).font('Helvetica-Bold');
          doc.text(`Taxable Income: ${(corpTaxPdfData.data.taxableIncome || 0).toFixed(2)}`, 30);
          doc.fontSize(12);
          doc.text(`Corporate Tax (${corpTaxPdfData.data.taxRate}%): ${(corpTaxPdfData.data.corporateTax || 0).toFixed(2)}`, 30);
          doc.font('Helvetica').fontSize(9);
          doc.moveDown(1);
          doc.text(`RRA Form: ${corpTaxPdfData.data.rraFilingInfo.formType}`, 30);
          doc.text(`Due Date: ${new Date(corpTaxPdfData.data.rraFilingInfo.dueDate).toLocaleDateString()}`, 30);
        }
        break;
      }

      case 'tax-payment-history': {
        const taxPayPdfData = await reportGeneratorService.generateTaxPaymentHistory(companyId, reportPeriodStart, reportPeriodEnd);
        const companyTaxPay = await Company.findById(companyId);
        doc.fontSize(16).text(companyTaxPay?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyTaxPay?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('TAX PAYMENT HISTORY', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        if (taxPayPdfData && taxPayPdfData.data) {
          doc.fontSize(10).text(`Total Payments: ${taxPayPdfData.data.summary.totalPayments}`, 30);
          doc.text(`Total Amount: ${(taxPayPdfData.data.summary.totalAmount || 0).toFixed(2)}`, 30);
          doc.moveDown(2);
          const taxHeaders = ['Date', 'Tax Type', 'Amount', 'Status'];
          const taxColWidths = [80, 100, 80, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let taxX = 30;
          taxHeaders.forEach((header, i) => {
            doc.text(header, taxX, doc.y, { width: taxColWidths[i] });
            taxX += taxColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          if (taxPayPdfData.data.payments) {
            taxPayPdfData.data.payments.slice(0, 20).forEach(item => {
              const rowData = [
                item.date ? new Date(item.date).toLocaleDateString() : '-',
                item.taxType || '-',
                (item.amount || 0).toFixed(2),
                item.status || '-'
              ];
              taxX = 30;
              rowData.forEach((cell, i) => {
                doc.text(cell, taxX, doc.y, { width: taxColWidths[i] });
                taxX += taxColWidths[i];
              });
              doc.moveDown(0.3);
            });
          }
        }
        break;
      }

      case 'tax-calendar': {
        const taxCalPdfData = await reportGeneratorService.generateTaxCalendarReport(companyId, reportPeriodStart ? new Date(reportPeriodStart).getFullYear().toString() : null);
        const companyTaxCal = await Company.findById(companyId);
        doc.fontSize(16).text(companyTaxCal?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyTaxCal?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('TAX CALENDAR', { align: 'center', underline: true });
        doc.fontSize(9).text(`Year: ${taxCalPdfData?.data?.year || new Date().getFullYear()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        if (taxCalPdfData && taxCalPdfData.data) {
          doc.fontSize(10).text(`Total Due: ${taxCalPdfData.data.summary.totalDue}`, 30);
          doc.text(`Filed: ${taxCalPdfData.data.summary.filed}`, 30);
          doc.text(`Pending: ${taxCalPdfData.data.summary.pending}`, 30);
          doc.text(`Overdue: ${taxCalPdfData.data.summary.overdue}`, 30);
          doc.moveDown(2);
          const calHeaders = ['Tax Type', 'Period', 'Due Date', 'Status'];
          const calColWidths = [100, 100, 80, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let calX = 30;
          calHeaders.forEach((header, i) => {
            doc.text(header, calX, doc.y, { width: calColWidths[i] });
            calX += calColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          if (taxCalPdfData.data.calendar) {
            taxCalPdfData.data.calendar.forEach(item => {
              const rowData = [
                item.taxName || '-',
                item.period || '-',
                item.dueDate ? new Date(item.dueDate).toLocaleDateString() : '-',
                item.status || '-'
              ];
              calX = 30;
              rowData.forEach((cell, i) => {
                doc.text(cell, calX, doc.y, { width: calColWidths[i] });
                calX += calColWidths[i];
              });
              doc.moveDown(0.3);
            });
          }
        }
        break;
      }

      // ============================================
      // ASSET REPORTS
      // ============================================
      case 'asset-register': {
        const assetRegPdf = await reportGeneratorService.generateAssetRegisterReport(companyId);
        const companyAR = await Company.findById(companyId);
        doc.fontSize(16).text(companyAR?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyAR?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('ASSET REGISTER REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (assetRegPdf && assetRegPdf.summary) {
          doc.fontSize(10).text(`Total Assets: ${assetRegPdf.summary.totalAssets}`, 30);
          doc.text(`Active: ${assetRegPdf.summary.activeAssets}`, 30);
          doc.text(`Disposed: ${assetRegPdf.summary.disposedAssets}`, 30);
          doc.text(`Fully Depreciated: ${assetRegPdf.summary.fullyDepreciated}`, 30);
          doc.moveDown(1);
          doc.text(`Total Purchase Cost: ${assetRegPdf.summary.totalPurchaseCost.toFixed(2)}`, 30);
          doc.text(`Total Accum. Depreciation: ${assetRegPdf.summary.totalAccumulatedDepreciation.toFixed(2)}`, 30);
          doc.text(`Total Net Book Value: ${assetRegPdf.summary.totalNetBookValue.toFixed(2)}`, 30);
          doc.moveDown(2);
        }
        
        const arHeaders = ['Code', 'Name', 'Category', 'Status', 'Cost', 'Accum Depr', 'NBV'];
        const arColWidths = [50, 100, 60, 50, 60, 70, 60];
        doc.fontSize(8).font('Helvetica-Bold');
        let arX = 30;
        arHeaders.forEach((header, i) => {
          doc.text(header, arX, doc.y, { width: arColWidths[i] });
          arX += arColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(7);
        if (assetRegPdf && assetRegPdf.data) {
          assetRegPdf.data.forEach(item => {
            const rowData = [
              (item.assetCode || '-').substring(0, 10),
              (item.name || '-').substring(0, 20),
              (item.category || '-').substring(0, 12),
              (item.status || '-').substring(0, 10),
              (item.purchaseCost || 0).toFixed(2),
              (item.accumulatedDepreciation || 0).toFixed(2),
              (item.netBookValue || 0).toFixed(2)
            ];
            arX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, arX, doc.y, { width: arColWidths[i] });
              arX += arColWidths[i];
            });
            doc.moveDown(0.3);
          });
        }
        break;
      }

      case 'depreciation-schedule': {
        const depSchedPdf = await reportGeneratorService.generateDepreciationScheduleReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companyDS = await Company.findById(companyId);
        doc.fontSize(16).text(companyDS?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyDS?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('DEPRECIATION SCHEDULE', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (depSchedPdf && depSchedPdf.summary) {
          doc.fontSize(10).text(`Total Assets: ${depSchedPdf.summary.totalAssets}`, 30);
          doc.text(`Total Depreciation Periods: ${depSchedPdf.summary.totalDepreciationPeriods}`, 30);
          doc.moveDown(1);
        }
        
        const dsHeaders = ['Asset', 'Year', 'Annual Depr', 'Accum Depr', 'NBV'];
        const dsColWidths = [80, 40, 70, 80, 70];
        doc.fontSize(8).font('Helvetica-Bold');
        let dsX = 30;
        dsHeaders.forEach((header, i) => {
          doc.text(header, dsX, doc.y, { width: dsColWidths[i] });
          dsX += dsColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(7);
        if (depSchedPdf && depSchedPdf.data) {
          depSchedPdf.data.forEach(asset => {
            if (asset.schedule) {
              asset.schedule.forEach(period => {
                const rowData = [
                  (asset.assetCode || '-').substring(0, 15),
                  (period.year || '-').toString(),
                  (period.annualDepreciation || 0).toFixed(2),
                  (period.accumulatedDepreciation || 0).toFixed(2),
                  (period.netBookValue || 0).toFixed(2)
                ];
                dsX = 30;
                rowData.forEach((cell, i) => {
                  doc.text(cell, dsX, doc.y, { width: dsColWidths[i] });
                  dsX += dsColWidths[i];
                });
                doc.moveDown(0.3);
              });
            }
          });
        }
        break;
      }

      case 'asset-disposal': {
        const assetDispPdf = await reportGeneratorService.generateAssetDisposalReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companyAD = await Company.findById(companyId);
        doc.fontSize(16).text(companyAD?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyAD?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('ASSET DISPOSAL REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart ? reportPeriodStart.toLocaleDateString() : 'All'} - ${reportPeriodEnd ? reportPeriodEnd.toLocaleDateString() : 'All'}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (assetDispPdf && assetDispPdf.summary) {
          doc.fontSize(10).text(`Total Disposed: ${assetDispPdf.summary.totalDisposed}`, 30);
          doc.text(`Total Proceeds: ${assetDispPdf.summary.totalDisposalProceeds.toFixed(2)}`, 30);
          doc.text(`Total Gain/Loss: ${assetDispPdf.summary.totalGainLoss.toFixed(2)}`, 30);
          doc.moveDown(2);
        }
        
        const dispHeaders = ['Code', 'Name', 'Cost', 'NBV', 'Proceeds', 'Gain/Loss'];
        const dispColWidths = [50, 100, 60, 60, 60, 60];
        doc.fontSize(8).font('Helvetica-Bold');
        let dispX = 30;
        dispHeaders.forEach((header, i) => {
          doc.text(header, dispX, doc.y, { width: dispColWidths[i] });
          dispX += dispColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(7);
        if (assetDispPdf && assetDispPdf.data) {
          assetDispPdf.data.forEach(item => {
            const rowData = [
              (item.assetCode || '-').substring(0, 10),
              (item.name || '-').substring(0, 20),
              (item.purchaseCost || 0).toFixed(2),
              (item.netBookValue || 0).toFixed(2),
              (item.disposalAmount || 0).toFixed(2),
              (item.gainLoss || 0).toFixed(2)
            ];
            dispX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, dispX, doc.y, { width: dispColWidths[i] });
              dispX += dispColWidths[i];
            });
            doc.moveDown(0.3);
          });
        }
        break;
      }

      case 'asset-maintenance': {
        const assetMaintPdf = await reportGeneratorService.generateAssetMaintenanceReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companyAM = await Company.findById(companyId);
        doc.fontSize(16).text(companyAM?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyAM?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('ASSET MAINTENANCE REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart ? reportPeriodStart.toLocaleDateString() : 'All'} - ${reportPeriodEnd ? reportPeriodEnd.toLocaleDateString() : 'All'}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (assetMaintPdf && assetMaintPdf.summary) {
          doc.fontSize(10).text(`Assets with Maintenance: ${assetMaintPdf.summary.totalAssetsWithMaintenance}`, 30);
          doc.text(`Total Records: ${assetMaintPdf.summary.totalMaintenanceRecords}`, 30);
          doc.text(`Total Cost: ${assetMaintPdf.summary.totalMaintenanceCost.toFixed(2)}`, 30);
          doc.moveDown(2);
        }
        
        const maintHeaders = ['Asset', 'Date', 'Type', 'Description', 'Cost'];
        const maintColWidths = [60, 60, 60, 180, 50];
        doc.fontSize(8).font('Helvetica-Bold');
        let maintX = 30;
        maintHeaders.forEach((header, i) => {
          doc.text(header, maintX, doc.y, { width: maintColWidths[i] });
          maintX += maintColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(7);
        if (assetMaintPdf && assetMaintPdf.data) {
          assetMaintPdf.data.forEach(asset => {
            if (asset.maintenanceRecords) {
              asset.maintenanceRecords.forEach(record => {
                const rowData = [
                  (asset.assetCode || '-').substring(0, 12),
                  record.date ? new Date(record.date).toLocaleDateString() : '-',
                  (record.type || '-').substring(0, 12),
                  (record.description || '-').substring(0, 40),
                  (record.cost || 0).toFixed(2)
                ];
                maintX = 30;
                rowData.forEach((cell, i) => {
                  doc.text(cell, maintX, doc.y, { width: maintColWidths[i] });
                  maintX += maintColWidths[i];
                });
                doc.moveDown(0.3);
              });
            }
          });
        }
        break;
      }

      case 'net-book-value': {
        const nbvPdf = await reportGeneratorService.generateNetBookValueReport(companyId);
        const companyNBV = await Company.findById(companyId);
        doc.fontSize(16).text(companyNBV?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyNBV?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('NET BOOK VALUE REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (nbvPdf && nbvPdf.summary) {
          doc.fontSize(10).text(`Total Assets: ${nbvPdf.summary.totalAssets}`, 30);
          doc.text(`Active: ${nbvPdf.summary.activeAssets}`, 30);
          doc.text(`Disposed: ${nbvPdf.summary.disposedAssets}`, 30);
          doc.text(`Fully Depreciated: ${nbvPdf.summary.fullyDepreciated}`, 30);
          doc.moveDown(1);
          doc.text(`Total Purchase Cost: ${nbvPdf.summary.totalPurchaseCost.toFixed(2)}`, 30);
          doc.text(`Total Accum. Depreciation: ${nbvPdf.summary.totalAccumulatedDepreciation.toFixed(2)}`, 30);
          doc.text(`Total Net Book Value: ${nbvPdf.summary.totalNetBookValue.toFixed(2)}`, 30);
          doc.moveDown(2);
        }
        
        const nbvHeaders = ['Code', 'Name', 'Category', 'Status', 'Cost', 'NBV', 'Rem. Life'];
        const nbvColWidths = [45, 90, 50, 50, 55, 55, 55];
        doc.fontSize(8).font('Helvetica-Bold');
        let nbvX = 30;
        nbvHeaders.forEach((header, i) => {
          doc.text(header, nbvX, doc.y, { width: nbvColWidths[i] });
          nbvX += nbvColWidths[i];
        });
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(7);
        if (nbvPdf && nbvPdf.data) {
          nbvPdf.data.forEach(item => {
            const rowData = [
              (item.assetCode || '-').substring(0, 8),
              (item.name || '-').substring(0, 18),
              (item.category || '-').substring(0, 10),
              (item.status || '-').substring(0, 10),
              (item.purchaseCost || 0).toFixed(2),
              (item.netBookValue || 0).toFixed(2),
              item.remainingLife ? item.remainingLife.toFixed(1) : '0'
            ];
            nbvX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, nbvX, doc.y, { width: nbvColWidths[i] });
              nbvX += nbvColWidths[i];
            });
            doc.moveDown(0.3);
          });
        }
        break;
      }

      // ============================================
      // STOCK & INVENTORY REPORTS
      // ============================================
      case 'stock-movement': {
        const stockMovPdf = await reportGeneratorService.generateStockMovementReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companySM = await Company.findById(companyId);
        doc.fontSize(16).text(companySM?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companySM?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('STOCK MOVEMENT REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (stockMovPdf && stockMovPdf.data && stockMovPdf.data.length > 0) {
          const smHeaders = ['SKU', 'Product', 'Total In', 'Total Out', 'Net Change', 'Movements'];
          const smColWidths = [60, 120, 60, 60, 60, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let smX = 30;
          smHeaders.forEach((header, i) => {
            doc.text(header, smX, doc.y, { width: smColWidths[i] });
            smX += smColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          stockMovPdf.data.forEach(item => {
            smX = 30;
            const rowData = [
              item.product?.sku || '-',
              (item.product?.name || 'Unknown').substring(0, 25),
              (item.totalIn || 0).toString(),
              (item.totalOut || 0).toString(),
              (item.netChange || 0).toString(),
              (item.movementCount || 0).toString()
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), smX, doc.y, { width: smColWidths[i] });
              smX += smColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No stock movement data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'low-stock': {
        const lowStockPdf = await reportGeneratorService.generateLowStockReport(companyId);
        const companyLS = await Company.findById(companyId);
        doc.fontSize(16).text(companyLS?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyLS?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('LOW STOCK REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (lowStockPdf && lowStockPdf.data && lowStockPdf.data.length > 0) {
          const lsHeaders = ['SKU', 'Product', 'Current Stock', 'Threshold', 'Shortage', 'Est. Reorder Cost'];
          const lsColWidths = [50, 100, 50, 50, 50, 70];
          doc.fontSize(9).font('Helvetica-Bold');
          let lsX = 30;
          lsHeaders.forEach((header, i) => {
            doc.text(header, lsX, doc.y, { width: lsColWidths[i] });
            lsX += lsColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          lowStockPdf.data.forEach(item => {
            lsX = 30;
            const rowData = [
              item.sku || '-',
              (item.name || 'Unknown').substring(0, 20),
              (item.currentStock || 0).toString(),
              (item.lowStockThreshold || 0).toString(),
              (item.shortage || 0).toString(),
              (item.estimatedReorderCost || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), lsX, doc.y, { width: lsColWidths[i] });
              lsX += lsColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No low stock items found.', { align: 'center' });
        }
        break;
      }

      case 'dead-stock': {
        const deadStockPdf = await reportGeneratorService.generateDeadStockReport(companyId);
        const companyDS = await Company.findById(companyId);
        doc.fontSize(16).text(companyDS?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyDS?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('DEAD STOCK REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (deadStockPdf && deadStockPdf.data && deadStockPdf.data.length > 0) {
          const dsHeaders = ['SKU', 'Product', 'Current Stock', 'Stock Value', 'Days Since Movement'];
          const dsColWidths = [60, 120, 60, 80, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let dsX = 30;
          dsHeaders.forEach((header, i) => {
            doc.text(header, dsX, doc.y, { width: dsColWidths[i] });
            dsX += dsColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          deadStockPdf.data.forEach(item => {
            dsX = 30;
            const rowData = [
              item.sku || '-',
              (item.name || 'Unknown').substring(0, 25),
              (item.currentStock || 0).toString(),
              (item.stockValue || 0).toFixed(2),
              (item.daysSinceMovement || 0).toString()
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), dsX, doc.y, { width: dsColWidths[i] });
              dsX += dsColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No dead stock items found.', { align: 'center' });
        }
        break;
      }

      case 'stock-aging': {
        const stockAgingPdf = await reportGeneratorService.generateStockAgingReport(companyId);
        const companySA = await Company.findById(companyId);
        doc.fontSize(16).text(companySA?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companySA?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('STOCK AGING REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (stockAgingPdf && stockAgingPdf.data) {
          const allBatches = [
            ...(stockAgingPdf.data['0-30'] || []),
            ...(stockAgingPdf.data['31-60'] || []),
            ...(stockAgingPdf.data['61-90'] || []),
            ...(stockAgingPdf.data['91-180'] || []),
            ...(stockAgingPdf.data['180+'] || [])
          ];
          
          if (allBatches.length > 0) {
            const saHeaders = ['Batch', 'Product', 'Quantity', 'Value', 'Days Old', 'Status'];
            const saColWidths = [50, 100, 50, 60, 50, 50];
            doc.fontSize(9).font('Helvetica-Bold');
            let saX = 30;
            saHeaders.forEach((header, i) => {
              doc.text(header, saX, doc.y, { width: saColWidths[i] });
              saX += saColWidths[i];
            });
            doc.moveDown(0.5);
            doc.font('Helvetica').fontSize(8);
            
            allBatches.forEach(item => {
              saX = 30;
              const rowData = [
                item.batchNumber || '-',
                (item.product?.name || 'Unknown').substring(0, 20),
                (item.quantity || 0).toString(),
                (item.totalValue || 0).toFixed(2),
                (item.daysOld || 0).toString(),
                item.status || '-'
              ];
              rowData.forEach((cell, i) => {
                doc.text(String(cell), saX, doc.y, { width: saColWidths[i] });
                saX += saColWidths[i];
              });
              doc.moveDown(0.3);
            });
          } else {
            doc.fontSize(10).text('No stock aging data found.', { align: 'center' });
          }
        } else {
          doc.fontSize(10).text('No stock aging data found.', { align: 'center' });
        }
        break;
      }

      case 'inventory-turnover': {
        const invTurnPdf = await reportGeneratorService.generateInventoryTurnoverReport(companyId, reportPeriodStart, reportPeriodEnd);
        const companyIT = await Company.findById(companyId);
        doc.fontSize(16).text(companyIT?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyIT?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('INVENTORY TURNOVER REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (invTurnPdf && invTurnPdf.data && invTurnPdf.data.length > 0) {
          const itHeaders = ['SKU', 'Product', 'Inventory Value', 'COGS', 'Turnover', 'Turnover Days'];
          const itColWidths = [50, 100, 70, 60, 50, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let itX = 30;
          itHeaders.forEach((header, i) => {
            doc.text(header, itX, doc.y, { width: itColWidths[i] });
            itX += itColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          invTurnPdf.data.forEach(item => {
            itX = 30;
            const rowData = [
              item.sku || '-',
              (item.name || 'Unknown').substring(0, 20),
              (item.inventoryValue || 0).toFixed(2),
              (item.cogs || 0).toFixed(2),
              (item.turnover || 0).toFixed(2),
              (item.turnoverDays || 0).toString()
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), itX, doc.y, { width: itColWidths[i] });
              itX += itColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No inventory turnover data found for this period.', { align: 'center' });
        }
        break;
      }

      case 'batch-expiry': {
        const batchExpPdf = await reportGeneratorService.generateBatchExpiryReport(companyId);
        const companyBE = await Company.findById(companyId);
        doc.fontSize(16).text(companyBE?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyBE?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('BATCH/EXPIRY REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (batchExpPdf && batchExpPdf.data && batchExpPdf.data.length > 0) {
          const beHeaders = ['Batch', 'Product', 'Quantity', 'Expiry Date', 'Days Left', 'Status'];
          const beColWidths = [50, 100, 50, 60, 50, 50];
          doc.fontSize(9).font('Helvetica-Bold');
          let beX = 30;
          beHeaders.forEach((header, i) => {
            doc.text(header, beX, doc.y, { width: beColWidths[i] });
            beX += beColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          batchExpPdf.data.forEach(item => {
            beX = 30;
            const rowData = [
              item.batchNumber || '-',
              (item.product?.name || 'Unknown').substring(0, 20),
              (item.quantity || 0).toString(),
              item.expiryDate ? new Date(item.expiryDate).toLocaleDateString() : '-',
              (item.daysUntilExpiry || 0).toString(),
              item.status || '-'
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), beX, doc.y, { width: beColWidths[i] });
              beX += beColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No batch/expiry data found.', { align: 'center' });
        }
        break;
      }

      case 'serial-number-tracking': {
        const serialPdf = await reportGeneratorService.generateSerialNumberTrackingReport(companyId);
        const companySN = await Company.findById(companyId);
        doc.fontSize(16).text(companySN?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companySN?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('SERIAL NUMBER TRACKING REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (serialPdf && serialPdf.data && serialPdf.data.length > 0) {
          const snHeaders = ['Serial Number', 'Product', 'Status', 'Purchase Date', 'Sale Date', 'Client'];
          const snColWidths = [80, 80, 50, 60, 60, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let snX = 30;
          snHeaders.forEach((header, i) => {
            doc.text(header, snX, doc.y, { width: snColWidths[i] });
            snX += snColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          serialPdf.data.forEach(item => {
            snX = 30;
            const rowData = [
              item.serialNumber || '-',
              (item.product?.name || 'Unknown').substring(0, 15),
              item.status || '-',
              item.purchaseDate ? new Date(item.purchaseDate).toLocaleDateString() : '-',
              item.saleDate ? new Date(item.saleDate).toLocaleDateString() : '-',
              (item.client?.name || 'N/A').substring(0, 15)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), snX, doc.y, { width: snColWidths[i] });
              snX += snColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No serial number tracking data found.', { align: 'center' });
        }
        break;
      }

      case 'warehouse-stock': {
        const warehousePdf = await reportGeneratorService.generateWarehouseStockReport(companyId);
        const companyWS = await Company.findById(companyId);
        doc.fontSize(16).text(companyWS?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyWS?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('WAREHOUSE STOCK REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);
        
        if (warehousePdf && warehousePdf.data && warehousePdf.data.length > 0) {
          const wsHeaders = ['Warehouse', 'Code', 'Products', 'Total Quantity', 'Total Value'];
          const wsColWidths = [120, 50, 50, 70, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let wsX = 30;
          wsHeaders.forEach((header, i) => {
            doc.text(header, wsX, doc.y, { width: wsColWidths[i] });
            wsX += wsColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          warehousePdf.data.forEach(item => {
            wsX = 30;
            const rowData = [
              (item.name || 'Unknown').substring(0, 25),
              item.code || '-',
              (item.totalProducts || 0).toString(),
              (item.totalQuantity || 0).toString(),
              (item.totalValue || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), wsX, doc.y, { width: wsColWidths[i] });
              wsX += wsColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No warehouse stock data found.', { align: 'center' });
        }
        break;
      }

      // ============================================
      // BANK & CASH REPORTS
      // ============================================
      case 'bank-reconciliation': {
        const companyBank1 = await Company.findById(companyId);
        doc.fontSize(16).text(companyBank1?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyBank1?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('BANK RECONCILIATION REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const bankReconPdf = await reportGeneratorService.generateBankReconciliationReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (bankReconPdf && bankReconPdf.data && bankReconPdf.data.length > 0) {
          const brHeaders = ['Account', 'Bank', 'Deposits', 'Withdrawals', 'Reconciled', 'Unreconciled'];
          const brColWidths = [60, 60, 60, 60, 60, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let brX = 30;
          brHeaders.forEach((header, i) => {
            doc.text(header, brX, doc.y, { width: brColWidths[i] });
            brX += brColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          bankReconPdf.data.forEach(item => {
            brX = 30;
            const rowData = [
              item.accountName || '-',
              item.bankName || '-',
              (item.totalDeposits || 0).toFixed(2),
              (item.totalWithdrawals || 0).toFixed(2),
              (item.reconciledAmount || 0).toFixed(2),
              (item.unreconciledAmount || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), brX, doc.y, { width: brColWidths[i] });
              brX += brColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No bank reconciliation data found.', { align: 'center' });
        }
        break;
      }

      case 'cash-position': {
        const companyBank2 = await Company.findById(companyId);
        doc.fontSize(16).text(companyBank2?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyBank2?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('CASH POSITION REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`As of: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const cashPosPdf = await reportGeneratorService.generateCashPositionReport(companyId);
        if (cashPosPdf && cashPosPdf.data && cashPosPdf.data.length > 0) {
          const cpHeaders = ['Account', 'Type', 'Bank', 'Balance'];
          const cpColWidths = [80, 60, 80, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let cpX = 30;
          cpHeaders.forEach((header, i) => {
            doc.text(header, cpX, doc.y, { width: cpColWidths[i] });
            cpX += cpColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          cashPosPdf.data.forEach(item => {
            cpX = 30;
            const rowData = [
              item.name || '-',
              item.accountType || '-',
              item.bankName || '-',
              (item.currentBalance || 0).toFixed(2)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), cpX, doc.y, { width: cpColWidths[i] });
              cpX += cpColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No cash position data found.', { align: 'center' });
        }
        break;
      }

      case 'bank-transaction': {
        const companyBank3 = await Company.findById(companyId);
        doc.fontSize(16).text(companyBank3?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyBank3?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('BANK TRANSACTION REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const bankTxnPdf = await reportGeneratorService.generateBankTransactionReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (bankTxnPdf && bankTxnPdf.data && bankTxnPdf.data.length > 0) {
          const btHeaders = ['Date', 'Account', 'Type', 'Amount', 'Description'];
          const btColWidths = [40, 60, 40, 50, 100];
          doc.fontSize(9).font('Helvetica-Bold');
          let btX = 30;
          btHeaders.forEach((header, i) => {
            doc.text(header, btX, doc.y, { width: btColWidths[i] });
            btX += btColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          bankTxnPdf.data.slice(0, 50).forEach(item => {
            btX = 30;
            const rowData = [
              item.date ? new Date(item.date).toLocaleDateString() : '-',
              item.accountName || '-',
              item.type || '-',
              (item.amount || 0).toFixed(2),
              (item.description || '-').substring(0, 30)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), btX, doc.y, { width: btColWidths[i] });
              btX += btColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No bank transaction data found.', { align: 'center' });
        }
        break;
      }

      case 'unreconciled-transactions': {
        const companyBank4 = await Company.findById(companyId);
        doc.fontSize(16).text(companyBank4?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${companyBank4?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('UNRECONCILED TRANSACTIONS REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const unreconciledPdf = await reportGeneratorService.generateUnreconciledTransactionsReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (unreconciledPdf && unreconciledPdf.data && unreconciledPdf.data.length > 0) {
          const urHeaders = ['Date', 'Account', 'Type', 'Amount', 'Description'];
          const urColWidths = [40, 60, 40, 50, 100];
          doc.fontSize(9).font('Helvetica-Bold');
          let urX = 30;
          urHeaders.forEach((header, i) => {
            doc.text(header, urX, doc.y, { width: urColWidths[i] });
            urX += urColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          unreconciledPdf.data.slice(0, 50).forEach(item => {
            urX = 30;
            const rowData = [
              item.date ? new Date(item.date).toLocaleDateString() : '-',
              item.accountName || '-',
              item.type || '-',
              (item.amount || 0).toFixed(2),
              (item.description || '-').substring(0, 30)
            ];
            rowData.forEach((cell, i) => {
              doc.text(String(cell), urX, doc.y, { width: urColWidths[i] });
              urX += urColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No unreconciled transactions found.', { align: 'center' });
        }
        break;
      }

      // ============================================
      // MISSING PERIOD/FINANCIAL REPORTS
      // ============================================
      case 'balance-sheet': {
        const bsCompany = await Company.findById(companyId);
        doc.fontSize(16).text(bsCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${bsCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('BALANCE SHEET', { align: 'center', underline: true });
        doc.fontSize(9).text(`As of: ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        // Get balance sheet data - only takes (companyId, asOfDate)
        const bsData = await reportGeneratorService.generateBalanceSheetReport(companyId, reportPeriodEnd);
        if (bsData) {
          doc.fontSize(11).font('Helvetica-Bold').text('ASSETS', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Current Assets: ${(bsData.currentAssets || 0).toFixed(2)}`, 70);
          doc.text(`Non-Current Assets: ${(bsData.nonCurrentAssets || 0).toFixed(2)}`, 70);
          doc.font('Helvetica-Bold').text(`Total Assets: ${(bsData.totalAssets || 0).toFixed(2)}`, 70);
          doc.moveDown(1);
          
          doc.fontSize(11).font('Helvetica-Bold').text('LIABILITIES', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Current Liabilities: ${(bsData.currentLiabilities || 0).toFixed(2)}`, 70);
          doc.text(`Non-Current Liabilities: ${(bsData.nonCurrentLiabilities || 0).toFixed(2)}`, 70);
          doc.font('Helvetica-Bold').text(`Total Liabilities: ${(bsData.totalLiabilities || 0).toFixed(2)}`, 70);
          doc.moveDown(1);
          
          doc.fontSize(11).font('Helvetica-Bold').text('EQUITY', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Share Capital: ${(bsData.shareCapital || 0).toFixed(2)}`, 70);
          doc.text(`Retained Earnings: ${(bsData.retainedEarnings || 0).toFixed(2)}`, 70);
          doc.text(`Current Period Profit: ${(bsData.currentPeriodProfit || 0).toFixed(2)}`, 70);
          doc.font('Helvetica-Bold').text(`Total Equity: ${(bsData.totalEquity || 0).toFixed(2)}`, 70);
        } else {
          doc.fontSize(10).text('Balance Sheet data not available.', { align: 'center' });
        }
        break;
      }

      case 'financial-ratios': {
        const frCompany = await Company.findById(companyId);
        doc.fontSize(16).text(frCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${frCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('FINANCIAL RATIOS', { align: 'center', underline: true });
        doc.fontSize(9).text(`As of: ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        // Get financial ratios from service
        const ratiosData = await reportGeneratorService.generateFinancialRatiosReport(companyId);
        if (ratiosData) {
          doc.fontSize(11).font('Helvetica-Bold').text('LIQUIDITY RATIOS', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Current Ratio: ${ratiosData.currentRatio?.toFixed(2) || 'N/A'}`, 70);
          doc.text(`Quick Ratio: ${ratiosData.quickRatio?.toFixed(2) || 'N/A'}`, 70);
          doc.moveDown(1);
          
          doc.fontSize(11).font('Helvetica-Bold').text('PROFITABILITY RATIOS', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Gross Margin: ${ratiosData.grossMargin?.toFixed(2) || 'N/A'}%`, 70);
          doc.text(`Net Profit Margin: ${ratiosData.netMargin?.toFixed(2) || 'N/A'}%`, 70);
          doc.text(`Return on Assets: ${ratiosData.returnOnAssets?.toFixed(2) || 'N/A'}%`, 70);
          doc.text(`Return on Equity: ${ratiosData.returnOnEquity?.toFixed(2) || 'N/A'}%`, 70);
        } else {
          doc.fontSize(10).text('Financial Ratios data not available.', { align: 'center' });
        }
        break;
      }

      case 'cash-flow': {
        const cfCompany = await Company.findById(companyId);
        doc.fontSize(16).text(cfCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${cfCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('CASH FLOW STATEMENT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const cfData = await reportGeneratorService.generateCashFlowReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (cfData && cfData.summary) {
          doc.fontSize(11).font('Helvetica-Bold').text('OPERATING ACTIVITIES', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Net Cash from Operations: ${(cfData.summary.operating?.netCashFlow || 0).toFixed(2)}`, 70);
          doc.moveDown(0.5);
          
          doc.fontSize(11).font('Helvetica-Bold').text('INVESTING ACTIVITIES', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Net Cash from Investing: ${(cfData.summary.investing?.netCashFlow || 0).toFixed(2)}`, 70);
          doc.moveDown(0.5);
          
          doc.fontSize(11).font('Helvetica-Bold').text('FINANCING ACTIVITIES', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Net Cash from Financing: ${(cfData.summary.financing?.netCashFlow || 0).toFixed(2)}`, 70);
          doc.moveDown(1);
          
          doc.fontSize(11).font('Helvetica-Bold');
          doc.text(`NET CHANGE IN CASH: ${(cfData.summary.netChangeInCash || 0).toFixed(2)}`, 50);
        } else {
          doc.fontSize(10).text('Cash Flow data not available.', { align: 'center' });
        }
        break;
      }

      case 'top-products': {
        const tpCompany = await Company.findById(companyId);
        doc.fontSize(16).text(tpCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${tpCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('TOP PRODUCTS BY SALES', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const tpData = await reportGeneratorService.generateSalesByProductReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (tpData && tpData.data) {
          const tpHeaders = ['SKU', 'Product Name', 'Quantity Sold', 'Revenue'];
          const tpColWidths = [60, 150, 60, 80];
          doc.fontSize(9).font('Helvetica-Bold');
          let tpX = 30;
          tpHeaders.forEach((header, i) => {
            doc.text(header, tpX, doc.y, { width: tpColWidths[i] });
            tpX += tpColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          tpData.data.slice(0, 50).forEach(item => {
            const rowData = [
              item.product?.sku || 'N/A',
              (item.product?.name || 'Unknown').substring(0, 30),
              (item.quantitySold || 0).toString(),
              (item.revenue || 0).toFixed(2)
            ];
            tpX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, tpX, doc.y, { width: tpColWidths[i] });
              tpX += tpColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('No product sales data available.', { align: 'center' });
        }
        break;
      }

      case 'vat-summary': {
        const vsCompany = await Company.findById(companyId);
        doc.fontSize(16).text(vsCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${vsCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('VAT SUMMARY REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const vsData = await reportGeneratorService.generateVATReturnReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (vsData && vsData.data) {
          doc.fontSize(11).font('Helvetica-Bold').text('OUTPUT VAT (Sales)', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Total Output VAT: ${(vsData.data.outputVAT?.totalVAT || 0).toFixed(2)}`, 70);
          doc.moveDown(1);
          
          doc.fontSize(11).font('Helvetica-Bold').text('INPUT VAT (Purchases)', 50);
          doc.font('Helvetica').fontSize(10);
          doc.text(`Total Input VAT: ${(vsData.data.inputVAT?.totalVAT || 0).toFixed(2)}`, 70);
          doc.moveDown(1);
          
          doc.fontSize(12).font('Helvetica-Bold');
          doc.text(`NET VAT: ${(vsData.data.netVAT || 0).toFixed(2)}`, 50);
        } else {
          doc.fontSize(10).text('VAT Summary data not available.', { align: 'center' });
        }
        break;
      }

      case 'product-performance': {
        const ppCompany = await Company.findById(companyId);
        doc.fontSize(16).text(ppCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${ppCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('PRODUCT PERFORMANCE REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const ppData = await reportGeneratorService.generateProductPerformanceReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (ppData && ppData.data) {
          const ppHeaders = ['SKU', 'Product Name', 'Qty Sold', 'Revenue', 'COGS', 'Margin'];
          const ppColWidths = [50, 120, 50, 60, 50, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let ppX = 30;
          ppHeaders.forEach((header, i) => {
            doc.text(header, ppX, doc.y, { width: ppColWidths[i] });
            ppX += ppColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          ppData.data.slice(0, 50).forEach(item => {
            const rowData = [
              item.product?.sku || 'N/A',
              (item.product?.name || 'Unknown').substring(0, 25),
              (item.quantitySold || 0).toString(),
              (item.revenue || 0).toFixed(2),
              (item.cogs || 0).toFixed(2),
              (item.margin || 0).toFixed(2)
            ];
            ppX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, ppX, doc.y, { width: ppColWidths[i] });
              ppX += ppColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('Product Performance data not available.', { align: 'center' });
        }
        break;
      }

      case 'customer-summary': {
        const csCompany = await Company.findById(companyId);
        doc.fontSize(16).text(csCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${csCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('CUSTOMER SUMMARY REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        // Use generateTopCustomersReport for customer summary
        const csData = await reportGeneratorService.generateTopCustomersReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (csData && csData.data) {
          const csHeaders = ['Code', 'Client Name', 'Invoices', 'Total Sales', 'Balance'];
          const csColWidths = [50, 140, 50, 70, 60];
          doc.fontSize(9).font('Helvetica-Bold');
          let csX = 30;
          csHeaders.forEach((header, i) => {
            doc.text(header, csX, doc.y, { width: csColWidths[i] });
            csX += csColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          csData.data.slice(0, 50).forEach(item => {
            const rowData = [
              item.client?.code || 'N/A',
              (item.client?.name || 'Unknown').substring(0, 30),
              (item.invoiceCount || 0).toString(),
              (item.totalSales || 0).toFixed(2),
              (item.balance || 0).toFixed(2)
            ];
            csX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, csX, doc.y, { width: csColWidths[i] });
              csX += csColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('Customer Summary data not available.', { align: 'center' });
        }
        break;
      }

      case 'supplier-summary': {
        const ssCompany = await Company.findById(companyId);
        doc.fontSize(16).text(ssCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${ssCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('SUPPLIER SUMMARY REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        // Use generateTopSuppliersByPurchaseReport for supplier summary
        const ssData = await reportGeneratorService.generateTopSuppliersByPurchaseReport(companyId, reportPeriodStart, reportPeriodEnd);
        if (ssData && ssData.data) {
          const ssHeaders = ['Code', 'Supplier Name', 'Purchases', 'Quantity', 'Total Cost'];
          const ssColWidths = [50, 140, 50, 60, 70];
          doc.fontSize(9).font('Helvetica-Bold');
          let ssX = 30;
          ssHeaders.forEach((header, i) => {
            doc.text(header, ssX, doc.y, { width: ssColWidths[i] });
            ssX += ssColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          ssData.data.slice(0, 50).forEach(item => {
            const rowData = [
              item._id?.code || 'N/A',
              (item._id?.name || 'Unknown').substring(0, 30),
              (item.totalPurchases || 0).toString(),
              (item.totalQuantity || 0).toString(),
              (item.totalCost || 0).toFixed(2)
            ];
            ssX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, ssX, doc.y, { width: ssColWidths[i] });
              ssX += ssColWidths[i];
            });
            doc.moveDown(0.3);
          });
        } else {
          doc.fontSize(10).text('Supplier Summary data not available.', { align: 'center' });
        }
        break;
      }

      case 'purchases': {
        const purchCompany = await Company.findById(companyId);
        doc.fontSize(16).text(purchCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${purchCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('PURCHASES REPORT', { align: 'center', underline: true });
        doc.fontSize(9).text(`Period: ${reportPeriodStart.toLocaleDateString()} - ${reportPeriodEnd.toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);
        
        const purchData = await Purchase.find({
          company: companyId,
          purchaseDate: { $gte: reportPeriodStart, $lte: reportPeriodEnd }
        }).populate('supplier', 'name code').sort({ purchaseDate: -1 }).limit(100);
        
        if (purchData && purchData.length > 0) {
          const purchHeaders = ['PO #', 'Date', 'Supplier', 'Total', 'Paid', 'Balance', 'Status'];
          const purchColWidths = [50, 40, 100, 60, 50, 50, 50];
          doc.fontSize(9).font('Helvetica-Bold');
          let purchX = 30;
          purchHeaders.forEach((header, i) => {
            doc.text(header, purchX, doc.y, { width: purchColWidths[i] });
            purchX += purchColWidths[i];
          });
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(8);
          
          let totalPurch = 0;
          purchData.forEach(p => {
            totalPurch += p.grandTotal || 0;
            const rowData = [
              p.purchaseNumber || 'N/A',
              p.purchaseDate ? new Date(p.purchaseDate).toLocaleDateString() : 'N/A',
              (p.supplier?.name || '-').substring(0, 20),
              (p.grandTotal || 0).toFixed(2),
              (p.amountPaid || 0).toFixed(2),
              (p.balance || 0).toFixed(2),
              p.status || '-'
            ];
            purchX = 30;
            rowData.forEach((cell, i) => {
              doc.text(cell, purchX, doc.y, { width: purchColWidths[i] });
              purchX += purchColWidths[i];
            });
            doc.moveDown(0.3);
          });
          doc.moveDown(1);
          doc.fontSize(10).font('Helvetica-Bold');
          doc.text(`Total Purchases: ${totalPurch.toFixed(2)}`, 30);
        } else {
          doc.fontSize(10).text('No purchase data available.', { align: 'center' });
        }
        break;
      }

      case 'aging': {
        const agingCompany = await Company.findById(companyId);
        doc.fontSize(16).text(agingCompany?.name || 'Company', { align: 'center' });
        doc.fontSize(10).text(`TIN: ${agingCompany?.tin || 'N/A'}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).text('AGING REPORT', { align: 'center', underline: true });
        doc.moveDown(2);
        
        const agingData = await reportGeneratorService.generateInvoiceAgingReport(companyId);
        if (agingData && agingData.buckets) {
          doc.fontSize(11).font('Helvetica-Bold').text('RECEIVABLES AGING', 50);
          doc.font('Helvetica').fontSize(10);
          
          const buckets = agingData.buckets;
          const bucketLabels = ['Current', '1-30 Days', '31-60 Days', '61-90 Days', '90+ Days'];
          const bucketKeys = ['current', '1-30', '31-60', '61-90', '90+'];
          
          bucketKeys.forEach((key, idx) => {
            const items = buckets[key] || [];
            const total = items.reduce((sum, i) => sum + (i.balance || 0), 0);
            doc.text(`${bucketLabels[idx]}: ${items.length} invoices, Total: ${total.toFixed(2)}`, 70);
          });
        } else {
          doc.fontSize(10).text('Aging data not available.', { align: 'center' });
        }
        break;
      }

      default:
        doc.fontSize(12).text('Invalid report type', { align: 'center' });
    }

    doc.end();
  } catch (error) {
    next(error);
  }
};

// @desc    Get comprehensive Profit & Loss Statement (Full P&L)
// @route   GET /api/reports/profit-and-loss-full
// @access  Private
// 
// Comprehensive P&L with all components:
// REVENUE: Sales Revenue (ex VAT) - Sales Returns - Discounts = Net Revenue
// COGS: Opening Stock + Purchases - Purchase Returns - Closing Stock = Total COGS
// GROSS PROFIT: Net Revenue - Total COGS
// OPERATING EXPENSES: Manual entries from Expense module + Depreciation
// OPERATING PROFIT (EBIT): Gross Profit - Operating Expenses
// OTHER INCOME/EXPENSES: Interest Income + Other Income - Interest Expense - Other Expense
// PROFIT BEFORE TAX: EBIT + Net Other Income
// TAX: Corporate Income Tax (30%)
// NET PROFIT: PBT - Corporate Tax
// 
exports.getProfitAndLossFull = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, previousPeriodStart, previousPeriodEnd } = req.query;
    
    // Set default period to current quarter if not provided
    const now = new Date();
    const periodStart = startDate ? new Date(startDate) : new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const periodEnd = endDate ? new Date(endDate) : new Date();
    
    // Get company info
    const company = await Company.findById(companyId);
    const companyName = company?.name || 'N/A';
    const companyTin = company?.tin || 'N/A';
    
    // =============================================
    // REVENUE SECTION
    // =============================================
    
    // Sales Revenue (excluding VAT) - Cash-basis: revenue recognised when payment is received.
    // Use paidDate so invoices issued before the period but paid within it are correctly included
    const salesInvoiceMatch = { 
      status: 'paid', 
      company: companyId,
      paidDate: { $gte: periodStart, $lte: periodEnd }
    };
    
    const paidInvoices = await Invoice.find(salesInvoiceMatch).populate('items.product', 'averageCost');
    
    // Sales Revenue (ex. VAT) = Gross sales before discounts (subtotal is pre-discount, pre-tax)
    const salesRevenueExVAT = paidInvoices.reduce((sum, inv) => {
      return sum + (inv.subtotal || 0);
    }, 0);
    
    // Sales Returns (Credit Notes issued) in period
    const creditNoteMatch = {
      company: companyId,
      status: { $in: ['issued', 'applied', 'refunded', 'partially_refunded'] },
      issueDate: { $gte: periodStart, $lte: periodEnd }
    };
    
    const creditNotes = await CreditNote.find(creditNoteMatch);
    const salesReturns = creditNotes.reduce((sum, cn) => sum + (cn.subtotal || 0), 0);
    
    // Discounts Given - from paid invoices
    const discountsGiven = paidInvoices.reduce((sum, inv) => sum + (inv.totalDiscount || 0), 0);
    
    // NET REVENUE = Sales Revenue - Sales Returns - Discounts
    const netRevenue = salesRevenueExVAT - salesReturns - discountsGiven;
    
    // =============================================
    // COST OF GOODS SOLD (COGS) SECTION
    // =============================================
    
    const products = await Product.find({ company: companyId, isArchived: false });
    
    // Opening Stock: Previous period's closing stock
    // If previous period dates provided, calculate from that; otherwise use 0
    let openingStockValue = 0;
    if (previousPeriodStart && previousPeriodEnd) {
      const prevStart = new Date(previousPeriodStart);
      const prevEnd = new Date(previousPeriodEnd);
      
      // Get purchases in previous period for COGS calculation
      const prevPurchases = await Purchase.find({
        company: companyId,
        status: { $in: ['received', 'paid'] },
        purchaseDate: { $gte: prevStart, $lte: prevEnd }
      });
      const prevPurchasesExVAT = prevPurchases.reduce((sum, p) => sum + (p.subtotal || 0) - (p.totalDiscount || 0), 0);
      
      // Use simple approach: previous period purchases = opening stock for this period
      openingStockValue = prevPurchasesExVAT;
    }
    
    // Purchases (ex. VAT) - from RECEIVED/PAID purchases in period
    const purchaseMatch = {
      company: companyId,
      status: { $in: ['received', 'paid'] },
      purchaseDate: { $gte: periodStart, $lte: periodEnd }
    };
    
    const purchases = await Purchase.find(purchaseMatch);
    const purchasesExVAT = purchases.reduce((sum, p) => {
      return sum + (p.subtotal || 0) - (p.totalDiscount || 0);
    }, 0);
    
    // Purchase Returns - from PurchaseReturn model
    // Get approved/refunded purchase returns in the period
    const purchaseReturnMatch = {
      company: companyId,
      status: { $in: ['approved', 'refunded'] },
      returnDate: { $gte: periodStart, $lte: periodEnd }
    };
    
    const purchaseReturnsData = await PurchaseReturn.aggregate([
      { $match: purchaseReturnMatch },
      {
        $group: {
          _id: null,
          total: { $sum: '$grandTotal' },
          subtotal: { $sum: '$subtotal' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    const purchaseReturns = purchaseReturnsData[0]?.subtotal || 0; // Use subtotal (excl tax) for COGS
    const purchaseReturnsCount = purchaseReturnsData[0]?.count || 0;
    
    console.log('P&L Full - Purchase Returns:', purchaseReturns, 'count:', purchaseReturnsCount);
    
    // Closing Stock Value (current inventory)
    const closingStockValue = products.reduce((sum, product) => {
      return sum + (product.currentStock * product.averageCost);
    }, 0);
    
    // TOTAL COGS = Opening Stock + Purchases - Purchase Returns - Closing Stock
    const totalCOGS = openingStockValue + purchasesExVAT - purchaseReturns - closingStockValue;
    
    // =============================================
    // GROSS PROFIT
    // =============================================
    const grossProfit = netRevenue - totalCOGS;
    const grossMarginPercent = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;
    
    // =============================================
    // OPERATING EXPENSES (from Expense module)
    // =============================================
    
    // Get manual expenses from Expense model - query ALL expenses (no date filter)
    // This ensures expenses show up in P&L regardless of when they were recorded
    // Users can filter by date in the Expenses page
    console.log('P&L Full - Querying ALL expenses for company:', companyId);
    const expenseSummary = await Expense.aggregate([
      {
        $match: {
          company: companyId,
          status: { $ne: 'cancelled' }
          // No date filter - show all expenses
        }
      },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$amount' }
        }
      }
    ]);
    
    console.log('P&L Full - Expense summary result:', expenseSummary);
    
    // Transform expense summary
    const expenseData = {};
    expenseSummary.forEach(item => {
      expenseData[item._id] = item.total;
    });
    
    const salariesWages = expenseData['salaries_wages'] || 0;
    const rent = expenseData['rent'] || 0;
    const utilities = expenseData['utilities'] || 0;
    const transportDelivery = expenseData['transport_delivery'] || 0;
    const marketingAdvertising = expenseData['marketing_advertising'] || 0;
    const otherExpenses = expenseData['other_expense'] || 0;
    
    // Depreciation — period-aware, starts from 1st of purchase month
    const fixedAssets = await FixedAsset.find({ company: companyId, status: 'active' });
    const depreciationExpense = calculateDepreciationForPeriod(fixedAssets, periodStart, periodEnd);

    // Per-asset breakdown so users can trace exactly which asset contributes what amount
    const depreciationBreakdown = fixedAssets
      .map(a => ({
        name: a.name,
        assetCode: a.assetCode || null,
        category: a.category,
        purchaseCost: a.purchaseCost,
        usefulLifeYears: a.usefulLifeYears,
        depreciationMethod: a.depreciationMethod,
        annualDepreciation: Math.round((a.annualDepreciation || 0) * 100) / 100,
        periodDepreciation: Math.round(calculateDepreciationForPeriod([a], periodStart, periodEnd) * 100) / 100
      }))
      .filter(a => a.periodDepreciation > 0);
    
    const totalOperatingExpenses = 
      salariesWages + 
      rent + 
      utilities + 
      transportDelivery + 
      marketingAdvertising + 
      depreciationExpense + 
      otherExpenses;
    
    // =============================================
    // OPERATING PROFIT (EBIT)
    // =============================================
    const operatingProfit = grossProfit - totalOperatingExpenses;
    const operatingMarginPercent = netRevenue > 0 ? (operatingProfit / netRevenue) * 100 : 0;
    
    // =============================================
    // OTHER INCOME / EXPENSES
    // =============================================
    
    // Interest Income (from Expense module)
    const interestIncome = expenseData['interest_income'] || 0;
    
    // Interest Expense (from Loans)
    const loanMatch = {
      company: companyId,
      status: 'active',
      startDate: { $lte: periodEnd },
      $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: periodStart } }]
    };
    const activeLoans = await Loan.find(loanMatch);

    // Calculate interest expense for the period (prorated, on outstanding balance)
    const interestExpense = calculateLoanInterest(activeLoans, periodStart, periodEnd);
    
    // Other Income (from Expense module)
    const otherIncome = expenseData['other_income'] || 0;
    
    // Other Expense (from Expense module - treated separately in P&L)
    const otherExpenseFromModule = expenseData['other_expense_income'] || 0;
    
    const netOtherIncome = interestIncome + otherIncome - interestExpense - otherExpenseFromModule;
    
    // =============================================
    // PROFIT BEFORE TAX (PBT)
    // =============================================
    const profitBeforeTax = operatingProfit + netOtherIncome;
    
    // =============================================
    // TAX
    // =============================================
    
    // VAT Info (Output VAT - Net Input VAT) - For information only, not an expense
    const outputVAT = paidInvoices.reduce((sum, inv) => sum + (inv.totalTax || 0), 0);
    const inputVAT = purchases.reduce((sum, p) => sum + (p.totalTax || 0), 0);
    // Purchase Return VAT reduces the claimable Input VAT (VAT on returned goods is no longer claimable)
    // Uses a $lookup fallback: if totalTax=0 (old records), compute proportionally from linked purchase
    const purchaseReturnVATFull = await PurchaseReturn.aggregate([
      {
        $match: {
          company: companyId,
          status: { $in: ['approved', 'refunded', 'partially_refunded'] },
          returnDate: { $gte: periodStart, $lte: periodEnd }
        }
      },
      { $lookup: { from: 'purchases', localField: 'purchase', foreignField: '_id', as: 'linkedPurchase' } },
      { $addFields: { linkedPurchase: { $arrayElemAt: ['$linkedPurchase', 0] } } },
      {
        $addFields: {
          effectiveTax: {
            $cond: {
              if: { $gt: ['$totalTax', 0] },
              then: '$totalTax',
              else: {
                $cond: {
                  if: { $and: [
                    { $gt: [{ $ifNull: ['$linkedPurchase.subtotal', 0] }, 0] },
                    { $gt: [{ $ifNull: ['$linkedPurchase.totalTax', 0] }, 0] }
                  ]},
                  then: { $multiply: [{ $divide: ['$subtotal', '$linkedPurchase.subtotal'] }, '$linkedPurchase.totalTax'] },
                  else: 0
                }
              }
            }
          }
        }
      },
      { $group: { _id: null, totalTax: { $sum: '$effectiveTax' } } }
    ]);
    const inputVATReturn = purchaseReturnVATFull[0]?.totalTax || 0;
    const netInputVAT = inputVAT - inputVATReturn;
    const netVAT = outputVAT - netInputVAT; // Positive = VAT payable, Negative = VAT receivable
    
    // Corporate Income Tax (30% of Profit Before Tax)
    const corporateTaxRate = 0.30;
    const corporateIncomeTax = Math.max(0, profitBeforeTax * corporateTaxRate);
    
    const totalTax = corporateIncomeTax;
    
    // =============================================
    // NET PROFIT (AFTER TAX)
    // =============================================
    const netProfit = profitBeforeTax - totalTax;
    const netMarginPercent = netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0;
    
    // =============================================
    // RESPONSE
    // =============================================
    res.json({
      success: true,
      data: {
        // Header
        company: {
          name: companyName,
          tin: companyTin
        },
        period: {
          start: periodStart,
          end: periodEnd,
          formatted: `${periodStart.toLocaleDateString('en-GB')} - ${periodEnd.toLocaleDateString('en-GB')}`
        },
        
        // REVENUE
        revenue: {
          salesRevenueExVAT: Math.round(salesRevenueExVAT * 100) / 100,
          salesReturns: Math.round(salesReturns * 100) / 100,
          discountsGiven: Math.round(discountsGiven * 100) / 100,
          netRevenue: Math.round(netRevenue * 100) / 100
        },
        
        // COST OF GOODS SOLD
        cogs: {
          openingStockValue: Math.round(openingStockValue * 100) / 100,
          purchasesExVAT: Math.round(purchasesExVAT * 100) / 100,
          purchaseReturns: Math.round(purchaseReturns * 100) / 100,
          closingStockValue: Math.round(closingStockValue * 100) / 100,
          totalCOGS: Math.round(totalCOGS * 100) / 100
        },
        
        // GROSS PROFIT
        grossProfit: {
          amount: Math.round(grossProfit * 100) / 100,
          marginPercent: Math.round(grossMarginPercent * 100) / 100
        },
        
        // OPERATING EXPENSES
        operatingExpenses: {
          salariesAndWages: Math.round(salariesWages * 100) / 100,
          rent: Math.round(rent * 100) / 100,
          utilities: Math.round(utilities * 100) / 100,
          transportAndDelivery: Math.round(transportDelivery * 100) / 100,
          marketingAndAdvertising: Math.round(marketingAdvertising * 100) / 100,
          depreciation: Math.round(depreciationExpense * 100) / 100,
          otherExpenses: Math.round(otherExpenses * 100) / 100,
          total: Math.round(totalOperatingExpenses * 100) / 100
        },
        
        // OPERATING PROFIT (EBIT)
        operatingProfit: {
          amount: Math.round(operatingProfit * 100) / 100,
          marginPercent: Math.round(operatingMarginPercent * 100) / 100
        },
        
        // OTHER INCOME / EXPENSES
        otherIncomeExpenses: {
          interestIncome: Math.round(interestIncome * 100) / 100,
          interestExpense: Math.round(interestExpense * 100) / 100,
          otherIncome: Math.round(otherIncome * 100) / 100,
          otherExpense: Math.round(otherExpenseFromModule * 100) / 100,
          netOtherIncome: Math.round(netOtherIncome * 100) / 100
        },
        
        // PROFIT BEFORE TAX
        profitBeforeTax: {
          amount: Math.round(profitBeforeTax * 100) / 100
        },
        
        // TAX
        tax: {
          vatInfo: {
            outputVAT: Math.round(outputVAT * 100) / 100,
            inputVAT: Math.round(inputVAT * 100) / 100,
            inputVATReturn: Math.round(inputVATReturn * 100) / 100,
            netInputVAT: Math.round(netInputVAT * 100) / 100,
            netVAT: Math.round(netVAT * 100) / 100
          },
          corporateIncomeTax: Math.round(corporateIncomeTax * 100) / 100,
          corporateTaxRate: corporateTaxRate * 100,
          totalTax: Math.round(totalTax * 100) / 100
        },
        
        // NET PROFIT
        netProfit: {
          amount: Math.round(netProfit * 100) / 100,
          marginPercent: Math.round(netMarginPercent * 100) / 100
        },
        
        // Summary for Balance Sheet integration
        balanceSheetFlow: {
          currentPeriodProfit: Math.round(netProfit * 100) / 100,
          flowsToEquity: true
        },
        
        // Additional details (including per-asset depreciation so UI can show the source)
        details: {
          paidInvoicesCount: paidInvoices.length,
          creditNotesCount: creditNotes.length,
          purchasesCount: purchases.length,
          purchaseReturnsCount: purchaseReturnsCount,
          fixedAssetsCount: fixedAssets.length,
          activeLoansCount: activeLoans.length,
          productsCount: products.length,
          openingStockNote: previousPeriodStart ? 'Calculated from previous period' : 'Default value (0)',
          depreciationBreakdown  // per-asset: [{name, category, purchaseCost, annualDepreciation, periodDepreciation}]
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get Balance Sheet report
// @route   GET /api/reports/balance-sheet
// @access  Private
exports.getBalanceSheet = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { asOfDate } = req.query;
    
    // Use provided date or current date
    const reportDate = asOfDate ? new Date(asOfDate) : new Date();

    // NO CACHING for Balance Sheet - profit calculation depends on dynamic paidDate data
    // and must always reflect current period profit (YTD)
    
    // Run parallel aggregations for better performance
    const [
      invoiceData,
      purchaseData,
      inventoryData,
      fixedAssetsData,
      loansData,
      company
    ] = await Promise.all([
      Invoice.aggregate([
        { $match: { company: companyId } },
        { $facet: {
          payments: [
            { $unwind: '$payments' },
            { $group: { _id: null, total: { $sum: '$payments.amount' } } }
          ],
          receivables: [
            { $match: { status: { $in: ['draft', 'confirmed', 'partial'] } } },
            { $group: { _id: null, total: { $sum: '$balance' } } }
          ],
          outputVAT: [
            { $match: { status: { $in: ['paid', 'partial', 'confirmed'] } } },
            { $group: { _id: null, total: { $sum: '$totalTax' } } }
          ]
        }}
      ]),
      Purchase.aggregate([
        { $match: { company: companyId } },
        { $facet: {
          payments: [
            { $unwind: '$payments' },
            { $group: { _id: null, total: { $sum: '$payments.amount' } } }
          ],
          payables: [
            { $match: { status: { $in: ['draft', 'ordered', 'received', 'partial'] } } },
            { $group: { _id: null, total: { $sum: '$balance' } } }
          ],
          inputVAT: [
            { $match: { status: { $in: ['received', 'partial', 'paid'] } } },
            { $group: { _id: null, total: { $sum: '$totalTax' } } }
          ]
        }}
      ]),
      Product.aggregate([
        { $match: { company: companyId, isArchived: false } },
        { $project: { stockValue: { $multiply: ['$currentStock', '$averageCost'] } } },
        { $group: { _id: null, totalValue: { $sum: '$stockValue' } } }
      ]),
      // Use .find() so Mongoose virtuals (accumulatedDepreciation, netBookValue) are available.
      // Aggregate cannot access virtuals — they are computed in JS, not stored in MongoDB.
      FixedAsset.find({ company: companyId, status: 'active' }),
      Loan.aggregate([
        { $match: { company: companyId, status: 'active' } },
        { $group: {
          _id: '$loanType',
          totalBalance: { $sum: { $subtract: ['$originalAmount', '$amountPaid'] } }
        }}
      ]),
      Company.findById(companyId).lean()
    ]);

    // Extract invoice data
    const invoiceResult = invoiceData[0] || {};
    const totalInflows = invoiceResult.payments?.[0]?.total || 0;
    const accountsReceivable = invoiceResult.receivables?.[0]?.total || 0;
    const outputVAT = invoiceResult.outputVAT?.[0]?.total || 0;
    
    // Get credit notes issued in the period to reduce Cash & Bank
    // Credit notes reduce the cash balance because money is being returned to customers
    // Use same date range as P&L (current quarter) for consistency
    // Note: defaultQuarterStart is declared later in this function
    const creditNoteDateStart = new Date(reportDate.getFullYear(), Math.floor(reportDate.getMonth() / 3) * 3, 1);
    const creditNoteDateEnd = reportDate;
    
    // DEBUG: Log the date range being used
    console.log('Balance Sheet - Credit Note Date Range:', creditNoteDateStart, 'to', creditNoteDateEnd);
    console.log('Balance Sheet - Company ID being used:', companyId);
    
    // Use expanded status filter - include all non-cancelled statuses
    // Also remove date filter temporarily to debug why no credit notes are found
    const creditNoteData = await CreditNote.aggregate([
      { $match: { 
        company: companyId,
        status: { $in: ['draft', 'issued', 'applied', 'refunded', 'partially_refunded'] }
      }},
      { $group: { _id: null, total: { $sum: '$grandTotal' }, totalTax: { $sum: '$totalTax' } } }
    ]);
    
    // DEBUG: Log ALL credit notes found for this company to see what's in DB
    const allCreditNotes = await CreditNote.find({ company: companyId });
    console.log('Balance Sheet - All Credit Notes for company:', allCreditNotes.length, allCreditNotes.map(cn => ({ number: cn.creditNoteNumber, status: cn.status, total: cn.grandTotal })));
    
    // DEBUG: Log the credit note data found
    console.log('Balance Sheet - Credit Note Data (expanded):', creditNoteData);
    
    const totalCreditNoteAmount = creditNoteData[0]?.total || 0;
    const totalCreditNoteTax = creditNoteData[0]?.totalTax || 0;
    
    // DEBUG: Log the totals
    console.log('Balance Sheet - Total Credit Note Amount:', totalCreditNoteAmount, 'Total Tax:', totalCreditNoteTax);
    
    // Net cash inflows = payments received - credit notes issued (money returned)
    const netCashInflows = Math.max(0, totalInflows - totalCreditNoteAmount);

    // Extract purchase data
    const purchaseResult = purchaseData[0] || {};
    const totalOutflows = purchaseResult.payments?.[0]?.total || 0;
    const accountsPayable = purchaseResult.payables?.[0]?.total || 0;
    const inputVAT = purchaseResult.inputVAT?.[0]?.total || 0;

    // Purchase Return VAT - reduces the claimable Input VAT on the Balance Sheet
    // Uses a $lookup fallback: if totalTax=0 (old records), compute proportionally from linked purchase
    const purchaseReturnVATAggBS = await PurchaseReturn.aggregate([
      {
        $match: {
          company: companyId,
          status: { $in: ['approved', 'refunded', 'partially_refunded'] }
        }
      },
      { $lookup: { from: 'purchases', localField: 'purchase', foreignField: '_id', as: 'linkedPurchase' } },
      { $addFields: { linkedPurchase: { $arrayElemAt: ['$linkedPurchase', 0] } } },
      {
        $addFields: {
          effectiveTax: {
            $cond: {
              if: { $gt: ['$totalTax', 0] },
              then: '$totalTax',
              else: {
                $cond: {
                  if: { $and: [
                    { $gt: [{ $ifNull: ['$linkedPurchase.subtotal', 0] }, 0] },
                    { $gt: [{ $ifNull: ['$linkedPurchase.totalTax', 0] }, 0] }
                  ]},
                  then: { $multiply: [{ $divide: ['$subtotal', '$linkedPurchase.subtotal'] }, '$linkedPurchase.totalTax'] },
                  else: 0
                }
              }
            }
          }
        }
      },
      { $group: { _id: null, totalTax: { $sum: '$effectiveTax' } } }
    ]);
    const inputVATReturn = purchaseReturnVATAggBS[0]?.totalTax || 0;
    const netInputVAT = inputVAT - inputVATReturn;

    // Extract inventory value
    const inventoryValue = inventoryData[0]?.totalValue || 0;

    // Extract fixed assets — categorized by type.
    // fixedAssetsData is now an array of documents (with virtuals) from FixedAsset.find().
    // Gross cost is stored per category; accumulated depreciation is the running total (virtual).
    // Balance Sheet displays: Gross Assets, Less: Accumulated Depreciation, = Net Book Value.
    let equipmentValue = 0;
    let furnitureValue = 0;
    let vehiclesValue = 0;
    let buildingsValue = 0;
    let computersValue = 0;
    let machineryValue = 0;
    let otherAssetsValue = 0;
    let totalDepreciation = 0; // accumulated depreciation across all fixed assets
    fixedAssetsData.forEach(asset => {
      totalDepreciation += asset.accumulatedDepreciation || 0;
      switch (asset.category) {
        case 'equipment': equipmentValue += asset.purchaseCost || 0; break;
        case 'furniture': furnitureValue += asset.purchaseCost || 0; break;
        case 'vehicles':  vehiclesValue  += asset.purchaseCost || 0; break;
        case 'buildings': buildingsValue += asset.purchaseCost || 0; break;
        case 'computers': computersValue += asset.purchaseCost || 0; break;
        case 'machinery': machineryValue += asset.purchaseCost || 0; break;
        case 'other':     otherAssetsValue += asset.purchaseCost || 0; break;
        default:          equipmentValue  += asset.purchaseCost || 0;
      }
    });

    // Extract loans
    let shortTermLoans = 0;
    let longTermLoans = 0;
    loansData.forEach(loan => {
      if (loan._id === 'short-term') shortTermLoans = loan.totalBalance || 0;
      else if (loan._id === 'long-term') longTermLoans = loan.totalBalance || 0;
    });

    // ── ACCRUED INTEREST (ALL active loans — short-term + long-term) ────────
    // Total interest for the full loan term is recognised as a current liability.
    //   Simple interest  : Total = P × (annualRate / 12 / 100) × durationMonths
    //   Compound / EMI   : Total = EMI × n  −  P
    const allActiveLoans = await Loan.find({ company: companyId, status: 'active' });
    const accruedInterest = allActiveLoans.reduce((sum, loan) => {
      const months = loan.durationMonths || 0;
      const P      = loan.originalAmount || 0;
      const rate   = loan.interestRate   || 0;
      if (!months || !P || !rate) return sum;

      if (loan.interestMethod === 'compound') {
        const r   = rate / 100 / 12;
        const emi = r > 0 ? (P * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1) : P / months;
        const totalInterest = emi * months - P;
        return sum + Math.max(0, totalInterest);
      } else {
        // Simple interest — full term, recognised immediately
        const totalInterest = (P * rate / 100 / 12) * months;
        return sum + totalInterest;
      }
    }, 0);

    // Calculate derived values
    // Get actual bank account balances from BankAccount model
    // This pulls from the real bank account balances updated via CSV import and manual transactions
    let cashAndBank = 0;
    let bankAccountsData = null;
    try {
      bankAccountsData = await BankAccount.getTotalCashPosition(companyId);
      cashAndBank = bankAccountsData.total || 0;
    } catch (bankError) {
      console.error('Error fetching bank accounts for Balance Sheet:', bankError);
      // Fall back to calculated cash flow if bank accounts fail
      cashAndBank = netCashInflows || 0;
    }
    
    // If no bank accounts exist (total is 0), fall back to calculated cash flow
    // This handles the case where bank accounts haven't been set up yet
    if (cashAndBank === 0 && (totalInflows > 0 || totalOutflows > 0)) {
      cashAndBank = netCashInflows || 0;
    }
    // Get Prepaid Expenses from Company settings (manual entry)
    const prepaidExpenses = company?.assets?.prepaidExpenses || 0;
    // VAT Receivable = Net Input VAT - Output VAT + Credit Note VAT
    // Net Input VAT = Input VAT - VAT on purchase returns (VAT on returned goods is no longer claimable)
    const vatReceivable = Math.max(0, netInputVAT - outputVAT + totalCreditNoteTax);
    const vatPayable = Math.max(0, outputVAT - netInputVAT - totalCreditNoteTax);

    const totalCurrentAssets = cashAndBank + accountsReceivable + inventoryValue + prepaidExpenses + vatReceivable;
    const totalFixedAssets = equipmentValue + furnitureValue + vehiclesValue + buildingsValue + computersValue + machineryValue + otherAssetsValue;
    // Net book value = gross cost − accumulated depreciation (Balance Sheet standard)
    const totalNonCurrentAssets = Math.max(0, totalFixedAssets - totalDepreciation);
    const totalAssets = totalCurrentAssets + totalNonCurrentAssets;

    // ── CURRENT PERIOD PROFIT (pulled from P&L) ─────────────────────────────
    // Uses the EXACT same formula as getProfitAndLossFull so the Balance Sheet
    // Equity → Current Period Profit always equals the P&L NET PROFIT (AFTER TAX).
    // Default period: Jan 1 of asOfDate year → end-of-day asOfDate (fiscal year to date).
    // The user can override by passing startDate/endDate query params — set these to the
    // same dates as the P&L report for an exact match.
    const { startDate: bsStartDate, endDate: bsEndDate } = req.query || {};

    // Default: fiscal year start (Jan 1) of the asOfDate year
    const fiscalYearStart = new Date(reportDate.getFullYear(), 0, 1);
    const periodStart = bsStartDate ? new Date(bsStartDate) : fiscalYearStart;

    // periodEnd: end-of-day on asOfDate so all transactions on that calendar day are included
    let periodEnd;
    if (bsEndDate) {
      periodEnd = new Date(bsEndDate);
      periodEnd.setHours(23, 59, 59, 999);
    } else {
      periodEnd = new Date(reportDate);
      periodEnd.setHours(23, 59, 59, 999);
    }

    const {
      netProfit,
      corporateIncomeTax: incomeTaxPayable,
      netRevenue: plNetRevenue,
      invoicesConsidered: plInvoicesConsidered
    } = await computeCurrentPeriodProfit(companyId, periodStart, periodEnd);

    const pl_debug = {
      invoicesConsidered: plInvoicesConsidered,
      paymentsMatchedCount: 0,
      plNetProfit: netProfit,
      plRevenue: plNetRevenue
    };

    // Get custom liabilities from Company
    const companyCurrentLiabilities = company?.liabilities?.currentLiabilities || [];
    const companyNonCurrentLiabilities = company?.liabilities?.nonCurrentLiabilities || [];
    
    // Get Accrued Expenses from Company settings (manual entry - current liability)
    const accruedExpenses = company?.liabilities?.accruedExpenses || 0;
    
    // Get Other Long-term Liabilities from Company settings (manual entry - non-current liability)
    const otherLongTermLiabilities = company?.liabilities?.otherLongTermLiabilities || 0;
    
    // Sum up custom current liabilities
    const customCurrentLiabilitiesTotal = companyCurrentLiabilities.reduce((sum, liab) => sum + (liab.amount || 0), 0);
    const customCurrentLiabilitiesList = companyCurrentLiabilities.map(liab => ({
      name: liab.name,
      amount: Math.round((liab.amount || 0) * 100) / 100,
      description: liab.description
    }));
    
    // Sum up custom non-current liabilities
    const customNonCurrentLiabilitiesTotal = companyNonCurrentLiabilities.reduce((sum, liab) => sum + (liab.amount || 0), 0);
    const customNonCurrentLiabilitiesList = companyNonCurrentLiabilities.map(liab => ({
      name: liab.name,
      amount: Math.round((liab.amount || 0) * 100) / 100,
      description: liab.description,
      dueDate: liab.dueDate
    }));

    // Compute liabilities totals including Income Tax Payable (current period corporate tax),
    // Accrued Expenses, Accrued Interest (simple interest loans) and custom liabilities
    const totalCurrentLiabilities = accountsPayable + vatPayable + shortTermLoans + incomeTaxPayable + customCurrentLiabilitiesTotal + accruedExpenses + accruedInterest;
    const totalNonCurrentLiabilities = longTermLoans + customNonCurrentLiabilitiesTotal + otherLongTermLiabilities;
    const totalLiabilities = totalCurrentLiabilities + totalNonCurrentLiabilities;

    // Share Capital & Retained Earnings from Company
    // Support both equity object and direct company fields (for backward compatibility)
    const shareCapital = company?.equity?.shareCapital || company?.shareCapital || 0;
    const ownerCapital = company?.equity?.ownerCapital || company?.ownerCapital || 0;
    const retainedEarnings = company?.equity?.retainedEarnings || company?.retainedEarnings || 0;
    const totalEquity = shareCapital + ownerCapital + retainedEarnings + netProfit;
    const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;
    const isBalanced = Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01;

    res.json({
      success: true,
      data: {
        asOfDate: reportDate,
        company: company ? { name: company.name, tin: company.tin } : { name: 'N/A', tin: 'N/A' },
        assets: {
          currentAssets: {
            cashAndBank: Math.round(cashAndBank * 100) / 100,
            accountsReceivable: Math.round(accountsReceivable * 100) / 100,
            inventoryStockValue: Math.round(inventoryValue * 100) / 100,
            prepaidExpenses: Math.round(prepaidExpenses * 100) / 100,
            vatReceivable: Math.round(vatReceivable * 100) / 100,
            totalCurrentAssets: Math.round(totalCurrentAssets * 100) / 100
          },
          nonCurrentAssets: {
            // Gross cost by category
            equipment: Math.round(equipmentValue * 100) / 100,
            furniture: Math.round(furnitureValue * 100) / 100,
            vehicles:  Math.round(vehiclesValue  * 100) / 100,
            computers: Math.round(computersValue * 100) / 100,
            buildings: Math.round(buildingsValue * 100) / 100,
            machinery: Math.round(machineryValue * 100) / 100,
            other:     Math.round(otherAssetsValue * 100) / 100,
            // Accumulated depreciation (grows every year until fully depreciated)
            lessAccumulatedDepreciation: -Math.round(totalDepreciation * 100) / 100,
            // Legacy field kept for frontend compatibility
            lessDepreciation: -Math.round(totalDepreciation * 100) / 100,
            // Net Book Value = Gross Cost − Accumulated Depreciation
            totalNonCurrentAssets: Math.round(totalNonCurrentAssets * 100) / 100
          },
          totalAssets: Math.round(totalAssets * 100) / 100
        },
        liabilities: {
          currentLiabilities: {
            accountsPayable: Math.round(accountsPayable * 100) / 100,
            vatPayable: Math.round(vatPayable * 100) / 100,
            shortTermLoans: shortTermLoans,
            incomeTaxPayable: Math.round(incomeTaxPayable * 100) / 100,
            accruedExpenses: Math.round(accruedExpenses * 100) / 100,
            accruedInterest: Math.round(accruedInterest * 100) / 100,
            customLiabilities: customCurrentLiabilitiesList,
            totalCurrentLiabilities: Math.round(totalCurrentLiabilities * 100) / 100
          },
          nonCurrentLiabilities: {
            longTermLoans: longTermLoans,
            otherLongTermLiabilities: Math.round(otherLongTermLiabilities * 100) / 100,
            customLiabilities: customNonCurrentLiabilitiesList,
            totalNonCurrentLiabilities: Math.round(totalNonCurrentLiabilities * 100) / 100
          },
          totalLiabilities: Math.round(totalLiabilities * 100) / 100
        },
        equity: {
          shareCapital: shareCapital,
          ownerCapital: ownerCapital,
          retainedEarnings: retainedEarnings,
          currentPeriodProfit: Math.round(netProfit * 100) / 100,
          totalEquity: Math.round(totalEquity * 100) / 100
        },
        totalLiabilitiesAndEquity: Math.round(totalLiabilitiesAndEquity * 100) / 100,
        isBalanced,
        plPeriod: {
          startDate: periodStart.toISOString(),
          endDate: periodEnd.toISOString(),
          formatted: `${periodStart.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} – ${periodEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`
        },
        details: { 
          totalInflows, 
          totalOutflows, 
          outputVAT, 
          inputVAT, 
          inputVATReturn, 
          netInputVAT, 
          incomeTaxPayable, 
          totalCreditNoteAmount, 
          pl: pl_debug,
          bankAccounts: bankAccountsData || { total: 0, byType: {}, accounts: [] }
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get period-based report (daily, weekly, monthly, quarterly, semi-annual, annual)
// @route   GET /api/reports/period/:periodType
// @access  Private
exports.getPeriodReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { periodType } = req.params;
    const { year, periodNumber, reportType = 'profit-loss', clientId, supplierId } = req.query;

    const validPeriodTypes = ['daily', 'weekly', 'monthly', 'quarterly', 'semi-annual', 'annual'];
    if (!validPeriodTypes.includes(periodType)) {
      return res.status(400).json({ 
        success: false, 
        message: `Invalid period type. Valid types: ${validPeriodTypes.join(', ')}` 
      });
    }

    let periodYear = year ? parseInt(year) : new Date().getFullYear();
    let periodNum = periodNumber ? parseInt(periodNumber) : null;

    if (!periodNum) {
      const currentInfo = reportGeneratorService.getCurrentPeriodInfo(periodType);
      periodYear = currentInfo.year;
      periodNum = currentInfo.periodNumber;
    }

    const reportData = await reportGeneratorService.getReportData(
      companyId,
      reportType,
      periodType,
      periodYear,
      periodNum,
      clientId,
      supplierId
    );

    const { startDate, endDate, label } = reportGeneratorService.getPeriodDates(periodType, periodYear, periodNum);

    // Serialize dates to ISO strings for proper JSON serialization
    const serializeDate = (date) => date instanceof Date ? date.toISOString() : date;
    const periodStart = serializeDate(startDate);
    const periodEnd = serializeDate(endDate);

    // Also serialize dates in reportData if they exist
    const serializedReportData = {
      ...reportData,
      periodStart: reportData.periodStart ? serializeDate(reportData.periodStart) : undefined,
      periodEnd: reportData.periodEnd ? serializeDate(reportData.periodEnd) : undefined,
      generatedAt: reportData.generatedAt ? serializeDate(reportData.generatedAt) : undefined
    };

    res.json({
      success: true,
      data: {
        ...serializedReportData,
        period: {
          type: periodType,
          year: periodYear,
          periodNumber: periodNum,
          startDate: periodStart,
          endDate: periodEnd,
          label
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get available periods for a period type
// @route   GET /api/reports/periods/:periodType/available
// @access  Private
exports.getAvailablePeriods = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { periodType } = req.params;
    const ReportSnapshot = require('../models/ReportSnapshot');

    const validPeriodTypes = ['daily', 'weekly', 'monthly', 'quarterly', 'semi-annual', 'annual'];
    if (!validPeriodTypes.includes(periodType)) {
      return res.status(400).json({ 
        success: false, 
        message: `Invalid period type. Valid types: ${validPeriodTypes.join(', ')}` 
      });
    }

    const currentYear = new Date().getFullYear();
    const availablePeriods = [];

    const snapshots = await ReportSnapshot.find({
      company: companyId,
      periodType,
      status: 'completed'
    }).sort({ year: -1, periodNumber: -1 }).limit(50);

    const snapshotMap = new Map();
    snapshots.forEach(s => {
      const key = `${s.year}-${s.periodNumber}`;
      snapshotMap.set(key, { hasSnapshot: true, generatedAt: s.generatedAt });
    });

    let maxPeriods;
    switch (periodType) {
      case 'daily':
        maxPeriods = 7;
        for (let i = 0; i < maxPeriods; i++) {
          const date = new Date();
          date.setDate(date.getDate() - i);
          const year = date.getFullYear();
          const dayOfYear = Math.ceil((date - new Date(year, 0, 0)) / (1000 * 60 * 60 * 24));
          const key = `${year}-${dayOfYear}`;
          const snapshot = snapshotMap.get(key);
          const { startDate, endDate, label } = reportGeneratorService.getPeriodDates(periodType, year, dayOfYear);
          availablePeriods.push({ year, periodNumber: dayOfYear, label, startDate, endDate, hasSnapshot: !!snapshot?.hasSnapshot, isCurrent: i === 0, generatedAt: snapshot?.generatedAt });
        }
        break;
      case 'weekly':
        maxPeriods = 52;
        for (let i = 0; i < Math.min(maxPeriods, 52); i++) {
          const weekNum = Math.ceil((new Date() - new Date(currentYear, 0, 1)) / (1000 * 60 * 60 * 24 * 7)) - i;
          if (weekNum < 1) continue;
          const weekYear = weekNum > 52 ? currentYear - 1 : currentYear;
          const adjustedWeekNum = weekNum > 52 ? weekNum - 52 : weekNum;
          const key = `${weekYear}-${adjustedWeekNum}`;
          const snapshot = snapshotMap.get(key);
          const { startDate, endDate, label } = reportGeneratorService.getPeriodDates(periodType, weekYear, adjustedWeekNum);
          availablePeriods.push({ year: weekYear, periodNumber: adjustedWeekNum, label, startDate, endDate, hasSnapshot: !!snapshot?.hasSnapshot, isCurrent: i === 0, generatedAt: snapshot?.generatedAt });
        }
        break;
      case 'monthly':
        maxPeriods = 24;
        for (let i = 0; i < maxPeriods; i++) {
          const date = new Date();
          date.setMonth(date.getMonth() - i);
          const monthYear = date.getFullYear();
          const monthNum = date.getMonth() + 1;
          const key = `${monthYear}-${monthNum}`;
          const snapshot = snapshotMap.get(key);
          const { startDate, endDate, label } = reportGeneratorService.getPeriodDates(periodType, monthYear, monthNum);
          availablePeriods.push({ year: monthYear, periodNumber: monthNum, label, startDate, endDate, hasSnapshot: !!snapshot?.hasSnapshot, isCurrent: i === 0, generatedAt: snapshot?.generatedAt });
        }
        break;
      case 'quarterly':
        maxPeriods = 8;
        for (let i = 0; i < maxPeriods; i++) {
          const date = new Date();
          date.setMonth(date.getMonth() - (i * 3));
          const qYear = date.getFullYear();
          const qNum = Math.floor(date.getMonth() / 3) + 1;
          const key = `${qYear}-${qNum}`;
          const snapshot = snapshotMap.get(key);
          const { startDate, endDate, label } = reportGeneratorService.getPeriodDates(periodType, qYear, qNum);
          availablePeriods.push({ year: qYear, periodNumber: qNum, label, startDate, endDate, hasSnapshot: !!snapshot?.hasSnapshot, isCurrent: i === 0, generatedAt: snapshot?.generatedAt });
        }
        break;
      case 'semi-annual':
        maxPeriods = 4;
        for (let i = 0; i < maxPeriods; i++) {
          const date = new Date();
          date.setMonth(date.getMonth() - (i * 6));
          const hYear = date.getFullYear();
          const hNum = date.getMonth() < 6 ? 1 : 2;
          const key = `${hYear}-${hNum}`;
          const snapshot = snapshotMap.get(key);
          const { startDate, endDate, label } = reportGeneratorService.getPeriodDates(periodType, hYear, hNum);
          availablePeriods.push({ year: hYear, periodNumber: hNum, label, startDate, endDate, hasSnapshot: !!snapshot?.hasSnapshot, isCurrent: i === 0, generatedAt: snapshot?.generatedAt });
        }
        break;
      case 'annual':
        for (let y = currentYear; y >= currentYear - 10; y--) {
          const key = `${y}-1`;
          const snapshot = snapshotMap.get(key);
          const { startDate, endDate, label } = reportGeneratorService.getPeriodDates(periodType, y, 1);
          availablePeriods.push({ year: y, periodNumber: 1, label, startDate, endDate, hasSnapshot: !!snapshot?.hasSnapshot, isCurrent: y === currentYear, generatedAt: snapshot?.generatedAt });
        }
        break;
    }

    // Convert Date objects to ISO strings for proper JSON serialization
    const serializeDate = (date) => date instanceof Date ? date.toISOString() : date;

    // Build available periods list
    const availablePeriodsWithDates = availablePeriods.map(period => ({
      ...period,
      startDate: serializeDate(period.startDate),
      endDate: serializeDate(period.endDate),
      generatedAt: serializeDate(period.generatedAt)
    }));

    res.json({
      success: true,
      data: {
        periodType,
        currentPeriod: reportGeneratorService.getCurrentPeriodInfo(periodType),
        availablePeriods: availablePeriodsWithDates
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate manual snapshot for a period
// @route   POST /api/reports/generate-snapshot
// @access  Private (admin, manager)
exports.generateManualSnapshot = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { periodType, year, periodNumber, reportTypes } = req.body;
    const userId = req.user._id;

    const validPeriodTypes = ['daily', 'weekly', 'monthly', 'quarterly', 'semi-annual', 'annual'];
    if (!validPeriodTypes.includes(periodType)) {
      return res.status(400).json({ success: false, message: `Invalid period type. Valid types: ${validPeriodTypes.join(', ')}` });
    }

    if (!year || !periodNumber) {
      return res.status(400).json({ success: false, message: 'Year and periodNumber are required' });
    }

    const reportTypesToGenerate = reportTypes || ['profit-loss', 'balance-sheet', 'vat-summary', 'product-performance', 'customer-summary', 'sales-summary', 'purchases', 'stock-valuation', 'suppliers', 'aging', 'cash-flow', 'financial-ratios', 'top-products', 'top-customers', 'client-statement', 'supplier-statement', 'top-clients', 'top-suppliers', 'credit-limit', 'new-clients', 'inactive-clients', 'purchase-by-supplier', 'purchase-by-product', 'purchase-by-category', 'accounts-payable', 'supplier-aging', 'purchase-returns', 'purchase-order-status', 'supplier-performance', 'sales-by-product', 'sales-by-category', 'sales-by-client', 'sales-by-salesperson', 'invoice-aging', 'accounts-receivable', 'credit-notes', 'quotation-conversion', 'recurring-invoice', 'discount-report', 'daily-sales-summary'];
    const results = [];
    
    for (const reportType of reportTypesToGenerate) {
      try {
        const snapshots = await reportGeneratorService.generateAllReports(companyId, periodType, parseInt(year), parseInt(periodNumber), userId);
        results.push({ reportType, success: true, snapshotsGenerated: snapshots.length });
      } catch (error) {
        results.push({ reportType, success: false, error: error.message });
      }
    }

    const allSuccessful = results.every(r => r.success);
    res.json({
      success: allSuccessful,
      message: allSuccessful ? `Successfully generated ${results.length} report snapshots` : 'Some reports failed to generate',
      results
    });
  } catch (error) {
    next(error);
  }
};
  