const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const payrollSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  // Employee Information
  employee: {
    employeeId: { type: String, required: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: String,
    phone: String,
    department: String,
    position: String,
    nationalId: String,
    bankName: String,
    bankAccount: String,
    employmentType: { 
      type: String, 
      enum: ['full-time', 'part-time', 'contract', 'intern'],
      default: 'full-time'
    },
    startDate: Date,
    isActive: { type: Boolean, default: true }
  },
  
  // Salary Information
  salary: {
    basicSalary: { type: Number, required: true, min: 0 },
    transportAllowance: { type: Number, default: 0 },
    housingAllowance: { type: Number, default: 0 },
    otherAllowances: { type: Number, default: 0 },
    // Gross = Basic + All Allowances
    grossSalary: { type: Number, default: 0 }
  },
  
  // Deductions
  deductions: {
    paye: { type: Number, default: 0 },           // Pay As You Earn (Income Tax)
    rssbEmployee: { type: Number, default: 0 },   // 3% Employee Social Security
    healthInsurance: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    loanDeductions: { type: Number, default: 0 },
    // Total Deductions
    totalDeductions: { type: Number, default: 0 }
  },
  
  // Net Pay
  netPay: { type: Number, default: 0 },
  
  // Rwanda-Specific Contributions
  contributions: {
    rssbEmployer: { type: Number, default: 0 },   // 5% Employer Social Security
    maternity: { type: Number, default: 0 }        // 0.6% Maternity
  },
  
  // Payroll Period
  period: {
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    monthName: String
  },
  
  // Payment Information
  payment: {
    status: { 
      type: String, 
      enum: ['pending', 'processed', 'paid', 'cancelled'],
      default: 'pending'
    },
    paymentDate: Date,
    paymentMethod: { 
      type: String, 
      enum: ['cash', 'bank_transfer', 'cheque', 'mobile_money'],
      default: 'bank_transfer'
    },
    reference: String
  },
  
  // Payslip
  payslipGenerated: { type: Boolean, default: false },
  payslipDate: Date,
  
  // Notes
  notes: String,
  
  // Audit
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Rwanda Tax Calculation Functions
payrollSchema.statics.calculatePAYE = function(grossSalary) {
  // PAYE Progressive Rates (Rwanda) - Correct tax bands
  // 0 - 60,000: 0%
  // 60,001 - 100,000: 10%
  // 100,001 - 200,000: 20%
  // Above 200,000: 30%
  
  let paye = 0;
  const taxableAmount = grossSalary;
  
  if (taxableAmount <= 60000) {
    // Bracket 1: 0%
    paye = 0;
  } else if (taxableAmount <= 100000) {
    // Bracket 2: 10% (only on amount above 60,000)
    paye = (taxableAmount - 60000) * 0.10;
  } else if (taxableAmount <= 200000) {
    // Bracket 3: 20%
    // First 60,000 at 0%, next 40,000 at 10%, rest at 20%
    paye = (100000 - 60000) * 0.10 + (taxableAmount - 100000) * 0.20;
  } else {
    // Bracket 4: 30%
    // First 60,000 at 0%, next 40,000 at 10%, next 100,000 at 20%, rest at 30%
    paye = (100000 - 60000) * 0.10 + (200000 - 100000) * 0.20 + (taxableAmount - 200000) * 0.30;
  }
  
  return Math.round(paye * 100) / 100;
};

payrollSchema.statics.calculateRSSBEmployee = function(grossSalary) {
  // RSSB Employee: 3% of gross
  return Math.round(grossSalary * 0.03 * 100) / 100;
};

payrollSchema.statics.calculateRSSBEmployer = function(grossSalary) {
  // RSSB Employer: 5% of gross
  return Math.round(grossSalary * 0.05 * 100) / 100;
};

payrollSchema.statics.calculateMaternity = function(grossSalary) {
  // Maternity: 0.6% of gross
  return Math.round(grossSalary * 0.006 * 100) / 100;
};

payrollSchema.statics.calculatePayroll = function(salaryData) {
  const { basicSalary, transportAllowance = 0, housingAllowance = 0, otherAllowances = 0 } = salaryData;
  
  // Calculate Gross Salary
  const grossSalary = basicSalary + transportAllowance + housingAllowance + otherAllowances;
  
  // Calculate Deductions
  const paye = this.calculatePAYE(grossSalary);
  const rssbEmployee = this.calculateRSSBEmployee(grossSalary);
  const rssbEmployer = this.calculateRSSBEmployer(grossSalary);
  const maternity = this.calculateMaternity(grossSalary);
  
  // Total Deductions (Employee portion)
  const totalDeductions = paye + rssbEmployee;
  
  // Calculate Net Pay
  const netPay = grossSalary - totalDeductions;
  
  return {
    grossSalary: Math.round(grossSalary * 100) / 100,
    deductions: {
      paye: Math.round(paye * 100) / 100,
      rssbEmployee: Math.round(rssbEmployee * 100) / 100,
      totalDeductions: Math.round(totalDeductions * 100) / 100
    },
    contributions: {
      rssbEmployer: Math.round(rssbEmployer * 100) / 100,
      maternity: Math.round(maternity * 100) / 100
    },
    netPay: Math.round(netPay * 100) / 100
  };
};

// Generate unique payroll number
payrollSchema.statics.generatePayrollNumber = async function(companyId) {
  const count = await this.countDocuments({ company: companyId });
  const payrollNumber = `PR-${String(count + 1).padStart(5, '0')}`;
  return payrollNumber;
};

// Calculate monthly name
payrollSchema.statics.getMonthName = function(month) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return months[month - 1];
};

// Index for efficient queries
payrollSchema.index({ company: 1, 'period.year': 1, 'period.month': 1 });
payrollSchema.index({ company: 1, 'employee.employeeId': 1 });

module.exports = mongoose.model('Payroll', payrollSchema);
