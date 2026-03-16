const mongoose = require('mongoose');
const { generateUniqueCode } = require('./utils/autoIncrement');

const supplierSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Supplier must belong to a company']
  },
  name: {
    type: String,
    required: [true, 'Please provide a supplier name'],
    trim: true
  },
  code: {
    type: String,
    uppercase: true,
    trim: true
  },
  contact: {
    phone: String,
    email: {
      type: String,
      lowercase: true,
      trim: true
    },
    fax: String,
    website: String,
    address: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
    contactPerson: String
  },
  region: String,
  currency: String,
  leadTime: Number,
  minimumOrder: Number,
  bankName: String,
  bankAccount: String,
  productsSupplied: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  paymentTerms: {
    type: String,
    enum: ['cash', 'credit_7', 'credit_15', 'credit_30', 'credit_45', 'credit_60'],
    default: 'cash'
  },
  taxId: String,
  notes: String,
  isActive: {
    type: Boolean,
    default: true
  },
  totalPurchases: {
    type: Number,
    default: 0
  },
  lastPurchaseDate: Date,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound index for company + unique code
supplierSchema.index({ company: 1, code: 1 }, { unique: true });
supplierSchema.index({ company: 1 });

// Auto-generate supplier code
supplierSchema.pre('save', async function(next) {
  if (this.isNew) {
    if (!this.code) {
      // Auto-generate unique code if not provided
      this.code = await generateUniqueCode('SUP', mongoose.model('Supplier'), this.company, 'code');
    } else {
      // Check if provided code already exists for this company
      const existingSupplier = await mongoose.model('Supplier').findOne({
        company: this.company,
        code: this.code.toUpperCase()
      });
      
      if (existingSupplier) {
        // Auto-generate a new unique code instead of throwing error
        this.code = await generateUniqueCode('SUP', mongoose.model('Supplier'), this.company, 'code');
      }
    }
  }
  next();
});

module.exports = mongoose.model('Supplier', supplierSchema);
