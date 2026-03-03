/**
 * Check Users and Companies Script
 * Check the status of users and companies in the database
 * 
 * Usage: node scripts/checkUsers.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const Company = require('../models/Company');
const User = require('../models/User');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const checkData = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);

    console.log('MongoDB Connected...\n');

    // Check companies
    const companies = await Company.find({});
    console.log(`Companies (${companies.length}):`);
    for (const c of companies) {
      console.log(`  - ${c.name} (${c.email})`);
      console.log(`    isActive: ${c.isActive}, approvalStatus: ${c.approvalStatus}`);
    }

    console.log('\n');

    // Check users
    const users = await User.find({}).populate('company');
    console.log(`Users (${users.length}):`);
    for (const u of users) {
      console.log(`  - ${u.name} (${u.email})`);
      console.log(`    role: ${u.role}, isActive: ${u.isActive}`);
      console.log(`    company: ${u.company ? u.company.name : 'None'}`);
      if (u.company) {
        console.log(`    company approvalStatus: ${u.company.approvalStatus}`);
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

checkData();
