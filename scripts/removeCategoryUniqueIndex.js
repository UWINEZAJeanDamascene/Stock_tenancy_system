#!/usr/bin/env node
const mongoose = require('mongoose');

(async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error('Please set MONGODB_URI environment variable before running this script.');
      process.exit(1);
    }

    await mongoose.connect(uri);
    const collection = mongoose.connection.collection('categories');
    const indexes = await collection.indexes();

    const target = indexes.find(i => {
      const k = i.key || {};
      return k.company === 1 && k.name === 1;
    });

    if (!target) {
      console.log('No company+name index found on categories collection. Nothing to drop.');
      await mongoose.connection.close();
      process.exit(0);
    }

    console.log('Found index:', target.name, '- dropping it...');
    await collection.dropIndex(target.name);
    console.log('Dropped index', target.name);

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('Error while dropping index:', err);
    try { await mongoose.connection.close(); } catch (e) {}
    process.exit(1);
  }
})();
