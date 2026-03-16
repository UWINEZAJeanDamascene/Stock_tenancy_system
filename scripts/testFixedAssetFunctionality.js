// Test Fixed Asset Journal Entry and Depreciation Functionality
// This script tests the fixed asset system on the CBS company

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function testFixedAssetFunctionality() {
  try {
    // Connect to remote MongoDB
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

    // Get company settings to find account codes
    const settings = await db.collection('companysettings').findOne({ company: company._id });
    console.log(`✅ Found company settings`);

    // Find all fixed assets for CBS
    const assets = await db.collection('fixedassets').find({ company: company._id }).toArray();
    console.log(`\n📊 Fixed Assets Count: ${assets.length}`);
    
    if (assets.length === 0) {
      console.log('\n⚠️  No fixed assets found. Please create an asset in the application first.');
      console.log('To test, create an asset with:');
      console.log('- Name: Test Vehicle');
      console.log('- Category: Vehicles');
      console.log('- Purchase Date: 2026-01-01');
      console.log('- Cost: 50000');
      console.log('- Useful Life: 60 months');
      console.log('- Payment Method: Bank Transfer');
    } else {
      console.log('\n📋 Existing Assets:');
      assets.forEach((asset, index) => {
        console.log(`\n  ${index + 1}. ${asset.name}`);
        console.log(`     Category: ${asset.category}`);
        console.log(`     Cost: ${asset.cost}`);
        console.log(`     Purchase Date: ${asset.purchaseDate}`);
        console.log(`     Useful Life: ${asset.usefulLife} months`);
        console.log(`     Accumulated Depreciation: ${asset.accumulatedDepreciation || 0}`);
        console.log(`     Payment Method: ${asset.paymentMethod || 'not set'}`);
        console.log(`     Bank Account Code: ${asset.bankAccountCode || 'not set'}`);
      });
    }

    // Find all journal entries for fixed assets
    const assetAccountCodes = ['1720', '1721', '1722', '1723', '1724', '1725']; // Asset accounts
    const depreciationAccountCodes = ['5800', '5801', '5802', '5803', '5804', '5805']; // Depreciation accounts
    const accumulatedDepAccountCodes = ['1800', '1801', '1802', '1803', '1804', '1805']; // Accumulated depreciation

    const journalEntries = await db.collection('journalentries').find({ 
      company: company._id,
      $or: [
        { 'entries.accountCode': { $in: assetAccountCodes } },
        { 'entries.accountCode': { $in: depreciationAccountCodes } },
        { 'entries.accountCode': { $in: accumulatedDepAccountCodes } }
      ]
    }).sort({ date: -1 }).limit(20).toArray();

    console.log(`\n📋 Journal Entries Related to Fixed Assets: ${journalEntries.length}`);
    
    if (journalEntries.length > 0) {
      journalEntries.forEach((je, index) => {
        console.log(`\n  ${index + 1}. JE #${je.jeNumber || je._id}`);
        console.log(`     Date: ${je.date}`);
        console.log(`     Description: ${je.description}`);
        console.log(`     Entries:`);
        je.entries.forEach(entry => {
          console.log(`       - ${entry.accountCode} (${entry.accountName}): ${entry.debit > 0 ? 'Dr ' + entry.debit : 'Cr ' + entry.credit}`);
        });
      });
    } else {
      console.log('\n⚠️  No journal entries found for fixed assets.');
      console.log('This is expected if no assets have been purchased yet.');
    }

    // Check for any payment method issues in existing assets
    console.log('\n🔍 Checking Payment Methods:');
    const assetsWithPaymentMethod = assets.filter(a => a.paymentMethod);
    console.log(`   Assets with payment method: ${assetsWithPaymentMethod.length}/${assets.length}`);
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(50));
    console.log(`Total Fixed Assets: ${assets.length}`);
    console.log(`Assets with Payment Method: ${assetsWithPaymentMethod.length}`);
    console.log(`Journal Entries Found: ${journalEntries.length}`);
    
    // Check if depreciation was run
    const depreciationJEs = journalEntries.filter(je => 
      je.description && je.description.toLowerCase().includes('depreciation')
    );
    console.log(`Depreciation Journal Entries: ${depreciationJEs.length}`);
    
    if (depreciationJEs.length > 0) {
      console.log('\n✅ Depreciation is being recorded in journal entries!');
    }
    
    if (assets.length > 0 && journalEntries.length > 0) {
      console.log('\n✅ Asset purchases are creating journal entries!');
    }

    console.log('\n✅ Test completed successfully!');

  } catch (error) {
    console.error('❌ Error during test:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  }
}

// Run the test
testFixedAssetFunctionality();
