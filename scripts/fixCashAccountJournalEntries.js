/**
 * Fix Script: Correct Cash Account in Journal Entries
 * 
 * This script fixes journal entries that were incorrectly using Cash in Hand (1000)
 * instead of Cash at Bank (1100) for bank_transfer payments.
 * 
 * Run with: node scripts/fixCashAccountJournalEntries.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected...'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// Journal Entry Schema (minimal)
const JournalEntrySchema = new mongoose.Schema({
  company: mongoose.Schema.Types.ObjectId,
  entryNumber: String,
  description: String,
  lines: [{
    accountCode: String,
    accountName: String,
    debit: Number,
    credit: Number
  }],
  totalDebit: Number,
  totalCredit: Number
}, { timestamps: true });

const JournalEntry = mongoose.model('JournalEntry', JournalEntrySchema, 'journalentries');

async function fixCashAccountEntries() {
  try {
    console.log('\n🔧 Starting Cash Account Fix...\n');

    // Find all journal entries that have Cash in Hand (1000) in their lines
    // and contain keywords like 'payment', 'purchase', 'refund' (not received)
    const entries = await JournalEntry.find({
      'lines.accountCode': '1000',
      $or: [
        { description: { $regex: /payment/i } },
        { description: { $regex: /purchase/i } },
        { description: { $regex: /paid/i } },
        { description: { $regex: /refund/i } },
        { description: { $regex: /expense/i } }
      ]
    });

    console.log(`Found ${entries.length} entries with Cash in Hand (1000) that might need fixing`);

    let fixedCount = 0;
    let alreadyCorrectCount = 0;
    let skipCount = 0;

    for (const entry of entries) {
      let wasFixed = false;
      
      // Check each line in the entry
      for (const line of entry.lines) {
        // If this line is Cash in Hand (1000) and has a debit or credit (meaning it's the cash account)
        if (line.accountCode === '1000' && (line.debit > 0 || line.credit > 0)) {
          
          // Check if there's already a line with Cash at Bank (1100) for this entry
          const hasBankAccount = entry.lines.some(l => l.accountCode === '1100');
          
          if (!hasBankAccount) {
            // Change from Cash in Hand to Cash at Bank
            line.accountCode = '1100';
            line.accountName = 'Cash at Bank';
            wasFixed = true;
          } else {
            // There's already a Bank account, remove this Cash in Hand line
            line.accountCode = null;
            line.accountName = null;
            line.debit = 0;
            line.credit = 0;
            wasFixed = true;
          }
        }
      }

      if (wasFixed) {
        // Remove null lines and recalculate totals
        entry.lines = entry.lines.filter(l => l.accountCode !== null);
        entry.totalDebit = entry.lines.reduce((sum, l) => sum + (l.debit || 0), 0);
        entry.totalCredit = entry.lines.reduce((sum, l) => sum + (l.credit || 0), 0);
        
        await entry.save();
        fixedCount++;
        console.log(`  ✅ Fixed: ${entry.entryNumber} - ${entry.description}`);
      } else {
        alreadyCorrectCount++;
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📈 FIX SUMMARY');
    console.log('='.repeat(50));
    console.log(`Entries fixed: ${fixedCount}`);
    console.log(`Entries already correct: ${alreadyCorrectCount}`);
    console.log('\n✅ Cash Account Fix completed successfully!');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

fixCashAccountEntries();
