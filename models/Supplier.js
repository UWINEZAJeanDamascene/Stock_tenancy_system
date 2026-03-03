const mongoose = require('mongoose');

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
    address: String,
    city: String,
    country: String
  },
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
  if (this.isNew && !this.code) {
    const count = await mongoose.model('Supplier').countDocuments({ company: this.company });
    this.code = `SUP${String(count + 1).padStart(5, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Supplier', supplierSchema);
