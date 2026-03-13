const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const JournalEntry = require('../models/JournalEntry');
  const Company = require('../models/Company');

  console.log('Searching for posted JournalEntry lines with accountCode "3000"');
  console.log('==============================================================');

  const companies = await Company.find({});
  for (const company of companies) {
    const entries = await JournalEntry.find({ company: company._id, status: 'posted', 'lines.accountCode': '3000' }).lean();
    if (!entries || entries.length === 0) {
      console.log(`${company.name}: 0 posted entries with accountCode 3000`);
    } else {
      console.log(`${company.name}: ${entries.length} posted entries with accountCode 3000`);
      // print brief summary of each entry
      entries.forEach(e => {
        const lines = e.lines.filter(l => l.accountCode === '3000');
        console.log(`  - Entry ${e.entryNumber} (${new Date(e.date).toISOString().split('T')[0]}):`);
        lines.forEach(l => console.log(`      ${l.accountCode} ${l.accountName} D:${l.debit} C:${l.credit} ref:${l.reference || ''}`));
      });
    }
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
