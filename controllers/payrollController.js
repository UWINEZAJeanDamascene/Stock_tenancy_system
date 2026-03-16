const Payroll = require('../models/Payroll');
const User = require('../models/User');
const JournalService = require('../services/journalService');

// @desc    Get all payroll records for a company
// @route   GET /api/payroll
// @access  Private
exports.getPayrollRecords = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { month, year, status, search } = req.query;
    
    const query = { company: companyId };
    
    if (month && year) {
      query['period.month'] = parseInt(month);
      query['period.year'] = parseInt(year);
    } else if (year) {
      query['period.year'] = parseInt(year);
    }
    
    if (status) query['payment.status'] = status;
    
    if (search) {
      query.$or = [
        { 'employee.firstName': { $regex: search, $options: 'i' } },
        { 'employee.lastName': { $regex: search, $options: 'i' } },
        { 'employee.employeeId': { $regex: search, $options: 'i' } }
      ];
    }
    
    const payrollRecords = await Payroll.find(query)
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .sort({ 'period.year': -1, 'period.month': -1, 'employee.lastName': 1 });
    
    // Calculate summary
    const totalGross = payrollRecords.reduce((sum, p) => sum + (p.salary.grossSalary || 0), 0);
    const totalNet = payrollRecords.reduce((sum, p) => sum + (p.netPay || 0), 0);
    const totalPAYE = payrollRecords.reduce((sum, p) => sum + (p.deductions.paye || 0), 0);
    const totalRSSB = payrollRecords.reduce((sum, p) => sum + (p.deductions.rssbEmployee || 0), 0);
    
    res.json({
      success: true,
      count: payrollRecords.length,
      data: payrollRecords,
      summary: {
        totalGrossSalary: Math.round(totalGross * 100) / 100,
        totalNetPay: Math.round(totalNet * 100) / 100,
        totalPAYE: Math.round(totalPAYE * 100) / 100,
        totalRSSB: Math.round(totalRSSB * 100) / 100,
        employeeCount: payrollRecords.length
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single payroll record
// @route   GET /api/payroll/:id
// @access  Private
exports.getPayrollById = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const payroll = await Payroll.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email');
    
    if (!payroll) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }
    
    res.json({ success: true, data: payroll });
  } catch (error) {
    next(error);
  }
};

