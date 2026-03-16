// Migration script to update existing bank accounts with accountCode
// Run with: node Stock_tenancy_system/scripts/updateBankAccountCodes.js

const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/stock_tenancy';

// Account type to code mapping
const typeToCode = {
  'bk_bank': '1100',
  'equity_bank': '1100',
  'im_bank': '1100',
  'cogebanque': '1100',
  'ecobank': '1100',
  'mtn_momo': '1200',
  'airtel_money': '1200',
  'cash_in_hand': '1000'
};

async function migrate() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    // Get the BankAccount model
    const db = mongoose.connection.db;
    const bankAccounts = db.collection('bankaccounts');

    // Find all bank accounts without accountCode or with wrong accountCode
    const accounts = await bankAccounts.find({ 
      $or: [
        { accountCode: { $exists: false } },
        { accountCode: null },
        { accountCode: { $eq: '' } }
      ]
    }).toArray();

    console.log(`Found ${accounts.length} bank accounts without accountCode`);

    let updatedCount = 0;
    for (const account of accounts) {
      const newCode = typeToCode[account.accountType] || '1100';
      
      await bankAccounts.updateOne(
        { _id: account._id },
        { $set: { accountCode: newCode } }
      );
      
      console.log(`Updated ${account.name} (${account.accountType}) -> accountCode: ${newCode}`);
      updatedCount++;
    }

    console.log(`\nMigration complete! Updated ${updatedCount} bank accounts.`);
    
    // Also update any accounts that have the wrong code
    const wrongAccounts = await bankAccounts.find({
      accountCode: { $exists: true, $ne: '' }
    }).toArray();
    
    let fixedCount = 0;
    for (const account of wrongAccounts) {
      const correctCode = typeToCode[account.accountType] || '1100';
      if (account.accountCode !== correctCode) {
        await bankAccounts.updateOne(
          { _id: account._id },
          { $set: { accountCode: correctCode } }
        );
        console.log(`Fixed ${account.name}: ${account.accountCode} -> ${correctCode}`);
        fixedCount++;
      }
    }
    
    if (fixedCount > 0) {
      console.log(`\nFixed ${fixedCount} bank accounts with wrong accountCode.`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
