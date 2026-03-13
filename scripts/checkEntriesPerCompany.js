const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const JournalEntry = require('../models/JournalEntry');
  const Company = require('../models/Company');
  
  console.log('Journal Entries per Company:');
  console.log('============================');
  
  const companies = await Company.find({});
  
  for (const company of companies) {
    const count = await JournalEntry.countDocuments({ company: company._id });
    const posted = await JournalEntry.countDocuments({ company: company._id, status: 'posted' });
    console.log(`${company.name}: ${posted} posted entries (${count} total)`);
  }
  
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
