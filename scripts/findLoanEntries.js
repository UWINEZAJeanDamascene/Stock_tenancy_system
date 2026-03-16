const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: __dirname + '/../.env' });

const JournalEntry = require('../models/JournalEntry');

async function findLoanEntries() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stock-management');
  console.log('MongoDB connected');

  // Find entries with 'loan' in description or sourceType
  const entries = await JournalEntry.find({
    $or: [
      { description: { $regex: /loan/i } },
      { sourceType: { $regex: /loan/i } }
    ]
  }).sort({ date: -1 });

  console.log(`Found ${entries.length} loan-related journal entries:`);
  
  // Group by entry number to find duplicates
  const byEntryNumber = {};
  entries.forEach(entry => {
    if (!byEntryNumber[entry.entryNumber]) {
      byEntryNumber[entry.entryNumber] = [];
    }
    byEntryNumber[entry.entryNumber].push(entry);
  });

  // Show duplicates
  Object.keys(byEntryNumber).forEach(num => {
    if (byEntryNumber[num].length > 1) {
      console.log(`\nDuplicate entry number: ${num} (${byEntryNumber[num].length} times)`);
      byEntryNumber[num].forEach(e => {
        console.log(`  - ID: ${e._id}, Date: ${e.date}, Description: ${e.description}, Total: ${e.totalDebit}`);
      });
    }
  });

  // Show all entries
  console.log('\n--- All Loan Entries ---');
  entries.forEach(entry => {
    console.log(`${entry.entryNumber} | ${entry.date?.toISOString().split('T')[0]} | ${entry.description} | Total: ${entry.totalDebit}`);
  });

  process.exit(0);
}

findLoanEntries().catch(e => {
  console.error(e);
  process.exit(1);
});
