const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const JournalEntry = require('../models/JournalEntry');
  const Company = require('../models/Company');

  console.log('Running trial-balance smoke check for each company');
  console.log('===============================================');

  const companies = await Company.find({});
  for (const company of companies) {
    const now = new Date();
    // Use a wide range covering all entries
    const startDate = new Date('2000-01-01');
    const endDate = now;

    const balances = await JournalEntry.getTrialBalance(company._id, startDate, endDate);
    const codes = Object.keys(balances || {});
    console.log(`${company.name}: ${codes.length} accounts in trial balance`);
    if (codes.includes('3000')) {
      const acc = balances['3000'];
      console.log(`  - Found 3000: debit=${acc.debit}, credit=${acc.credit}, balance=${acc.balance}`);
    } else {
      console.log('  - Account 3000 not present in trial balance');
    }
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
