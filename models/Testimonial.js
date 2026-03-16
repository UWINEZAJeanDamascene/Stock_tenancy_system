const mongoose = require('mongoose');

const testimonialSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide a name'],
    trim: true
  },
  role: {
    type: String,
    required: [true, 'Please provide a role'],
    trim: true
  },
  company: {
    type: String,
    required: [true, 'Please provide a company name'],
    trim: true
  },
  avatar: {
    type: String,
    default: null
  },
  content: {
    type: String,
    required: [true, 'Please provide testimonial content'],
    trim: true
  },
  rating: {
    type: Number,
    required: [true, 'Please provide a rating'],
    min: 1,
    max: 5,
    default: 5
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
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

// Index for ordering
testimonialSchema.index({ order: 1 });
testimonialSchema.index({ isActive: 1 });

testimonialSchema.set('toJSON', { virtuals: true });
testimonialSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Testimonial', testimonialSchema);
