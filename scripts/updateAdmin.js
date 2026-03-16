const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const User = require('../models/User');

// Load environment variables from the correct path
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const updateAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('MongoDB Connected...');

    // First, delete any existing user with this email
    await User.deleteOne({ email: 'jayfcode@gmail.com' });
    console.log('Removed existing jayfcode@gmail.com user if any');

    // Create new admin user - let the model's pre-save hook handle password hashing
    const admin = await User.create({
      name: 'Admin User',
      email: 'jayfcode@gmail.com',
      password: 'admin123',
      role: 'admin'
    });

    console.log('✅ Admin user created successfully!');
    console.log('Email:', admin.email);
    console.log('Password: admin123');

    // Verify by finding the user
    const verifyUser = await User.findOne({ email: 'jayfcode@gmail.com' }).select('+password');
    console.log('\n📋 User verification:');
    console.log('Name:', verifyUser.name);
    console.log('Email:', verifyUser.email);
    console.log('Role:', verifyUser.role);
    
    // Test password
    const isMatch = await verifyUser.comparePassword('admin123');
    console.log('Password test (admin123):', isMatch ? '✅ PASSED' : '❌ FAILED');

    process.exit(0);
  } catch (error) {
    console.error('Error updating admin:', error);
    process.exit(1);
  }
};

updateAdmin();
