const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  // Permissions are stored as strings like 'product.create', 'invoice.read', 'product.update.price'
  permissions: [{ type: String }]
}, { timestamps: true });

// Ensure company scoped unique names when company is provided
roleSchema.index({ company: 1, name: 1 }, { unique: true, partialFilterExpression: { company: { $exists: true } } });

module.exports = mongoose.model('Role', roleSchema);
