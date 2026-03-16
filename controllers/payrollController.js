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
    const totalRSSBEmployee = payrollRecords.reduce((sum, p) => sum + ((p.deductions.rssbEmployeePension || 0) + (p.deductions.rssbEmployeeMaternity || 0)), 0);
    
    res.json({
      success: true,
      count: payrollRecords.length,
      data: payrollRecords,
      summary: {
        totalGrossSalary: Math.round(totalGross * 100) / 100,
        totalNetPay: Math.round(totalNet * 100) / 100,
        totalPAYE: Math.round(totalPAYE * 100) / 100,
        totalRSSB: Math.round(totalRSSBEmployee * 100) / 100,
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
        rssbEmployeePension: calculated.deductions.rssbEmployeePension,
        rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
        totalDeductions: calculated.deductions.totalDeductions
      },
      netPay: calculated.netPay,
      contributions: {
        rssbEmployerPension: calculated.contributions.rssbEmployerPension,
        rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
        occupationalHazard: calculated.contributions.occupationalHazard
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
        rssbEmployeePension: calculated.deductions.rssbEmployeePension,
        rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
        totalDeductions: calculated.deductions.totalDeductions
      };
      payroll.netPay = calculated.netPay;
      payroll.contributions = {
        rssbEmployerPension: calculated.contributions.rssbEmployerPension,
        rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
        occupationalHazard: calculated.contributions.occupationalHazard
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

    // Create journal entries for payroll payment - TWO separate entries
    try {
      const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
      const cashAccount = paymentMethod === 'bank' 
        ? DEFAULT_ACCOUNTS.cashAtBank 
        : DEFAULT_ACCOUNTS.cashInHand;
      
      // Get values
      const grossSalary = payroll.salary.grossSalary || 0;
      const netPay = payroll.netPay || 0;
      const paye = payroll.deductions.paye || 0;
      const rssbEmployeePension = payroll.deductions.rssbEmployeePension || 0;
      const rssbEmployeeMaternity = payroll.deductions.rssbEmployeeMaternity || 0;
      const rssbEmployeeTotal = rssbEmployeePension + rssbEmployeeMaternity;
      const rssbEmployerPension = payroll.contributions.rssbEmployerPension || 0;
      const rssbEmployerMaternity = payroll.contributions.rssbEmployerMaternity || 0;
      const occupationalHazard = payroll.contributions.occupationalHazard || 0;
      const employerContribTotal = rssbEmployerPension + rssbEmployerMaternity + occupationalHazard;
      
      // Entry 1: Salary Payment (Pay employee)
      // DR Salaries & Wages, CR PAYE, CR RSSB, CR Cash/Bank
      const lines1 = [];
      if (grossSalary > 0) {
        lines1.push(JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.salariesWages,
          grossSalary,
          `Salary payment - ${payroll.employee.firstName} ${payroll.employee.lastName} - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      if (paye > 0) {
        lines1.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.payePayable,
          paye,
          `PAYE deduction - ${payroll.employee.firstName} ${payroll.employee.lastName}`
        ));
      }
      
      if (rssbEmployeeTotal > 0) {
        lines1.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.rssbPayable,
          rssbEmployeeTotal,
          `RSSB deduction (Pension + Maternity) - ${payroll.employee.firstName} ${payroll.employee.lastName}`
        ));
      }
      
      if (netPay > 0) {
        lines1.push(JournalService.createCreditLine(
          cashAccount,
          netPay,
          `Net salary - ${payroll.employee.firstName} ${payroll.employee.lastName}`
        ));
      }
      
      // Create Entry 1
      if (lines1.length >= 2) {
        await JournalService.createEntry(companyId, userId, {
          date: new Date(),
          description: `Salary Payment - ${payroll.employee.firstName} ${payroll.employee.lastName} - ${payroll.period.monthName} ${payroll.period.year}`,
          sourceType: 'payroll_salary',
          sourceId: payroll._id,
          lines: lines1,
          isAutoGenerated: true
        });
      }
      
      // Entry 2: Tax Payment to RRA (Pay PAYE + RSSB to tax authority)
      // DR PAYE, DR RSSB, CR Cash/Bank
      const lines2 = [];
      
      if (paye > 0) {
        lines2.push(JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.payePayable,
          paye,
          `PAYE payment - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      if (rssbEmployeeTotal > 0) {
        lines2.push(JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.rssbPayable,
          rssbEmployeeTotal,
          `RSSB payment (Pension + Maternity) - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      const totalTax = paye + rssbEmployeeTotal;
      if (totalTax > 0) {
        lines2.push(JournalService.createCreditLine(
          cashAccount,
          totalTax,
          `Tax payment to RRA - ${payroll.period.monthName} ${payroll.period.year}`
        ));
      }
      
      // Create Entry 2
      if (lines2.length >= 2) {
        await JournalService.createEntry(companyId, userId, {
          date: new Date(),
          description: `Tax Payment to RRA - ${payroll.period.monthName} ${payroll.period.year}`,
          sourceType: 'payroll_tax',
          sourceId: payroll._id,
          lines: lines2,
          isAutoGenerated: true
        });
      }
      
      // Entry 3: Employer Contributions (when employer pays their portion)
      if (employerContribTotal > 0) {
        const lines3 = [];
        
        // DR Employer Contributions Expense
        lines3.push(JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.payrollExpenses,
          employerContribTotal,
          `Employer contributions - ${payroll.period.monthName} ${payroll.period.year}`
        ));
        
        // CR Employer Contributions Payable (Pension + Maternity + Occupational Hazard)
        lines3.push(JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.employerContributionPayable,
          employerContribTotal,
          `Employer contributions payable (Pension + Maternity + Occ. Hazard) - ${payroll.period.monthName} ${payroll.period.year}`
        ));
        
        await JournalService.createEntry(companyId, userId, {
          date: new Date(),
          description: `Employer Contributions - ${payroll.period.monthName} ${payroll.period.year}`,
          sourceType: 'payroll_employer',
          sourceId: payroll._id,
          lines: lines3,
          isAutoGenerated: true
        });
      }
    } catch (journalError) {
      console.error('Error creating journal entries for payroll:', journalError);
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
      monthlyData[key].rssb += (record.deductions.rssbEmployeePension || 0) + (record.deductions.rssbEmployeeMaternity || 0);
      monthlyData[key].employerContrib += (record.contributions.rssbEmployerPension || 0) + (record.contributions.rssbEmployerMaternity || 0) + (record.contributions.occupationalHazard || 0);
      monthlyData[key].employeeCount += 1;
      
      totalGross += record.salary.grossSalary || 0;
      totalNet += record.netPay || 0;
      totalPAYE += record.deductions.paye || 0;
      totalRSSB += (record.deductions.rssbEmployeePension || 0) + (record.deductions.rssbEmployeeMaternity || 0);
      totalEmployerContrib += (record.contributions.rssbEmployerPension || 0) + (record.contributions.rssbEmployerMaternity || 0) + (record.contributions.occupationalHazard || 0);
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
    
    // Get tax brackets for display - Updated 2025
    const grossSalary = salary.basicSalary + (salary.transportAllowance || 0) + (salary.housingAllowance || 0) + (salary.otherAllowances || 0);
    const taxBrackets = [
      { range: '0 - 60,000', rate: '0%', tax: 0 },
      { range: '60,001 - 100,000', rate: '10%', tax: Math.max(0, (Math.min(grossSalary, 100000) - 60000) * 0.10) },
      { range: '100,001 - 200,000', rate: '20%', tax: grossSalary > 100000 ? 4000 + Math.max(0, (Math.min(grossSalary, 200000) - 100000) * 0.20) : 0 },
      { range: 'Above 200,000', rate: '30%', tax: grossSalary > 200000 ? 24000 + (grossSalary - 200000) * 0.30 : 0 }
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
          rssbEmployeePension: calculated.deductions.rssbEmployeePension,
          rssbEmployeeMaternity: calculated.deductions.rssbEmployeeMaternity,
          totalDeductions: calculated.deductions.totalDeductions
        },
        netPay: calculated.netPay,
        contributions: {
          rssbEmployerPension: calculated.contributions.rssbEmployerPension,
          rssbEmployerMaternity: calculated.contributions.rssbEmployerMaternity,
          occupationalHazard: calculated.contributions.occupationalHazard
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
