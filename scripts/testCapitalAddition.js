/**
 * Test script for Capital Addition functionality
 * Adds capital to: Bank Account, Petty Cash, and MoMo Account
 * 
 * Run with: node scripts/testCapitalAddition.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/stock_management';
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB Connected');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
};

// Models
require('../models/User');
const Company = require('../models/Company');
const { BankAccount } = require('../models/BankAccount');
const { PettyCashFloat, PettyCashReplenishment } = require('../models/PettyCash');
const JournalEntry = require('../models/JournalEntry');
const { DEFAULT_ACCOUNTS, CHART_OF_ACCOUNTS } = require('../constants/chartOfAccounts');

const testCapitalAddition = async () => {
  try {
    await connectDB();
    
    // Find CBS company
    const company = await Company.findOne({ name: { $regex: /CBS/i } });
    
    if (!company) {
      console.log('❌ CBS Company not found. Please run seedCBSCompany.js first.');
      process.exit(1);
    }
    
    console.log(`\n📋 Found company: ${company.name} (${company._id})`);
    
    // Get company users
    const User = mongoose.model('User');
    const users = await User.find({ company: company._id });
    const userId = users[0] ? users[0]._id : null;
    
    if (!userId) {
      console.log('❌ No users found for company');
      process.exit(1);
    }
    
    console.log(`📋 Using user: ${users[0].name} (${userId})`);
    
    // Use default chart of accounts
    const CASH_IN_HAND = DEFAULT_ACCOUNTS.cashInHand; // '1000'
    const CASH_AT_BANK = DEFAULT_ACCOUNTS.cashAtBank; // '1100'
    const MTN_MOMO = DEFAULT_ACCOUNTS.mtnMoMo; // '1200'
    const PETTY_CASH = DEFAULT_ACCOUNTS.pettyCash; // '1050'
    const SHARE_CAPITAL = DEFAULT_ACCOUNTS.shareCapital; // '3000'
    
    console.log(`\n📋 Using account codes:`);
    console.log(`   - Cash in Hand: ${CASH_IN_HAND} - ${CHART_OF_ACCOUNTS[CASH_IN_HAND].name}`);
    console.log(`   - Cash at Bank: ${CASH_AT_BANK} - ${CHART_OF_ACCOUNTS[CASH_AT_BANK].name}`);
    console.log(`   - MTN MoMo: ${MTN_MOMO} - ${CHART_OF_ACCOUNTS[MTN_MOMO].name}`);
    console.log(`   - Petty Cash: ${PETTY_CASH} - ${CHART_OF_ACCOUNTS[PETTY_CASH].name}`);
    console.log(`   - Share Capital: ${SHARE_CAPITAL} - ${CHART_OF_ACCOUNTS[SHARE_CAPITAL].name}`);
    
    // Get bank accounts
    const bankAccounts = await BankAccount.find({ company: company._id, isActive: true });
    const bkBank = bankAccounts.find(a => a.accountType === 'bk_bank');
    const mtnMomo = bankAccounts.find(a => a.accountType === 'mtn_momo');
    
    if (!bkBank) {
      console.log('❌ BK Bank account not found - run seedCBSCompany.js first');
      process.exit(1);
    }
    if (!mtnMomo) {
      console.log('❌ MTN MoMo account not found - run seedCBSCompany.js first');
      process.exit(1);
    }
    
    // Get petty cash floats
    const pettyCashes = await PettyCashFloat.find({ company: company._id, isActive: true });
    const mainOfficePc = pettyCashes.find(a => a.name.includes('Main Office')) || pettyCashes[0];
    
    if (!mainOfficePc) {
      console.log('❌ Main Office Petty Cash not found - run seedCBSCompany.js first');
      process.exit(1);
    }
    
    console.log(`\n📋 Bank Account: ${bkBank.name} (Balance: ${bkBank.currentBalance})`);
    console.log(`📋 MoMo Account: ${mtnMomo.name} (Balance: ${mtnMomo.currentBalance})`);
    console.log(`📋 Petty Cash: ${mainOfficePc.name} (Balance: ${mainOfficePc.currentBalance})`);
    
    // ========================================
    // TEST 1: Add Capital to Bank Account
    // ========================================
    console.log('\n🧪 TEST 1: Adding Capital to Bank Account (BK Bank)');
    console.log('   ------------------------------------------------');
    
    // Generate entry number
    const bankEntryNumber = await JournalEntry.generateEntryNumber(company._id);
    
    const bankJournalEntry = await JournalEntry.create({
      company: company._id,
      entryNumber: bankEntryNumber,
      date: new Date(),
      description: "Share Capital Investment - BK Bank",
      reference: 'CAP-BK-001',
      lines: [
        {
          accountCode: CASH_AT_BANK,
          accountName: CHART_OF_ACCOUNTS[CASH_AT_BANK].name,
          description: 'BK Bank - Main Account',
          debit: 5000000,
          credit: 0
        },
        {
          accountCode: SHARE_CAPITAL,
          accountName: CHART_OF_ACCOUNTS[SHARE_CAPITAL].name,
          description: 'Share Capital Investment',
          debit: 0,
          credit: 5000000
        }
      ],
      status: 'posted',
      createdBy: userId
    });
    
    // Update bank account balance
    bkBank.currentBalance += 5000000;
    await bkBank.save();
    
    console.log(`   ✅ Created Journal Entry: ${bankJournalEntry.entryNumber}`);
    console.log(`   ✅ Debit: ${CASH_AT_BANK} - ${CHART_OF_ACCOUNTS[CASH_AT_BANK].name} - 5,000,000`);
    console.log(`   ✅ Credit: ${SHARE_CAPITAL} - ${CHART_OF_ACCOUNTS[SHARE_CAPITAL].name} - 5,000,000`);
    console.log(`   ✅ Bank Balance Updated: ${bkBank.currentBalance}`);
    
    // ========================================
    // TEST 2: Add Capital to MoMo Account
    // ========================================
    console.log('\n🧪 TEST 2: Adding Capital to MoMo Account (MTN MoMo)');
    console.log('   ------------------------------------------------');
    
    // Generate entry number
    const momoEntryNumber = await JournalEntry.generateEntryNumber(company._id);
    
    const momoJournalEntry = await JournalEntry.create({
      company: company._id,
      entryNumber: momoEntryNumber,
      date: new Date(),
      description: "Share Capital Investment - MTN MoMo",
      reference: 'CAP-MOMO-001',
      lines: [
        {
          accountCode: MTN_MOMO,
          accountName: CHART_OF_ACCOUNTS[MTN_MOMO].name,
          description: 'MTN MoMo - Business Account',
          debit: 1000000,
          credit: 0
        },
        {
          accountCode: SHARE_CAPITAL,
          accountName: CHART_OF_ACCOUNTS[SHARE_CAPITAL].name,
          description: 'Share Capital Investment',
          debit: 0,
          credit: 1000000
        }
      ],
      status: 'posted',
      createdBy: userId
    });
    
    // Update MoMo account balance
    mtnMomo.currentBalance += 1000000;
    await mtnMomo.save();
    
    console.log(`   ✅ Created Journal Entry: ${momoJournalEntry.entryNumber}`);
    console.log(`   ✅ Debit: ${MTN_MOMO} - ${CHART_OF_ACCOUNTS[MTN_MOMO].name} - 1,000,000`);
    console.log(`   ✅ Credit: ${SHARE_CAPITAL} - ${CHART_OF_ACCOUNTS[SHARE_CAPITAL].name} - 1,000,000`);
    console.log(`   ✅ MoMo Balance Updated: ${mtnMomo.currentBalance}`);
    
    // ========================================
    // TEST 3: Add Capital to Petty Cash
    // ========================================
    console.log('\n🧪 TEST 3: Adding Capital to Petty Cash (Main Office)');
    console.log('   ------------------------------------------------');
    
    // Generate entry number
    const pcEntryNumber = await JournalEntry.generateEntryNumber(company._id);
    
    const pettyCashJournalEntry = await JournalEntry.create({
      company: company._id,
      entryNumber: pcEntryNumber,
      date: new Date(),
      description: "Share Capital Investment - Petty Cash",
      reference: 'CAP-PC-001',
      lines: [
        {
          accountCode: PETTY_CASH,
          accountName: CHART_OF_ACCOUNTS[PETTY_CASH].name,
          description: 'Main Office Petty Cash',
          debit: 500000,
          credit: 0
        },
        {
          accountCode: SHARE_CAPITAL,
          accountName: CHART_OF_ACCOUNTS[SHARE_CAPITAL].name,
          description: 'Share Capital Investment',
          debit: 0,
          credit: 500000
        }
      ],
      status: 'posted',
      createdBy: userId
    });
    
    // Create and complete petty cash replenishment
    const replenishment = await PettyCashReplenishment.create({
      company: company._id,
      float: mainOfficePc._id,
      amount: 500000,
      reason: "Share Capital Investment",
      status: 'completed',
      requestedBy: userId,
      approvedBy: userId,
      completedBy: userId,
      completedAt: new Date(),
      actualAmount: 500000
    });
    
    console.log(`   ✅ Created Journal Entry: ${pettyCashJournalEntry.entryNumber}`);
    console.log(`   ✅ Debit: ${PETTY_CASH} - ${CHART_OF_ACCOUNTS[PETTY_CASH].name} - 500,000`);
    console.log(`   ✅ Credit: ${SHARE_CAPITAL} - ${CHART_OF_ACCOUNTS[SHARE_CAPITAL].name} - 500,000`);
    console.log(`   ✅ Created Petty Cash Replenishment: ${replenishment._id}`);
    
    // ========================================
    // Summary
    // ========================================
    console.log('\n📊 TEST SUMMARY');
    console.log('   ==================================================');
    
    // Get updated balances
    const updatedBkBank = await BankAccount.findById(bkBank._id);
    const updatedMtnMomo = await BankAccount.findById(mtnMomo._id);
    const updatedMainOfficePc = await PettyCashFloat.findById(mainOfficePc._id);
    
    console.log(`\n   Bank Account (BK Bank):`);
    console.log(`   - Previous: 0`);
    console.log(`   - Added: 5,000,000`);
    console.log(`   - Current: ${updatedBkBank.currentBalance}`);
    
    console.log(`\n   MoMo Account (MTN MoMo):`);
    console.log(`   - Previous: 0`);
    console.log(`   - Added: 1,000,000`);
    console.log(`   - Current: ${updatedMtnMomo.currentBalance}`);
    
    console.log(`\n   Petty Cash (Main Office):`);
    console.log(`   - Previous: 0`);
    console.log(`   - Added: 500,000`);
    console.log(`   - Current: ${updatedMainOfficePc.currentBalance}`);
    
    console.log('\n🎉 All capital addition tests completed successfully!');
    console.log('\n💡 You can now:');
    console.log('   1. Login to the CBS company');
    console.log('   2. Go to Journal Entries page - you will see 3 new entries');
    console.log('   3. Go to Bank Accounts page - see BK Bank and MTN MoMo balances');
    console.log('   4. Go to Petty Cash page - see Main Office balance');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Test error:', err);
    process.exit(1);
  }
};

// Run the test
testCapitalAddition();
