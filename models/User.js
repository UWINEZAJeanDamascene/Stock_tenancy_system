const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide a name'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Please provide an email'],
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
  },
  password: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: 6,
    select: false
  },
  // Multi-tenancy: company reference
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: function() {
      // Company is required unless user is a platform admin
      return this.role !== 'platform_admin';
    }
  },
  role: {
    // Legacy single-role kept for backward compatibility. Prefer `roles` array of Role refs.
    type: String,
    enum: ['platform_admin', 'admin', 'stock_manager', 'sales', 'viewer'],
    default: 'viewer'
  },
  roles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Role' }],
  // Department-based access
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // Password management fields
  mustChangePassword: {
    type: Boolean,
    default: false
  },
  passwordChangedAt: {
    type: Date,
    default: null
  },
  tempPassword: {
    type: Boolean,
    default: false
  }
  ,
  // Two-factor authentication (TOTP)
  twoFAEnabled: { type: Boolean, default: false },
  twoFASecret: { type: String, select: false, default: null },
  twoFAConfirmed: { type: Boolean, default: false },
  // Optional per-user IP whitelist (array of IP strings)
  ipWhitelist: [{ type: String }]
}, {
  timestamps: true
});

// Compound index for company + email uniqueness
userSchema.index({ company: 1, email: 1 }, { unique: true });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password
userSchema.methods.comparePassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Remove password from JSON output
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
