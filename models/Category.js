const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: [true, 'Category must belong to a company']
  },
  name: {
    type: String,
    required: [true, 'Please provide a category name'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Compound index for company + unique name
categorySchema.index({ company: 1, name: 1 }, { unique: true });
categorySchema.index({ company: 1 });

module.exports = mongoose.model('Category', categorySchema);
