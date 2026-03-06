const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const StockMovement = require('../models/StockMovement');
const Client = require('../models/Client');
const Supplier = require('../models/Supplier');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const Purchase = require('../models/Purchase');
const Budget = require('../models/Budget');

// @desc    Get stock valuation report
// @route   GET /api/reports/stock-valuation
// @access  Private
exports.getStockValuationReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { categoryId } = req.query;
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

    res.json({
      success: true,
      data: {
        items: report,
        summary: {
          totalProducts: report.length,
          totalValue
        }
      }
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

    res.json({
      success: true,
      data: {
        invoices,
        summary,
        productSales: Object.values(productSales)
      }
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

    res.json({
      success: true,
      count: clientSales.length,
      data: clientSales
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

    const invMatch = { status: { $in: ['paid', 'partial', 'confirmed'] }, company: companyId };
    if (startDate || endDate) {
      invMatch.invoiceDate = {};
      if (startDate) invMatch.invoiceDate.$gte = new Date(startDate);
      if (endDate) invMatch.invoiceDate.$lte = new Date(endDate);
    }

    const invoices = await Invoice.find(invMatch).populate('items.product', 'averageCost');

    const revenue = invoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);

    // Estimate COGS using product averageCost * quantity
    let cogs = 0;
    invoices.forEach(inv => {
      inv.items.forEach(item => {
        const avgCost = item.product?.averageCost || 0;
        cogs += (avgCost * (item.quantity || 0));
      });
    });

    // Treat purchases in period as expenses for net profit calc
    const purchaseMatch = { company: companyId };
    if (startDate || endDate) {
      purchaseMatch.purchaseDate = {};
      if (startDate) purchaseMatch.purchaseDate.$gte = new Date(startDate);
      if (endDate) purchaseMatch.purchaseDate.$lte = new Date(endDate);
    }

    const purchases = await Purchase.find(purchaseMatch);
    const purchaseExpenses = purchases.reduce((sum, p) => sum + (p.grandTotal || 0), 0);

    // Taxes and discounts
    const taxes = invoices.reduce((sum, inv) => sum + (inv.totalTax || 0), 0);
    const discounts = invoices.reduce((sum, inv) => sum + (inv.totalDiscount || 0), 0);

    const grossProfit = revenue - cogs;
    const netProfit = grossProfit - purchaseExpenses - taxes - discounts;

    res.json({
      success: true,
      data: {
        revenue,
        cogs,
        grossProfit,
        purchaseExpenses,
        taxes,
        discounts,
        netProfit,
        invoicesCount: invoices.length,
        purchasesCount: purchases.length
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
    const now = new Date();

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

      res.json({ success: true, count: invoices.length, buckets });
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

      res.json({ success: true, count: purchases.length, buckets });
    }
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
    const { startDate, endDate } = req.query;
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
        _id: '$items.taxCode',
        taxableBase: { $sum: { $multiply: [ '$items.quantity', '$items.unitPrice' ] } },
        taxAmount: { $sum: '$items.taxAmount' }
      } }
    ]);

    const summary = {};
    agg.forEach(a => {
      summary[a._id || 'None'] = { taxableBase: a.taxableBase, taxAmount: a.taxAmount };
    });

    res.json({ success: true, summary });
  } catch (error) {
    next(error);
  }
};

// @desc    Product performance (sales, quantity, margin)
// @route   GET /api/reports/product-performance
// @access  Private
exports.getProductPerformanceReport = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, limit = 50 } = req.query;
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

    res.json({ success: true, count: report.length, data: report });
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

    res.json({ success: true, count: agg.length, data: agg });
  } catch (error) {
    next(error);
  }
};

