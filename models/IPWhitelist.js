const mongoose = require('mongoose');

const ipWhitelistSchema = new mongoose.Schema({
  ip: { type: String, required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  description: { type: String },
  enabled: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('IPWhitelist', ipWhitelistSchema);
