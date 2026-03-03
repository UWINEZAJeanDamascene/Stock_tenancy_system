/**
 * Set CTR Company to Pending Script
 * Set the CTR company back to pending status for testing
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const Company = require('../models/Company');

dotenv.config();

const setPending = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB Connected...');

    const company = await Company.findOne({ name: 'CTR' });
    if (!company) {
      console.log('Company CTR not found!');
      process.exit(1);
    }

    console.log(`Found company: ${company.name} (${company.email})`);
    console.log(`Current status: approvalStatus=${company.approvalStatus}`);

    company.approvalStatus = 'pending';
    company.approvedAt = null;
    await company.save();

    console.log(`\n✅ Company CTR has been set to pending!`);
    console.log('Now users cannot log in until the company is approved.');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

setPending();
