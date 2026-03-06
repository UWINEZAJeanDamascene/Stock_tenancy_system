const mongoose = require('mongoose');

const serialNumberSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Serial number must belong to a company']
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  warehouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Warehouse'
  },
  serialNumber: {
    type: String,
    required: [true, 'Please provide a serial number'],
    trim: true,
    uppercase: true
  },
  // Status: available, sold, in_use, returned, damaged, under_warranty, retired
  status: {
    type: String,
    enum: ['available', 'sold', 'in_use', 'returned', 'damaged', 'under_warranty', 'retired'],
    default: 'available'
  },
  // Purchase info
  purchaseDate: {
    type: Date
  },
  purchasePrice: {
    type: Number,
    min: 0
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  invoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  stockMovement: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StockMovement'
  },
  // Sale info
  saleDate: {
    type: Date
  },
  salePrice: {
    type: Number,
    min: 0
  },
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client'
  },
  // Warranty info
  warrantyStartDate: {
    type: Date
  },
  warrantyEndDate: {
    type: Date
  },
  warrantyDetails: String,
  // Additional info
  manufacturingDate: {
    type: Date
  },
  notes: String,
  // For tracking history
  locationHistory: [{
    warehouse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse'
    },
    status: String,
    date: {
      type: Date,
      default: Date.now
    },
    notes: String
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound indexes for efficient querying
serialNumberSchema.index({ company: 1, serialNumber: 1 }, { unique: true });
serialNumberSchema.index({ company: 1, product: 1 });
serialNumberSchema.index({ company: 1, warehouse: 1 });
serialNumberSchema.index({ company: 1, status: 1 });
serialNumberSchema.index({ product: 1, status: 1 });
serialNumberSchema.index({ warrantyEndDate: 1 });

// Virtual for checking if warranty is active
serialNumberSchema.virtual('isWarrantyActive').get(function() {
  if (!this.warrantyEndDate) return false;
  return new Date() <= this.warrantyEndDate;
});

// Pre-save to add location history when warehouse changes
serialNumberSchema.pre('save', function(next) {
  if (this.isModified('warehouse') && this.warehouse) {
    this.locationHistory.push({
      warehouse: this.warehouse,
      status: this.status,
      date: new Date()
    });
  }
  next();
});

// Static method to find available serial numbers for a product
serialNumberSchema.statics.findAvailable = function(productId, companyId) {
  return this.find({
    product: productId,
    company: companyId,
    status: 'available'
  });
};

// Static method to find by serial number
serialNumberSchema.statics.findBySerial = function(serialNumber, companyId) {
  return this.findOne({
    serialNumber: serialNumber.toUpperCase(),
    company: companyId
  });
};

// Set toJSON and toObject to include virtuals
serialNumberSchema.set('toJSON', { virtuals: true });
serialNumberSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('SerialNumber', serialNumberSchema);
