/**
 * Platform Admin Seed Script
 * Run this once to create the default platform admin account
 * 
 * Usage: node scripts/seedPlatformAdmin.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const User = require('../models/User');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const seedPlatformAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('MongoDB Connected...');

    // Check if platform admin already exists
    const existingAdmin = await User.findOne({ role: 'platform_admin' });
    
    if (existingAdmin) {
      console.log('⚠️  Platform admin already exists!');
      console.log(`   Email: ${existingAdmin.email}`);
      console.log('   Use the existing credentials or reset password if needed.');
      process.exit(0);
    }

    // Create platform admin user
    const platformAdmin = await User.create({
      name: 'Platform Administrator',
      email: 'admin@stockmanager.com',
      password: 'admin123',
      role: 'platform_admin',
      company: null  // Platform admin has no company
    });

    console.log('✅ Platform admin created successfully!');
    console.log('\n📝 Platform Admin Credentials:');
    console.log('==============================');
    console.log('  Email: admin@stockmanager.com');
    console.log('  Password: admin123');
    console.log('\n⚠️  IMPORTANT: Change this password after first login!');
    console.log('\nThis account has full access to:');
    console.log('  - View all pending company registrations');
    console.log('  - Approve or reject company access');
    console.log('  - Platform-wide settings');

    process.exit(0);
  } catch (error) {
    console.error('Error creating platform admin:', error);
    process.exit(1);
  }
};

seedPlatformAdmin();
