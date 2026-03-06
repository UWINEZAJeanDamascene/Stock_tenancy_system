const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // Mongoose v6+ enables the new topology engine by default.
    // Remove deprecated options to avoid driver warnings.
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);
    
    // Connection events
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected');
    });

    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      console.log('MongoDB connection closed through app termination');
      process.exit(0);
    });

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
