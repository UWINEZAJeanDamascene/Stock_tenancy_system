/**
 * Approve All Pending Companies Script
 * Run this once to approve all pending companies
 * 
 * Usage: node scripts/approveAllCompanies.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const Company = require('../models/Company');
const User = require('../models/User');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const approveAllCompanies = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);

    console.log('MongoDB Connected...');

    // Find all pending companies
    const pendingCompanies = await Company.find({ approvalStatus: 'pending' });
    
    if (pendingCompanies.length === 0) {
      console.log('⚠️  No pending companies found!');
      process.exit(0);
    }

    console.log(`Found ${pendingCompanies.length} pending companies:`);
    
    // Approve each company
    for (const company of pendingCompanies) {
      company.approvalStatus = 'approved';
      company.approvedBy = null;
      company.approvedAt = new Date();
      await company.save();
      console.log(`  ✅ Approved: ${company.name} (${company.email})`);
    }

    console.log(`\n✅ All ${pendingCompanies.length} companies have been approved!`);
    console.log('\nUsers can now log in and access their data.');

    process.exit(0);
  } catch (error) {
    console.error('Error approving companies:', error);
    process.exit(1);
  }
};

approveAllCompanies();
