const mongoose = require('mongoose');
const { generateUniqueCode } = require('./utils/autoIncrement');

const warehouseSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Warehouse must belong to a company']
  },
  name: {
    type: String,
    required: [true, 'Please provide a warehouse name'],
    trim: true
  },
  code: {
    type: String,
    uppercase: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  location: {
    address: String,
    city: String,
    country: String,
    contactPerson: String,
    phone: String,
    email: String
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  // Track total stock value and quantity in this warehouse
  totalProducts: {
    type: Number,
    default: 0
  },
  totalValue: {
    type: Number,
    default: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound index for company + unique code
warehouseSchema.index({ company: 1, code: 1 }, { unique: true });
warehouseSchema.index({ company: 1 });

// Auto-generate warehouse code
warehouseSchema.pre('save', async function(next) {
  if (this.isNew) {
    if (!this.code) {
      // Auto-generate unique code if not provided
      this.code = await generateUniqueCode('WH', mongoose.model('Warehouse'), this.company, 'code');
    } else {
      // Check if provided code already exists for this company
      const existingWarehouse = await mongoose.model('Warehouse').findOne({
        company: this.company,
        code: this.code.toUpperCase()
      });
      
      if (existingWarehouse) {
        // Auto-generate a new unique code instead of throwing error
        this.code = await generateUniqueCode('WH', mongoose.model('Warehouse'), this.company, 'code');
      }
    }
    
    // If this is the first warehouse, make it default
    const count = await mongoose.model('Warehouse').countDocuments({ company: this.company });
    if (count === 0) {
      this.isDefault = true;
    }
  }
  next();
});

// Prevent setting more than one default warehouse
warehouseSchema.pre('save', async function(next) {
  if (this.isDefault && this.isModified('isDefault')) {
    await mongoose.model('Warehouse').updateMany(
      { company: this.company, _id: { $ne: this._id } },
      { isDefault: false }
    );
  }
  next();
});

module.exports = mongoose.model('Warehouse', warehouseSchema);
