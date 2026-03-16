const mongoose = require('mongoose');
const { generateUniqueNumber } = require('./utils/autoIncrement');

const deliveryNoteItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  productName: {
    type: String,
    required: true
  },
  itemCode: String,
  unit: String,
  orderedQty: {
    type: Number,
    required: true,
    min: 0
  },
  deliveredQty: {
    type: Number,
    required: true,
    min: 0
  },
  pendingQty: {
    type: Number,
    default: 0
  },
  notes: String
});

const deliveryNoteSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Delivery note must belong to a company']
  },
  deliveryNumber: {
    type: String,
    uppercase: true
  },
  
  // References
  quotation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quotation'
  },
  invoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  
  // Parties
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company'
  },
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  
  // Client details captured at delivery time
  customerTin: String,
  customerName: String,
  customerAddress: String,
  
  // Dates
  deliveryDate: {
    type: Date,
    default: Date.now
  },
  expectedDate: Date,
  receivedDate: Date,
  
  // Delivery details
  deliveredBy: String,
  vehicle: String,
  deliveryAddress: String,
  
  // Items
  items: [deliveryNoteItemSchema],
  
  // Status
  status: {
    type: String,
    enum: ['draft', 'dispatched', 'delivered', 'partial', 'failed', 'cancelled'],
    default: 'draft'
  },
  
  // Client confirmation
  receivedBy: String,
  clientSignature: String, // base64 image
  clientStamp: {
    type: Boolean,
    default: false
  },
  
  // Notes
  notes: String,
  
  // Stock tracking
  stockDeducted: {
    type: Boolean,
    default: false
  },
  
  // User tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  confirmedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  confirmedDate: Date,
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancelledDate: Date,
  cancellationReason: String
}, {
  timestamps: true
});

// Compound index for company + unique delivery number
deliveryNoteSchema.index({ company: 1, deliveryNumber: 1 }, { unique: true });
deliveryNoteSchema.index({ company: 1 });
deliveryNoteSchema.index({ company: 1, status: 1 });
deliveryNoteSchema.index({ quotation: 1 });
deliveryNoteSchema.index({ client: 1 });
deliveryNoteSchema.index({ deliveryDate: 1 });

// Auto-generate delivery note number
deliveryNoteSchema.pre('save', async function(next) {
  if (this.isNew && !this.deliveryNumber) {
    this.deliveryNumber = await generateUniqueNumber('NDL', mongoose.model('DeliveryNote'), this.company, 'deliveryNumber');
  }
  
  // Calculate pending qty for each item
  if (this.items && this.items.length > 0) {
    this.items.forEach(item => {
      item.pendingQty = item.orderedQty - item.deliveredQty;
    });
  }
  
  next();
});

// Calculate totals helper
deliveryNoteSchema.methods.calculateTotals = function() {
  if (!this.items || this.items.length === 0) {
    return { totalOrdered: 0, totalDelivered: 0, totalPending: 0 };
  }
  
  const totalOrdered = this.items.reduce((sum, item) => sum + item.orderedQty, 0);
  const totalDelivered = this.items.reduce((sum, item) => sum + item.deliveredQty, 0);
  const totalPending = this.items.reduce((sum, item) => sum + (item.pendingQty || 0), 0);
  
  return { totalOrdered, totalDelivered, totalPending };
};

module.exports = mongoose.model('DeliveryNote', deliveryNoteSchema);
