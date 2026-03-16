const Tax = require('../models/Tax');
const Invoice = require('../models/Invoice');
const Expense = require('../models/Expense');
const Payroll = require('../models/Payroll');
const mongoose = require('mongoose');
const JournalService = require('../services/journalService');

// Get all tax records for company
exports.getTaxRecords = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { taxType, year, status } = req.query;
    
    const query = { company: companyId };
    if (taxType) query.taxType = taxType;
    if (status) query.status = status;
    
    const taxes = await Tax.find(query)
      .sort({ createdAt: -1 })
      .populate('createdBy', 'name email');
    
    res.json({
      success: true,
      data: taxes,
      count: taxes.length
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get tax by ID
exports.getTaxById = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const tax = await Tax.findOne({ _id: req.params.id, company: companyId })
      .populate('payments.createdBy', 'name email')
      .populate('filings.createdBy', 'name email');
    
    if (!tax) {
      return res.status(404).json({ success: false, message: 'Tax record not found' });
    }
    
    res.json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get tax summary
exports.getTaxSummary = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { year } = req.query;
    
    // Get all tax records
    const taxes = await Tax.find({ company: companyId });
    
    // Calculate VAT summary from invoices and expenses
    const vatOutput = await Invoice.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(companyId) } },
      { $group: { _id: null, total: { $sum: '$taxAmount' } } }
    ]);
    
    const vatInput = await Expense.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(companyId), taxType: 'vat' } },
      { $group: { _id: null, total: { $sum: '$taxAmount' } } }
    ]);
    
    const netVAT = (vatOutput[0]?.total || 0) - (vatInput[0]?.total || 0);
    
    // Get PAYE from payroll
    const payrollPAYE = await Payroll.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(companyId) } },
      { $group: { _id: null, total: { $sum: '$deductions.paye' } } }
    ]);
    
    // Calculate upcoming deadlines
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    const upcomingDeadlines = taxes.flatMap(t => 
      t.calendar.filter(c => 
        new Date(c.dueDate) >= now && 
        new Date(c.dueDate) <= thirtyDaysFromNow &&
        c.status !== 'paid'
      ).map(c => ({
        ...c.toObject(),
        taxType: t.taxType
      }))
    ).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    
    // Calculate overdue
    const overdue = taxes.flatMap(t => 
      t.calendar.filter(c => 
        new Date(c.dueDate) < now && 
        c.status !== 'paid'
      ).map(c => ({
        ...c.toObject(),
        taxType: t.taxType
      }))
    );
    
    // Total tax owed
    const totalVatOwed = netVAT > 0 ? netVAT : 0;
    const totalPayeOwed = payrollPAYE[0]?.total || 0;
    
    res.json({
      success: true,
      data: {
        vat: {
          output: vatOutput[0]?.total || 0,
          input: vatInput[0]?.total || 0,
          net: netVAT,
          isPayable: netVAT > 0,
          refund: netVAT < 0 ? Math.abs(netVAT) : 0
        },
        paye: {
          collected: totalPayeOwed,
          owed: totalPayeOwed
        },
        corporateIncome: {
          rate: 30,
          status: 'quarterly_filing'
        },
        tradingLicense: {
          status: taxes.find(t => t.taxType === 'trading_license')?.tradingLicenseStatus || 'not_applicable',
          fee: taxes.find(t => t.taxType === 'trading_license')?.tradingLicenseFee || 0
        },
        upcomingDeadlines,
        overdue,
        totals: {
          vat: totalVatOwed,
          paye: totalPayeOwed,
          total: totalVatOwed + totalPayeOwed
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create tax record
exports.createTax = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    
    // Check if tax record already exists for this type
    const existing = await Tax.findOne({
      company: companyId,
      taxType: req.body.taxType
    });
    
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Tax record for ${req.body.taxType} already exists`
      });
    }
    
    const tax = new Tax({
      ...req.body,
      company: companyId,
      createdBy: req.user._id
    });
    
    await tax.save();
    
    res.status(201).json({
      success: true,
      data: tax
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update tax record
exports.updateTax = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    
    const tax = await Tax.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!tax) {
      return res.status(404).json({ success: false, message: 'Tax record not found' });
    }
    
    res.json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete tax record
exports.deleteTax = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    
    const tax = await Tax.findOneAndDelete({ _id: req.params.id, company: companyId });
    
    if (!tax) {
      return res.status(404).json({ success: false, message: 'Tax record not found' });
    }
    
    res.json({ success: true, message: 'Tax record deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Add tax payment
exports.addPayment = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    
    const tax = await Tax.findOne({ _id: req.params.id, company: companyId });
    
    if (!tax) {
      return res.status(404).json({ success: false, message: 'Tax record not found' });
    }
    
    tax.payments.push({
      ...req.body,
      createdBy: req.user._id
    });
    
    await tax.save();

    // Create journal entry for tax payment
    try {
      const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
      
      // Determine cash account based on payment method
      let cashAccount;
      if (req.body.paymentMethod === 'bank_transfer' || req.body.paymentMethod === 'cheque') {
        cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      } else if (req.body.paymentMethod === 'mobile_money') {
        cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      } else {
        // cash, card default to cash in hand
        cashAccount = DEFAULT_ACCOUNTS.cashInHand;
      }
      
      // Determine the tax payable account based on tax type
      let taxPayableAccount;
      switch (tax.taxType) {
        case 'vat':
          taxPayableAccount = DEFAULT_ACCOUNTS.vatPayable;
          break;
        case 'paye':
          taxPayableAccount = DEFAULT_ACCOUNTS.payePayable;
          break;
        case 'income_tax':
        case 'corporate_income_tax':
          taxPayableAccount = DEFAULT_ACCOUNTS.incomeTaxPayable;
          break;
        default:
          taxPayableAccount = DEFAULT_ACCOUNTS.vatPayable; // Default
      }
      
      await JournalService.createEntry(companyId, req.user._id, {
        date: new Date(),
        description: `${tax.taxType.toUpperCase()} Payment - ${req.body.amount}`,
        sourceType: 'tax_payment',
        sourceId: tax._id,
        lines: [
          JournalService.createDebitLine(taxPayableAccount, req.body.amount, `${tax.taxType.toUpperCase()} payment`),
          JournalService.createCreditLine(cashAccount, req.body.amount, `${tax.taxType.toUpperCase()} payment`)
        ],
        isAutoGenerated: true
      });
    } catch (journalError) {
      console.error('Error creating journal entry for tax payment:', journalError);
      // Don't fail the payment if journal entry fails
    }

    res.status(201).json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Add tax filing
exports.addFiling = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    
    const tax = await Tax.findOne({ _id: req.params.id, company: companyId });
    
    if (!tax) {
      return res.status(404).json({ success: false, message: 'Tax record not found' });
    }
    
    tax.filings.push({
      ...req.body,
      taxType: tax.taxType, // Add taxType from parent record
      createdBy: req.user._id
    });
    
    await tax.save();
    
    res.status(201).json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get tax calendar
exports.getCalendar = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { year, month, status } = req.query;
    
    const taxes = await Tax.find({ company: companyId });
    
    let calendar = taxes.flatMap(t => 
      t.calendar.map(c => ({
        ...c.toObject(),
        taxType: t.taxType,
        taxId: t._id
      }))
    );
    
    if (year) {
      calendar = calendar.filter(c => c.period?.year === parseInt(year));
    }
    if (month) {
      calendar = calendar.filter(c => c.period?.month === parseInt(month));
    }
    if (status) {
      calendar = calendar.filter(c => c.status === status);
    }
    
    calendar.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    
    res.json({ success: true, data: calendar });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Add calendar entry
exports.addCalendarEntry = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    
    const tax = await Tax.findOne({ _id: req.params.id, company: companyId });
    
    if (!tax) {
      return res.status(404).json({ success: false, message: 'Tax record not found' });
    }
    
    tax.calendar.push(req.body);
    
    await tax.save();
    
    res.status(201).json({ success: true, data: tax });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Prepare VAT return
exports.prepareVATReturn = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { month, year } = req.query;
    
    // Get output VAT from invoices
    const outputVAT = await Invoice.aggregate([
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          status: { $in: ['sent', 'paid'] },
          $expr: {
            $and: [
              { $eq: [{ $month: '$invoiceDate' }, parseInt(month)] },
              { $eq: [{ $year: '$invoiceDate' }, parseInt(year)] }
            ]
          }
        }
      },
      { $group: { _id: null, total: { $sum: '$taxAmount' } } }
    ]);
    
    // Get input VAT from expenses
    const inputVAT = await Expense.aggregate([
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          $expr: {
            $and: [
              { $eq: [{ $month: '$date' }, parseInt(month)] },
              { $eq: [{ $year: '$date' }, parseInt(year)] }
            ]
          }
        }
      },
      { $group: { _id: null, total: { $sum: '$taxAmount' } } }
    ]);
    
    const vatOutput = outputVAT[0]?.total || 0;
    const vatInput = inputVAT[0]?.total || 0;
    const netVAT = vatOutput - vatInput;
    
    // Get filing status
    const tax = await Tax.findOne({ company: companyId, taxType: 'vat' });
    const filing = tax?.filings.find(f => 
      f.period?.month === parseInt(month) && 
      f.period?.year === parseInt(year)
    );
    
    res.json({
      success: true,
      data: {
        period: { month: parseInt(month), year: parseInt(year) },
        vatOutput,
        vatInput,
        netVAT,
        isPayable: netVAT > 0,
        refund: netVAT < 0 ? Math.abs(netVAT) : 0,
        dueDate: new Date(year, parseInt(month) - 1, 15),
        filingStatus: filing?.status || 'not_filed',
        filingReference: filing?.filingReference
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get RRA filing history
exports.getFilingHistory = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { taxType, year } = req.query;
    
    const query = { company: companyId };
    if (taxType) query.taxType = taxType;
    
    const taxes = await Tax.find(query)
      .populate('filings.createdBy', 'name email')
      .sort({ 'filings.filingDate': -1 });
    
    let allFilings = taxes.flatMap(t => 
      t.filings.map(f => ({
        ...f.toObject(),
        taxType: t.taxType,
        taxId: t._id
      }))
    );
    
    if (year) {
      allFilings = allFilings.filter(f => f.filingPeriod?.year === parseInt(year));
    }
    
    allFilings.sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
    
    res.json({ success: true, data: allFilings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Generate tax calendar for year
exports.generateCalendar = async (req, res) => {
  try {
    const companyId = req.user.company._id;
    const { year } = req.body;
    
    const taxes = await Tax.find({ company: companyId });
    
    const newEntries = [];
    
    for (const tax of taxes) {
      if (tax.taxType === 'vat' || tax.taxType === 'paye') {
        // Monthly
        for (let month = 1; month <= 12; month++) {
          const dueDate = new Date(year, month - 1, 15);
          const existing = tax.calendar.find(c => 
            c.period?.month === month && 
            c.period?.year === year
          );
          
          if (!existing) {
            tax.calendar.push({
              title: `${tax.taxType.toUpperCase()} Due`,
              taxType: tax.taxType,
              dueDate,
              period: { month, year },
              isRecurring: true,
              recurrencePattern: 'monthly',
              status: dueDate < new Date() ? 'overdue' : 'upcoming'
            });
          }
        }
      } else if (tax.taxType === 'trading_license') {
        const dueDate = new Date(year, 0, 31);
        const existing = tax.calendar.find(c => c.period?.year === year);
        
        if (!existing) {
          tax.calendar.push({
            title: 'Trading License Renewal Due',
            taxType: 'trading_license',
            dueDate,
            period: { month: 1, year },
            isRecurring: true,
            recurrencePattern: 'annually',
            status: dueDate < new Date() ? 'overdue' : 'upcoming'
          });
        }
      }
      
      await tax.save();
      newEntries.push(...tax.calendar);
    }
    
    res.json({
      success: true,
      data: newEntries,
      message: `Generated calendar entries for ${year}`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
