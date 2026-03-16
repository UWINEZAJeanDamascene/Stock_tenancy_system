const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Client = require('../models/Client');

dotenv.config();

const seedData = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('MongoDB Connected...');

    // Clear existing data
    console.log('Clearing existing data...');
    await User.deleteMany({});
    await Category.deleteMany({});
    await Product.deleteMany({});
    await Supplier.deleteMany({});
    await Client.deleteMany({});

    console.log('Creating admin user...');
    const admin = await User.create({
      name: 'Admin User',
      email: 'jayfcode@gmail.com',
      password: 'admin123',
      role: 'admin'
    });

    console.log('Creating categories...');
    const categories = await Category.create([
      {
        name: 'Building Materials',
        description: 'Construction and building materials',
        createdBy: admin._id
      },
      {
        name: 'Tools & Equipment',
        description: 'Construction tools and equipment',
        createdBy: admin._id
      },
      {
        name: 'Electrical',
        description: 'Electrical supplies and components',
        createdBy: admin._id
      },
      {
        name: 'Plumbing',
        description: 'Plumbing supplies and fixtures',
        createdBy: admin._id
      },
      {
        name: 'Hardware',
        description: 'General hardware items',
        createdBy: admin._id
      }
    ]);

    console.log('Creating suppliers...');
    const suppliers = await Supplier.create([
      {
        name: 'ABC Building Supplies',
        contact: {
          phone: '+1234567890',
          email: 'abc@supplies.com',
          address: '123 Main Street',
          city: 'New York',
          country: 'USA'
        },
        paymentTerms: 'credit_30',
        createdBy: admin._id
      },
      {
        name: 'Quality Materials Ltd',
        contact: {
          phone: '+0987654321',
          email: 'quality@materials.com',
          address: '456 Oak Avenue',
          city: 'Los Angeles',
          country: 'USA'
        },
        paymentTerms: 'credit_45',
        createdBy: admin._id
      },
      {
        name: 'Professional Tools Inc',
        contact: {
          phone: '+1122334455',
          email: 'tools@professional.com',
          address: '789 Pine Road',
          city: 'Chicago',
          country: 'USA'
        },
        paymentTerms: 'credit_30',
        createdBy: admin._id
      }
    ]);

    console.log('Creating clients...');
    const clients = await Client.create([
      {
        name: 'XYZ Construction',
        type: 'company',
        contact: {
          phone: '+5566778899',
          email: 'xyz@construction.com',
          address: '321 Elm Street',
          city: 'Houston',
          country: 'USA'
        },
        paymentTerms: 'credit_30',
        creditLimit: 50000,
        createdBy: admin._id
      },
      {
        name: 'John Builder',
        type: 'individual',
        contact: {
          phone: '+6677889900',
          email: 'john@builder.com',
          address: '654 Maple Drive',
          city: 'Miami',
          country: 'USA'
        },
        paymentTerms: 'cash',
        creditLimit: 10000,
        createdBy: admin._id
      },
      {
        name: 'Modern Homes Ltd',
        type: 'company',
        contact: {
          phone: '+7788990011',
          email: 'modern@homes.com',
          address: '987 Cedar Lane',
          city: 'Seattle',
          country: 'USA'
        },
        paymentTerms: 'credit_45',
        creditLimit: 100000,
        createdBy: admin._id
      }
    ]);

    console.log('Creating products...');
    const products = await Product.create([
      {
        name: 'Portland Cement 50kg',
        sku: 'CEM001',
        description: 'High quality Portland cement in 50kg bags',
        category: categories[0]._id,
        unit: 'bag',
        lowStockThreshold: 50,
        createdBy: admin._id
      },
      {
        name: 'Steel Rebar 12mm',
        sku: 'REB012',
        description: 'Steel reinforcement bars 12mm diameter',
        category: categories[0]._id,
        unit: 'pcs',
        lowStockThreshold: 100,
        createdBy: admin._id
      },
      {
        name: 'Concrete Blocks',
        sku: 'BLK001',
        description: 'Standard concrete blocks',
        category: categories[0]._id,
        unit: 'pcs',
        lowStockThreshold: 200,
        createdBy: admin._id
      },
      {
        name: 'Power Drill Set',
        sku: 'DRL001',
        description: 'Professional cordless power drill with accessories',
        category: categories[1]._id,
        unit: 'set',
        lowStockThreshold: 10,
        createdBy: admin._id
      },
      {
        name: 'Circular Saw',
        sku: 'SAW001',
        description: 'Heavy duty circular saw',
        category: categories[1]._id,
        unit: 'pcs',
        lowStockThreshold: 5,
        createdBy: admin._id
      },
      {
        name: 'Electrical Wire 2.5mm',
        sku: 'WIR025',
        description: 'Electrical copper wire 2.5mm',
        category: categories[2]._id,
        unit: 'roll',
        lowStockThreshold: 20,
        createdBy: admin._id
      },
      {
        name: 'LED Bulb 12W',
        sku: 'LED012',
        description: 'Energy efficient LED bulb 12 watts',
        category: categories[2]._id,
        unit: 'pcs',
        lowStockThreshold: 50,
        createdBy: admin._id
      },
      {
        name: 'PVC Pipe 1 inch',
        sku: 'PVC001',
        description: 'PVC plumbing pipe 1 inch diameter',
        category: categories[3]._id,
        unit: 'm',
        lowStockThreshold: 100,
        createdBy: admin._id
      },
      {
        name: 'Faucet Set',
        sku: 'FAU001',
        description: 'Chrome plated bathroom faucet set',
        category: categories[3]._id,
        unit: 'set',
        lowStockThreshold: 15,
        createdBy: admin._id
      },
      {
        name: 'Nails 3 inch',
        sku: 'NAI003',
        description: 'Steel nails 3 inches',
        category: categories[4]._id,
        unit: 'kg',
        lowStockThreshold: 30,
        createdBy: admin._id
      },
      {
        name: 'Wood Screws Set',
        sku: 'SCR001',
        description: 'Assorted wood screws set',
        category: categories[4]._id,
        unit: 'box',
        lowStockThreshold: 25,
        createdBy: admin._id
      },
      {
        name: 'Paint White 5L',
        sku: 'PNT005W',
        description: 'White interior paint 5 liters',
        category: categories[0]._id,
        unit: 'l',
        lowStockThreshold: 40,
        createdBy: admin._id
      }
    ]);

    // Create additional users
    console.log('Creating additional users...');
    await User.create([
      {
        name: 'Stock Manager',
        email: 'stock@stock.com',
        password: 'stock123',
        role: 'stock_manager',
        createdBy: admin._id
      },
      {
        name: 'Sales Person',
        email: 'sales@stock.com',
        password: 'sales123',
        role: 'sales',
        createdBy: admin._id
      },
      {
        name: 'Viewer User',
        email: 'viewer@stock.com',
        password: 'viewer123',
        role: 'viewer',
        createdBy: admin._id
      }
    ]);

    console.log('✅ Seed data created successfully!');
    console.log('\n📝 Default Users Created:');
    console.log('=======================');
    console.log('Admin:');
    console.log('  Email: jayfcode@gmail.com');
    console.log('  Password: admin123');
    console.log('\nStock Manager:');
    console.log('  Email: stock@stock.com');
    console.log('  Password: stock123');
    console.log('\nSales Person:');
    console.log('  Email: sales@stock.com');
    console.log('  Password: sales123');
    console.log('\nViewer:');
    console.log('  Email: viewer@stock.com');
    console.log('  Password: viewer123');
    console.log('\n📊 Data Summary:');
    console.log('=======================');
    console.log(`Categories: ${categories.length}`);
    console.log(`Products: ${products.length}`);
    console.log(`Suppliers: ${suppliers.length}`);
    console.log(`Clients: ${clients.length}`);
    console.log('\n✨ You can now start the server and login!');

    process.exit(0);
  } catch (error) {
    console.error('Error seeding data:', error);
    process.exit(1);
  }
};

seedData();
