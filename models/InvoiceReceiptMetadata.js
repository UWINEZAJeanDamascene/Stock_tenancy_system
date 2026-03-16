const mongoose = require('mongoose');

const invoiceReceiptMetadataSchema = new mongoose.Schema({
  invoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    required: true
  },
  sdcId: {
    type: String,
    // SDC (Sales Data Controller) ID for tax compliance
  },
  receiptNumber: {
    type: String,
    // Fiscal receipt number
  },
  receiptSignature: {
    type: String,
    // Digital signature from fiscal device
  },
  internalData: {
    type: String,
    // Internal reference data
  },
  mrcCode: {
    type: String,
    // MRC (Machine Readable Code) for tax compliance
  },
  deviceId: {
    type: String,
    // ID of the fiscal device
  },
  fiscalDate: {
    type: Date,
    // Date recorded by fiscal device
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
invoiceReceiptMetadataSchema.index({ invoice: 1 });
invoiceReceiptMetadataSchema.index({ receiptNumber: 1 });

module.exports = mongoose.model('InvoiceReceiptMetadata', invoiceReceiptMetadataSchema);