// @desc    Cash flow statement (inflows from invoice payments, outflows from purchase payments)
// @route   GET /api/reports/cash-flow
// @access  Private
exports.getCashFlowStatement = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate, period = 'monthly' } = req.query;
    const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
    const end = endDate ? new Date(endDate) : new Date();

    // Determine date format based on period
    let dateFormat;
    let groupByFormat;
    switch (period) {
      case 'weekly':
        dateFormat = '%Y-W%V';
        groupByFormat = { $dateToString: { format: '%Y-W%V', date: '$payments.paidDate' } };
        break;
      case 'yearly':
        dateFormat = '%Y';
        groupByFormat = { $dateToString: { format: '%Y', date: '$payments.paidDate' } };
        break;
      case 'monthly':
      default:
        dateFormat = '%Y-%m';
        groupByFormat = { $dateToString: { format: '%Y-%m', date: '$payments.paidDate' } };
        break;
    }

    // Invoice payments (inflows)
    const invoicePayments = await Invoice.aggregate([
      { $match: { company: companyId } },
      { $unwind: '$payments' },
      { $match: { 'payments.paidDate': { $gte: start, $lte: end } } },
      { $group: {
        _id: groupByFormat,
        inflow: { $sum: '$payments.amount' }
      } },
      { $sort: { _id: 1 } }
    ]);

    // Purchase payments (outflows)
    const purchasePayments = await Purchase.aggregate([
      { $match: { company: companyId } },
      { $unwind: '$payments' },
      { $match: { 'payments.paidDate': { $gte: start, $lte: end } } },
      { $group: {
        _id: groupByFormat,
        outflow: { $sum: '$payments.amount' }
      } },
      { $sort: { _id: 1 } }
    ]);

    // Merge by period
    const map = {};
    invoicePayments.forEach(r => { map[r._id] = map[r._id] || { period: r._id, inflow: 0, outflow: 0 }; map[r._id].inflow = r.inflow; });
    purchasePayments.forEach(r => { map[r._id] = map[r._id] || { period: r._id, inflow: 0, outflow: 0 }; map[r._id].outflow = r.outflow; });

    const months = Object.values(map).sort((a, b) => a.period.localeCompare(b.period));

    res.json({ success: true, period: { start, end }, periodType: period, months });
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

// @desc    Export report to Excel
// @route   GET /api/reports/export/excel/:reportType
// @access  Private
exports.exportReportToExcel = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reportType } = req.params;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Report');

    let data;

    switch (reportType) {
      case 'stock-valuation':
        const productsExcel = await Product.find({ isArchived: false, company: companyId })
          .populate('category', 'name')
          .sort({ name: 1 });

        worksheet.columns = [
          { header: 'SKU', key: 'sku', width: 15 },
          { header: 'Product Name', key: 'name', width: 30 },
          { header: 'Category', key: 'category', width: 20 },
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
            unit: product.unit,
            stock: product.currentStock,
            cost: product.averageCost,
            value: product.currentStock * product.averageCost
          });
        });
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
exports.exportReportToPDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reportType } = req.params;
    const doc = new PDFDocument({ margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${reportType}-report.pdf`);

    doc.pipe(res);

    doc.fontSize(20).text(`${reportType.toUpperCase().replace('-', ' ')} REPORT`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    switch (reportType) {
      case 'stock-valuation':
        const productsPdf = await Product.find({ isArchived: false, company: companyId })
          .populate('category', 'name')
          .sort({ name: 1 });

        doc.fontSize(12).text('Stock Valuation Report', { underline: true });
        doc.moveDown();

        let totalValue = 0;
        productsPdf.forEach(product => {
          const value = product.currentStock * product.averageCost;
          totalValue += value;
          doc.fontSize(9).text(
            `${product.sku} - ${product.name} | Stock: ${product.currentStock} ${product.unit} | Value: $${value.toFixed(2)}`
          );
        });

        doc.moveDown();
        doc.fontSize(12).text(`Total Stock Value: $${totalValue.toFixed(2)}`, { bold: true });
        break;

      case 'sales-summary':
        const invoicesPdf = await Invoice.find({ status: { $in: ['paid', 'partial'] }, company: companyId })
          .populate('client', 'name')
          .sort({ invoiceDate: -1 })
          .limit(50);

        doc.fontSize(12).text('Sales Summary Report', { underline: true });
        doc.moveDown();

        let totalSales = 0;
        invoicesPdf.forEach(invoice => {
          totalSales += invoice.grandTotal;
          doc.fontSize(9).text(
            `${invoice.invoiceNumber} | ${invoice.invoiceDate.toLocaleDateString()} | ${invoice.client?.name} | $${invoice.grandTotal.toFixed(2)}`
          );
        });

        doc.moveDown();
        doc.fontSize(12).text(`Total Sales: $${totalSales.toFixed(2)}`, { bold: true });
        break;

      default:
        doc.text('Invalid report type');
    }

    doc.end();
  } catch (error) {
    next(error);
  }
};
