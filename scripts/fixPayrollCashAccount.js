/**
 * Migration Script: Fix Payroll Journal Entries - Cash in Hand to Cash at Bank
 * 
 * This script finds all payroll journal entries that used Cash in Hand (1000)
 * and updates them to use Cash at Bank (1100) instead.
 * 
 * Run with: node scripts/fixPayrollCashAccount.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const JournalEntry = require('../models/JournalEntry');

// Connect to MongoDB
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stockmanagement');
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error('Database connection failed:', error.message);
    process.exit(1);
  }
};

async function fixPayrollCashAccount() {
  console.log('=== Fixing Payroll Journal Entries: Cash in Hand → Cash at Bank ===\n');
  
  try {
    // Find all payroll journal entries that have Cash in Hand (1000) as credit
    const entries = await JournalEntry.find({
      sourceType: 'payroll',
      'lines.accountCode': '1000',
      'lines.credit': { $gt: 0 }
    });

    console.log(`Found ${entries.length} payroll journal entries with Cash in Hand`);

    let fixedCount = 0;

    for (const entry of entries) {
      try {
        // Find the line with Cash in Hand (1000)
        const cashLineIndex = entry.lines.findIndex(
          line => line.accountCode === '1000' && line.credit > 0
        );

        if (cashLineIndex !== -1) {
          // Update the account code from 1000 to 1100
          entry.lines[cashLineIndex].accountCode = '1100';
          entry.lines[cashLineIndex].accountName = 'Cash at Bank';
          
          await entry.save();
          
          console.log(`\n✅ Fixed entry ${entry.entryNumber}`);
          console.log(`   Changed Cash in Hand (1000) → Cash at Bank (1100)`);
          console.log(`   Amount: ${entry.lines[cashLineIndex].credit}`);
          
          fixedCount++;
        }
      } catch (saveError) {
        console.error(`\n❌ Error fixing entry ${entry.entryNumber}:`, saveError.message);
      }
    }

    console.log('\n=== Summary ===');
    console.log(`Total payroll entries found: ${entries.length}`);
    console.log(`Entries fixed: ${fixedCount}`);
    console.log('\n=== Migration Complete ===');

  } catch (error) {
    console.error('Error during migration:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  }
}

// Run if called directly
if (require.main === module) {
  connectDB().then(() => {
    fixPayrollCashAccount();
  });
}

module.exports = fixPayrollCashAccount;
