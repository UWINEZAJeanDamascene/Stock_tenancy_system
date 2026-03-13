/**
 * Dry Run: Analyze Existing Data for Migration
 * 
 * This script analyzes existing transactions to see what would be migrated
 * without actually creating any journal entries.
 * 
 * Run with: node scripts/analyzeDataForMigration.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

async function analyzeData() {
  try {
    console.log('🔍 Analyzing existing data for migration...\n');
    
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ MongoDB Connected...\n');
    
    // Load models
    const Company = require('../models/Company');
    const Invoice = require('../models/Invoice');
    const Purchase = require('../models/Purchase');
    const CreditNote = require('../models/CreditNote');
    const Expense = require('../models/Expense');
    const FixedAsset = require('../models/FixedAsset');
    const Loan = require('../models/Loan');
    const PurchaseReturn = require('../models/PurchaseReturn');
    const JournalEntry = require('../models/JournalEntry');
    
    // Get all companies
    const companies = await Company.find({});
    console.log(`📊 Found ${companies.length} companies\n`);
    
    let grandTotalInvoices = 0;
    let grandTotalPurchases = 0;
    let grandTotalCreditNotes = 0;
    let grandTotalExpenses = 0;
    let grandTotalAssets = 0;
    let grandTotalLoans = 0;
    let grandTotalPurchaseReturns = 0;
    let grandTotalJournalEntries = 0;
    
    for (const company of companies) {
      console.log(`🏢 Company: ${company.name}`);
      console.log('='.repeat(50));
      
      // Count Invoices (excluding draft and cancelled)
      const invoices = await Invoice.countDocuments({ 
        company: company._id,
        status: { $nin: ['draft', 'cancelled'] }
      });
      
      // Count invoice payments
      const invoiceDocs = await Invoice.find({ 
        company: company._id,
        status: { $nin: ['draft', 'cancelled'] }
      });
      let invoicePayments = 0;
      for (const inv of invoiceDocs) {
        if (inv.payments && inv.payments.length > 0) {
          invoicePayments += inv.payments.length;
        }
      }
      
      // Count Purchases (excluding draft and cancelled)
      const purchases = await Purchase.countDocuments({ 
        company: company._id,
        status: { $nin: ['draft', 'cancelled'] }
      });
      
      // Count purchase payments
      const purchaseDocs = await Purchase.find({ 
        company: company._id,
        status: { $nin: ['draft', 'cancelled'] }
      });
      let purchasePayments = 0;
      for (const pur of purchaseDocs) {
        if (pur.payments && pur.payments.length > 0) {
          purchasePayments += pur.payments.filter(p => p.paymentMethod !== 'credit').length;
        }
      }
      
      // Count Credit Notes
      const creditNotes = await CreditNote.countDocuments({ 
        company: company._id,
        status: { $nin: ['draft', 'cancelled'] }
      });
      
      // Count credit note refunds
      const cnDocs = await CreditNote.find({ 
        company: company._id,
        status: { $nin: ['draft', 'cancelled'] }
      });
      let cnRefunds = 0;
      for (const cn of cnDocs) {
        if (cn.payments && cn.payments.length > 0) {
          cnRefunds += cn.payments.length;
        }
      }
      
      // Count Expenses
      const expenses = await Expense.countDocuments({ 
        company: company._id,
        status: { $nin: ['draft', 'cancelled'] }
      });
      
      // Count Fixed Assets
      const assets = await FixedAsset.countDocuments({ 
        company: company._id,
        status: { $ne: 'disposed' }
      });
      
      // Count Loans
      const loans = await Loan.countDocuments({ 
        company: company._id,
        status: { $ne: 'cancelled' }
      });
      
      // Count loan payments
      const loanDocs = await Loan.find({ 
        company: company._id,
        status: { $ne: 'cancelled' }
      });
      let loanPayments = 0;
      for (const loan of loanDocs) {
        if (loan.payments && loan.payments.length > 0) {
          loanPayments += loan.payments.length;
        }
      }
      
      // Count Purchase Returns
      const purchaseReturns = await PurchaseReturn.countDocuments({ 
        company: company._id,
        status: { $nin: ['draft', 'rejected'] }
      });
      
      // Count existing journal entries for this company
      const existingEntries = await JournalEntry.countDocuments({ 
        company: company._id 
      });
      
      // Calculate totals
      const totalInvoices = invoices + invoicePayments;
      const totalPurchases = purchases + purchasePayments;
      const totalCreditNotes = creditNotes + cnRefunds;
      const totalLoans = loans + loanPayments;
      
      const totalToMigrate = totalInvoices + totalPurchases + totalCreditNotes + 
                           expenses + assets + totalLoans + purchaseReturns;
      
      console.log(`  📄 Invoices: ${invoices} (+ ${invoicePayments} payments)`);
      console.log(`  📦 Purchases: ${purchases} (+ ${purchasePayments} payments)`);
      console.log(`  📝 Credit Notes: ${creditNotes} (+ ${cnRefunds} refunds)`);
      console.log(`  💰 Expenses: ${expenses}`);
      console.log(`  🏢 Fixed Assets: ${assets}`);
      console.log(`  🏦 Loans: ${loans} (+ ${loanPayments} payments)`);
      console.log(`  🔄 Purchase Returns: ${purchaseReturns}`);
      console.log(`  📊 Total entries that would be created: ${totalToMigrate}`);
      console.log(`  📋 Existing journal entries: ${existingEntries}`);
      console.log('');
      
      grandTotalInvoices += totalInvoices;
      grandTotalPurchases += totalPurchases;
      grandTotalCreditNotes += totalCreditNotes;
      grandTotalExpenses += expenses;
      grandTotalAssets += assets;
      grandTotalLoans += totalLoans;
      grandTotalPurchaseReturns += purchaseReturns;
      grandTotalJournalEntries += existingEntries;
    }
    
    const grandTotalToMigrate = grandTotalInvoices + grandTotalPurchases + grandTotalCreditNotes + 
                                grandTotalExpenses + grandTotalAssets + grandTotalLoans + grandTotalPurchaseReturns;
    
    console.log('='.repeat(50));
    console.log('📈 GRAND TOTAL SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total Invoice Entries: ${grandTotalInvoices}`);
    console.log(`Total Purchase Entries: ${grandTotalPurchases}`);
    console.log(`Total Credit Note Entries: ${grandTotalCreditNotes}`);
    console.log(`Total Expense Entries: ${grandTotalExpenses}`);
    console.log(`Total Asset Entries: ${grandTotalAssets}`);
    console.log(`Total Loan Entries: ${grandTotalLoans}`);
    console.log(`Total Purchase Return Entries: ${grandTotalPurchaseReturns}`);
    console.log(`─────────────────────────────────────────`);
    console.log(`TOTAL TO MIGRATE: ${grandTotalToMigrate}`);
    console.log(`Existing Journal Entries: ${grandTotalJournalEntries}`);
    console.log(`─────────────────────────────────────────`);
    console.log(`AFTER MIGRATION: ${grandTotalJournalEntries + grandTotalToMigrate}`);
    console.log('\n✅ Analysis complete!');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Analysis failed:', error);
    process.exit(1);
  }
}

analyzeData();
