const mongoose = require('mongoose');

const paymentScheduleSchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Payment schedule must belong to a company']
  },
  
  // Reference to purchase
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase',
    required: true
  },
  
  // Reference to supplier
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  
  // Payment schedule details
  installmentNumber: {
    type: Number,
    required: true,
    min: 1
  },
  
  scheduledAmount: {
    type: Number,
    required: true,
    min: 0
  },
  
  scheduledDate: {
    type: Date,
    required: true
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'paid', 'overdue', 'cancelled'],
    default: 'pending'
  },
  
  // Payment details (filled when paid)
  paidAmount: {
    type: Number,
    default: 0
  },
  paidDate: Date,
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'bank_transfer', 'cheque', 'mobile_money', 'credit', null],
    default: null
  },
  paymentReference: String,
  paymentNotes: String,
  
  // Early payment discount info
  earlyPaymentDiscount: {
    applied: {
      type: Boolean,
      default: false
    },
    discountPercent: {
      type: Number,
      default: 0
    },
    discountAmount: {
      type: Number,
      default: 0
    },
    originalAmount: {
      type: Number,
      default: 0
    }
  },
  
  // Notes
  notes: String,
  
  // User tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound indexes
paymentScheduleSchema.index({ company: 1, purchase: 1 });
paymentScheduleSchema.index({ company: 1, supplier: 1 });
paymentScheduleSchema.index({ company: 1, scheduledDate: 1 });
paymentScheduleSchema.index({ company: 1, status: 1 });

// Calculate overdue status before saving
paymentScheduleSchema.pre('save', function(next) {
  if (this.status === 'pending') {
    const now = new Date();
    const scheduledDate = new Date(this.scheduledDate);
    if (scheduledDate < now) {
      this.status = 'overdue';
    }
  }
  next();
});

module.exports = mongoose.model('PaymentSchedule', paymentScheduleSchema);
