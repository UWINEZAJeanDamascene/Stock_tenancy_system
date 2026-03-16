// Test: Check Bank Accounts and Verify Asset Fields
// This script checks what bank accounts exist in CBS and verifies the asset model

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function testAssetAndBankAccounts() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://DBuser:dbuserlily@stock.korqjvo.mongodb.net/';
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    const db = mongoose.connection;

    // Find CBS company
    const company = await db.collection('companies').findOne({ name: 'CBS' });
    if (!company) {
      console.log('❌ CBS company not found');
      process.exit(1);
    }
    console.log(`✅ Found company: ${company.name} (ID: ${company._id})`);

    // Check bank accounts
    console.log('\n📋 Bank Accounts:');
    const bankAccounts = await db.collection('bankaccounts').find({ company: company._id }).toArray();
    console.log(`   Total: ${bankAccounts.length}`);
    bankAccounts.forEach((ba, index) => {
      console.log(`   ${index + 1}. ${ba.name} - Code: ${ba.accountCode}, Type: ${ba.accountType}`);
    });

    // Check MOMO accounts
    console.log('\n📋 MOMO Accounts:');
    const momoAccounts = await db.collection('bankaccounts').find({ 
      company: company._id, 
      accountType: 'mobile_money' 
    }).toArray();
    console.log(`   Total: ${momoAccounts.length}`);
    momoAccounts.forEach((ma, index) => {
      console.log(`   ${index + 1}. ${ma.name} - Code: ${ma.accountCode}`);
    });

    // Check fixed assets
    console.log('\n📋 Fixed Assets:');
    const assets = await db.collection('fixedassets').find({ company: company._id }).toArray();
    console.log(`   Total: ${assets.length}`);
    assets.forEach((asset, index) => {
      console.log(`   ${index + 1}. ${asset.name}`);
      console.log(`      Category: ${asset.category}`);
      console.log(`      Cost: ${asset.purchaseCost || asset.cost}`);
      console.log(`      Payment Method: ${asset.paymentMethod || 'not set'}`);
      console.log(`      Bank Account Code: ${asset.bankAccountCode || 'not set'}`);
      console.log(`      Accumulated Depreciation: ${asset.accumulatedDepreciation || 0}`);
    });

    // Check journal entries for assets
    console.log('\n📋 Journal Entries (Assets):');
    const assetJE = await db.collection('journalentries').find({ 
      company: company._id,
      description: { $regex: /asset|Asset/ }
    }).sort({ date: -1 }).limit(10).toArray();
    console.log(`   Total: ${assetJE.length}`);
    assetJE.forEach((je, index) => {
      console.log(`   ${index + 1}. ${je.description}`);
      console.log(`      Date: ${je.date}`);
      if (je.lines) {
        je.lines.forEach(line => {
          console.log(`      ${line.accountCode} - ${line.accountName}: Dr ${line.debit || 0}, Cr ${line.credit || 0}`);
        });
      }
    });

    // Check depreciation journal entries
    console.log('\n📋 Depreciation Journal Entries:');
    const depJE = await db.collection('journalentries').find({ 
      company: company._id,
      description: { $regex: /depreciation|Depreciation/ }
    }).sort({ date: -1 }).limit(10).toArray();
    console.log(`   Total: ${depJE.length}`);
    depJE.forEach((je, index) => {
      console.log(`   ${index + 1}. ${je.description}`);
      console.log(`      Date: ${je.date}`);
      if (je.lines) {
        je.lines.forEach(line => {
          console.log(`      ${line.accountCode} - ${line.accountName}: Dr ${line.debit || 0}, Cr ${line.credit || 0}`);
        });
      }
    });

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 SUMMARY');
    console.log('='.repeat(50));
    console.log(`Bank Accounts: ${bankAccounts.length}`);
    console.log(`MOMO Accounts: ${momoAccounts.length}`);
    console.log(`Fixed Assets: ${assets.length}`);
    console.log(`Asset Journal Entries: ${assetJE.length}`);
    console.log(`Depreciation Journal Entries: ${depJE.length}`);

    if (assets.length > 0 && assetJE.length === 0) {
      console.log('\n⚠️  WARNING: Assets exist but no journal entries found!');
      console.log('This means the journal entry is not being created when assets are saved.');
    }

    if (assets.length > 0 && depJE.length > 0) {
      console.log('\n✅ Depreciation is being recorded in journal entries!');
    }

    console.log('\n✅ Test completed!');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  }
}

testAssetAndBankAccounts();