// @desc    Create payroll record
// @route   POST /api/payroll
// @access  Private
exports.createPayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    
    const {
      employee,
      salary,
      period,
      notes
    } = req.body;
    
    // Calculate payroll using Rwanda tax rules
    const calculated = Payroll.calculatePayroll(salary);
    
    const payroll = new Payroll({
      company: companyId,
      employee: {
        ...employee,
        isActive: true
      },
      salary: {
        basicSalary: salary.basicSalary,
        transportAllowance: salary.transportAllowance || 0,
        housingAllowance: salary.housingAllowance || 0,
        otherAllowances: salary.otherAllowances || 0,
        grossSalary: calculated.grossSalary
      },
      deductions: {
        paye: calculated.deductions.paye,
        rssbEmployee: calculated.deductions.rssbEmployee,
        totalDeductions: calculated.deductions.totalDeductions
      },
      netPay: calculated.netPay,
      contributions: {
        rssbEmployer: calculated.contributions.rssbEmployer,
        maternity: calculated.contributions.maternity
      },
      period: {
        month: period.month,
        year: period.year,
        monthName: Payroll.getMonthName(period.month)
      },
      notes,
      createdBy: userId
    });
    
    await payroll.save();
    
    res.status(201).json({
      success: true,
      data: payroll
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update payroll record
// @route   PUT /api/payroll/:id
// @access  Private
exports.updatePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    let payroll = await Payroll.findOne({ _id: req.params.id, company: companyId });
    
    if (!payroll) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }
    
    // Check if already paid
    if (payroll.payment.status === 'paid') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot update a paid payroll record' 
      });
    }
    
    const { employee, salary, period, notes } = req.body;
    
    // Recalculate if salary changed
    let calculated = null;
    if (salary) {
      calculated = Payroll.calculatePayroll(salary);
    }
    
    if (employee) {
      payroll.employee = { ...payroll.employee.toObject(), ...employee };
    }
    
    if (salary) {
      payroll.salary = {
        basicSalary: salary.basicSalary,
        transportAllowance: salary.transportAllowance || 0,
        housingAllowance: salary.housingAllowance || 0,
        otherAllowances: salary.otherAllowances || 0,
        grossSalary: calculated.grossSalary
      };
      payroll.deductions = {
        paye: calculated.deductions.paye,
        rssbEmployee: calculated.deductions.rssbEmployee,
        totalDeductions: calculated.deductions.totalDeductions
      };
      payroll.netPay = calculated.netPay;
      payroll.contributions = {
        rssbEmployer: calculated.contributions.rssbEmployer,
        maternity: calculated.contributions.maternity
      };
    }
    
    if (period) {
      payroll.period = {
        month: period.month,
        year: period.year,
        monthName: Payroll.getMonthName(period.month)
      };
    }
    
    if (notes !== undefined) {
      payroll.notes = notes;
    }
    
    payroll.updatedAt = new Date();
    await payroll.save();
    
    res.json({
      success: true,
      data: payroll
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete payroll record
// @route   DELETE /api/payroll/:id
// @access  Private
exports.deletePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const payroll = await Payroll.findOne({ _id: req.params.id, company: companyId });
    
    if (!payroll) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }
    
    // Check if already paid
    if (payroll.payment.status === 'paid') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete a paid payroll record' 
      });
    }
    
    await payroll.deleteOne();
    
    res.json({
      success: true,
      message: 'Payroll record deleted'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Process payroll payment
// @route   POST /api/payroll/:id/pay
// @access  Private
exports.processPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    
    const { paymentMethod, reference, notes } = req.body;
    
    const payroll = await Payroll.findOne({ _id: req.params.id, company: companyId });
    
    if (!payroll) {
      return res.status(404).json({ success: false, message: 'Payroll record not found' });
    }
    
    if (payroll.payment.status === 'paid') {
      return res.status(400).json({ 
        success: false, 
        message: 'Payment already processed' 
      });
    }
    
    payroll.payment = {
      status: 'paid',
      paymentDate: new Date(),
      paymentMethod: paymentMethod || 'bank_transfer',
      reference: reference
    };
    
    payroll.approvedBy = userId;
    await payroll.save();

    // Create journal entry for payroll payment
    try {
      const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
      
      // Determine cash account based on payment method
      let cashAccount;
      if (paymentMethod === 'bank_transfer' || paymentMethod === 'cheque') {
        cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      } else if (paymentMethod === 'mobile_money') {
        cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      } else {
        // cash, card default to cash in hand
        cashAccount = DEFAULT_ACCOUNTS.cashInHand;
      }
      
      const lines = [];
      
      // Debit: Salaries Expense (gross salary)
      const grossSalary = payroll.salary.grossSalary || 0;
      if (grossSalary > 0) {
        lines.push(JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.salariesWages,
          grossSalary,
          `Salary payment - ${payroll.employee.firstName} ${payroll.employee.lastName} - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      // Debit: Employer Contributions Expense (RSSB Employer + Maternity)
      const employerContrib = (payroll.contributions.rssbEmployer || 0) + (payroll.contributions.maternity || 0);
      if (employerContrib > 0) {
        lines.push(JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.payrollExpenses,
          employerContrib,
          `Employer contributions - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      // Credit: Cash/Bank (net pay to employee)
      const netPay = payroll.netPay || 0;
      if (netPay > 0) {
        lines.push(JournalService.createCreditLine(
          cashAccount,
          netPay,
          `Salary payment - ${payroll.employee.firstName} ${payroll.employee.lastName}`
        ));
      }
      
      // Credit: PAYE Payable (tax withheld)
      const paye = payroll.deductions.paye || 0;
      if (paye > 0) {
        lines.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.payePayable,
          paye,
          `PAYE - ${payroll.employee.firstName} ${payroll.employee.lastName} - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      // Credit: RSSB Payable (employee social security)
      const rssb = payroll.deductions.rssbEmployee || 0;
      if (rssb > 0) {
        lines.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.rssbPayable,
          rssb,
          `RSSB - ${payroll.employee.firstName} ${payroll.employee.lastName} - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      // Credit: Employer RSSB Payable
      if (employerContrib > 0) {
        lines.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.employerContributionPayable,
          employerContrib,
          `Employer contributions payable - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      await JournalService.createEntry(companyId, userId, {
        date: new Date(),
        description: `Salary payment - ${payroll.employee.firstName} ${payroll.employee.lastName} - ${payroll.period.monthName} ${payroll.period.year}`,
        sourceType: 'payroll',
        sourceId: payroll._id,
        lines,
        isAutoGenerated: true
      });
    } catch (journalError) {
      console.error('Error creating journal entry for payroll:', journalError);
      // Don't fail the payment if journal entry fails
    }

    res.json({
      success: true,
      data: payroll,
      message: 'Payment processed successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get payroll summary
// @route   GET /api/payroll/summary
// @access  Private
exports.getPayrollSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { year } = req.query;
    
    const query = { company: companyId };
    if (year) query['period.year'] = parseInt(year);
    
    // Get all payroll for the year
    const payrollRecords = await Payroll.find(query)
      .sort({ 'period.year': -1, 'period.month': -1 });
    
    // Group by month
    const monthlyData = {};
    let totalGross = 0;
    let totalNet = 0;
    let totalPAYE = 0;
    let totalRSSB = 0;
    let totalEmployerContrib = 0;
    
    payrollRecords.forEach(record => {
      const key = `${record.period.year}-${String(record.period.month).padStart(2, '0')}`;
      if (!monthlyData[key]) {
        monthlyData[key] = {
          month: record.period.month,
          year: record.period.year,
          monthName: record.period.monthName,
          grossSalary: 0,
          netPay: 0,
          paye: 0,
          rssb: 0,
          employerContrib: 0,
          employeeCount: 0
        };
      }
      
      monthlyData[key].grossSalary += record.salary.grossSalary || 0;
      monthlyData[key].netPay += record.netPay || 0;
      monthlyData[key].paye += record.deductions.paye || 0;
      monthlyData[key].rssb += record.deductions.rssbEmployee || 0;
      monthlyData[key].employerContrib += (record.contributions.rssbEmployer || 0) + (record.contributions.maternity || 0);
      monthlyData[key].employeeCount += 1;
      
      totalGross += record.salary.grossSalary || 0;
      totalNet += record.netPay || 0;
      totalPAYE += record.deductions.paye || 0;
      totalRSSB += record.deductions.rssbEmployee || 0;
      totalEmployerContrib += (record.contributions.rssbEmployer || 0) + (record.contributions.maternity || 0);
    });
    
    // Get current month stats
    const now = new Date();
    const currentMonthPayroll = payrollRecords.filter(p => 
      p.period.month === now.getMonth() + 1 && p.period.year === now.getFullYear()
    );
    
    const currentMonthGross = currentMonthPayroll.reduce((sum, p) => sum + (p.salary.grossSalary || 0), 0);
    const currentMonthNet = currentMonthPayroll.reduce((sum, p) => sum + (p.netPay || 0), 0);
    
    res.json({
      success: true,
      data: {
        monthlyData: Object.values(monthlyData).reverse(),
        totals: {
          totalGrossSalary: Math.round(totalGross * 100) / 100,
          totalNetPay: Math.round(totalNet * 100) / 100,
          totalPAYE: Math.round(totalPAYE * 100) / 100,
          totalRSSB: Math.round(totalRSSB * 100) / 100,
          totalEmployerContrib: Math.round(totalEmployerContrib * 100) / 100
        },
        currentMonth: {
          grossSalary: Math.round(currentMonthGross * 100) / 100,
          netPay: Math.round(currentMonthNet * 100) / 100,
          employeeCount: currentMonthPayroll.length
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Calculate payroll (preview)
// @route   POST /api/payroll/calculate
// @access  Private
exports.calculatePayroll = async (req, res, next) => {
  try {
    const { salary } = req.body;
    
    if (!salary || !salary.basicSalary) {
      return res.status(400).json({ 
        success: false, 
        message: 'Basic salary is required' 
      });
    }
    
    const calculated = Payroll.calculatePayroll(salary);
    
    // Get tax brackets for display (correct Rwanda PAYE brackets)
    const grossSalary = (salary.basicSalary || 0) + (salary.transportAllowance || 0) + (salary.housingAllowance || 0) + (salary.otherAllowances || 0);
    
    let tax1 = 0, tax2 = 0, tax3 = 0, tax4 = 0;
    
    if (grossSalary <= 60000) {
      tax1 = 0;
    } else if (grossSalary <= 100000) {
      tax2 = (grossSalary - 60000) * 0.10;
    } else if (grossSalary <= 200000) {
      tax2 = (100000 - 60000) * 0.10;
      tax3 = (grossSalary - 100000) * 0.20;
    } else {
      tax2 = (100000 - 60000) * 0.10;
      tax3 = (200000 - 100000) * 0.20;
      tax4 = (grossSalary - 200000) * 0.30;
    }
    
    const taxBrackets = [
      { range: '0 - 60,000', rate: '0%', tax: 0 },
      { range: '60,001 - 100,000', rate: '10%', tax: tax2 },
      { range: '100,001 - 200,000', rate: '20%', tax: tax3 },
      { range: '200,001+', rate: '30%', tax: tax4 }
    ];
    
    res.json({
      success: true,
      data: {
        ...calculated,
        taxBrackets: taxBrackets.map(t => ({ ...t, tax: Math.round(t.tax * 100) / 100 }))
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk create payroll for all employees
// @route   POST /api/payroll/bulk
// @access  Private
exports.bulkCreatePayroll = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    
    const { employees, period, notes } = req.body;
    
    if (!employees || !Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employees array is required' 
      });
    }
    
    const createdPayroll = [];
    
    for (const emp of employees) {
      const calculated = Payroll.calculatePayroll(emp.salary);
      
      const payroll = new Payroll({
        company: companyId,
        employee: {
          ...emp.employee,
          isActive: true
        },
        salary: {
          basicSalary: emp.salary.basicSalary,
          transportAllowance: emp.salary.transportAllowance || 0,
          housingAllowance: emp.salary.housingAllowance || 0,
          otherAllowances: emp.salary.otherAllowances || 0,
          grossSalary: calculated.grossSalary
        },
        deductions: {
          paye: calculated.deductions.paye,
          rssbEmployee: calculated.deductions.rssbEmployee,
          totalDeductions: calculated.deductions.totalDeductions
        },
        netPay: calculated.netPay,
        contributions: {
          rssbEmployer: calculated.contributions.rssbEmployer,
          maternity: calculated.contributions.maternity
        },
        period: {
          month: period.month,
          year: period.year,
          monthName: Payroll.getMonthName(period.month)
        },
        notes,
        createdBy: userId
      });
      
      await payroll.save();
      createdPayroll.push(payroll);
    }
    
    res.status(201).json({
      success: true,
      count: createdPayroll.length,
      data: createdPayroll
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Pay PAYE tax to RRA
// @route   POST /api/payroll/pay-paye
// @access  Private (admin, manager)
exports.payPAYE = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    
    const { amount, paymentMethod, reference, period } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid amount is required' 
      });
    }
    
    // Determine cash account based on payment method
    const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
    let cashAccount;
    if (paymentMethod === 'bank_transfer' || paymentMethod === 'cheque') {
      cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
    } else if (paymentMethod === 'mobile_money') {
      cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
    } else {
      cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    }
    
    // Create journal entry for PAYE payment
    // DR 2200 PAYE Payable, CR Cash at Bank
    const lines = [];
    
    // Debit: PAYE Payable (reducing the liability)
    lines.push(JournalService.createDebitLine(
      DEFAULT_ACCOUNTS.payePayable,
      amount,
      `PAYE Payment${period ? ` - ${period.monthName} ${period.year}` : ''}`
    ));
    
    // Credit: Cash/Bank
    lines.push(JournalService.createCreditLine(
      cashAccount,
      amount,
      `PAYE Payment to RRA${period ? ` - ${period.monthName} ${period.year}` : ''}`
    ));
    
    await JournalService.createEntry(companyId, userId, {
      date: new Date(),
      description: `PAYE Payment${period ? ` - ${period.monthName} ${period.year}` : ''}`,
      sourceType: 'tax_payment',
      sourceReference: reference,
      lines,
      isAutoGenerated: true,
      notes: `PAYE tax payment to RRA. Reference: ${reference || 'N/A'}`
    });
    
    res.status(201).json({
      success: true,
      message: 'PAYE payment recorded successfully',
      data: {
        amount,
        paymentMethod,
        cashAccount,
        reference
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Pay RSSB (social security) to RSSB
// @route   POST /api/payroll/pay-rssb
// @access  Private (admin, manager)
exports.payRSSB = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user._id;
    
    const { amount, paymentMethod, reference, period } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid amount is required' 
      });
    }
    
    // Determine cash account based on payment method
    const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
    let cashAccount;
    if (paymentMethod === 'bank_transfer' || paymentMethod === 'cheque') {
      cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
    } else if (paymentMethod === 'mobile_money') {
      cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
    } else {
      cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    }
    
    // Create journal entry for RSSB payment
    // DR 2300 RSSB Payable, CR Cash at Bank
    const lines = [];
    
    // Debit: RSSB Payable (reducing the liability)
    lines.push(JournalService.createDebitLine(
      DEFAULT_ACCOUNTS.rssbPayable,
      amount,
      `RSSB Payment${period ? ` - ${period.monthName} ${period.year}` : ''}`
    ));
    
    // Credit: Cash/Bank
    lines.push(JournalService.createCreditLine(
      cashAccount,
      amount,
      `RSSB Payment to RSSB${period ? ` - ${period.monthName} ${period.year}` : ''}`
    ));
    
    await JournalService.createEntry(companyId, userId, {
      date: new Date(),
      description: `RSSB Payment${period ? ` - ${period.monthName} ${period.year}` : ''}`,
      sourceType: 'tax_payment',
      sourceReference: reference,
      lines,
      isAutoGenerated: true,
      notes: `RSSB (social security) payment to RSSB. Reference: ${reference || 'N/A'}`
    });
    
    res.status(201).json({
      success: true,
      message: 'RSSB payment recorded successfully',
      data: {
        amount,
        paymentMethod,
        cashAccount,
        reference
      }
    });
  } catch (error) {
    next(error);
  }
};
