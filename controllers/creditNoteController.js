const CreditNote = require('../models/CreditNote');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Client = require('../models/Client');
const SerialNumber = require('../models/SerialNumber');
const JournalService = require('../services/journalService');

// List credit notes
exports.getCreditNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const notes = await CreditNote.find({ company: companyId }).populate('invoice client createdBy');
    res.json({ success: true, count: notes.length, data: notes });
  } catch (err) { next(err); }
};

// Get single
exports.getCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({ _id: req.params.id, company: companyId }).populate('invoice client createdBy payments.refundedBy');
    if (!note) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: note });
  } catch (err) { next(err); }
};

// Create credit note (draft)
exports.createCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { invoice: invoiceId } = req.body;
    const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const payload = { ...req.body, company: companyId, client: invoice.client, createdBy: req.user.id };
    const note = await CreditNote.create(payload);
    res.status(201).json({ success: true, data: note });
  } catch (err) { next(err); }
};

// Approve credit note: apply client balance adjustment and optional stock reversal
exports.approveCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({ _id: req.params.id, company: companyId });
    if (!note) return res.status(404).json({ success: false, message: 'Not found' });
    if (note.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft notes can be approved' });

    // Update client balance
    const client = await Client.findOne({ _id: note.client, company: companyId });
    if (client) {
      client.outstandingBalance -= note.grandTotal;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      await client.save();
    }

    // Update original invoice with credit note reference
    if (note.invoice) {
      const invoice = await Invoice.findOne({ _id: note.invoice, company: companyId });
      if (invoice) {
        if (!invoice.creditNotes) invoice.creditNotes = [];
        invoice.creditNotes.push({
          creditNoteId: note._id,
          creditNoteNumber: note.creditNoteNumber,
          amount: note.grandTotal,
          appliedDate: new Date()
        });
        
        // Reduce the invoice balance by the credit note amount
        const creditAmount = note.grandTotal;
        invoice.balance = Math.max(0, (invoice.balance || 0) - creditAmount);
        
        // Update invoice status based on new balance - but keep 'paid' status if it was paid
        // A credit note is a reduction of the invoice, not a partial payment
        if (invoice.balance <= 0) {
          invoice.status = 'paid';
          if (!invoice.paidDate) {
            invoice.paidDate = new Date();
          }
        } else if (invoice.amountPaid > 0 && invoice.amountPaid < invoice.grandTotal) {
          // Only change to partial if there's actual partial payment, not just credit note
          invoice.status = 'partial';
        }
        // Don't reduce amountPaid - the invoice was paid, credit note is a separate adjustment
        if (invoice.balance <= 0) {
          invoice.status = 'paid';
          if (!invoice.paidDate) {
            invoice.paidDate = new Date();
          }
        } else if (invoice.amountPaid > 0 && invoice.amountPaid < invoice.grandTotal) {
          invoice.status = 'partial';
        }
        
        await invoice.save();
      }
    }

    // Optionally reverse stock if requested via body.flag
    const { reverseStock } = req.body;
    if (reverseStock && note.items && note.items.length > 0) {
      if (note.stockReversed) {
        // already reversed
      } else {
        for (const item of note.items) {
          const product = await Product.findOne({ _id: item.product, company: companyId });
          if (product) {
            const previousStock = product.currentStock || 0;
            // If serial numbers provided, update each serial record
            let serialsProcessed = [];
            if (item.serialNumbers && Array.isArray(item.serialNumbers) && item.serialNumbers.length > 0) {
              for (const s of item.serialNumbers) {
                if (!s) continue;
                const serialDoc = await SerialNumber.findOne({ company: companyId, serialNumber: s.toUpperCase() });
                if (serialDoc) {
                  const prev = serialDoc.status;
                  serialDoc.status = 'returned';
                  // clear sale references
                  serialDoc.client = null;
                  serialDoc.invoice = null;
                  serialDoc.saleDate = null;
                  serialDoc.salePrice = null;
                  serialDoc.warrantyEndDate = null;
                  serialDoc.warrantyStartDate = null;
                  if (req.body.warehouseId) serialDoc.warehouse = req.body.warehouseId;
                  await serialDoc.save();
                  serialsProcessed.push(serialDoc.serialNumber);
                }
              }
            }

            const qtyToAdd = (item.serialNumbers && item.serialNumbers.length > 0) ? item.serialNumbers.length : (item.quantity || 0);
            const newStock = previousStock + qtyToAdd;

            // include serials in notes when available
            const notes = serialsProcessed.length > 0
              ? `Credit Note ${note.creditNoteNumber} - Return. Serials: ${serialsProcessed.join(',')}`
              : `Credit Note ${note.creditNoteNumber} - Return`;

            await StockMovement.create({
              company: companyId,
              product: product._id,
              type: 'in',
              reason: 'return',
              quantity: qtyToAdd,
              previousStock,
              newStock,
              unitCost: item.unitPrice || 0,
              totalCost: item.totalWithTax || 0,
              referenceType: 'credit_note',
              referenceNumber: note.creditNoteNumber,
              referenceDocument: note._id,
              referenceModel: 'CreditNote',
              notes,
              performedBy: req.user.id
            });

            product.currentStock = newStock;
            await product.save();
          }
        }
        note.stockReversed = true;
      }
    }

    note.status = 'issued';
    await note.save();

    // Check if this is an immediate cash refund
    const { refundMethod, refundPaymentMethod } = req.body;
    const isCashRefund = refundMethod === 'cash' || refundPaymentMethod;

    // Create journal entry for credit note
    // If cash refund: DR Sales Returns, DR VAT Payable, CR Cash/Bank
    // If credit adjustment: DR Sales Returns, DR VAT Payable, CR Accounts Receivable
    try {
      await JournalService.createCreditNoteEntry(companyId, req.user.id, {
        _id: note._id,
        creditNoteNumber: note.creditNoteNumber,
        date: note.date,
        total: note.grandTotal,
        vatAmount: note.totalTax,
        refundMethod: isCashRefund ? (refundPaymentMethod || 'cash') : null
      });
    } catch (journalError) {
      console.error('Error creating journal entry for credit note:', journalError);
      // Don't fail the credit note approval if journal entry fails
    }

    res.json({ success: true, data: note });
  } catch (err) { next(err); }
};

// Apply credit note to a new invoice
exports.applyCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { invoiceId } = req.body; // Target invoice to apply credit to
    
    const note = await CreditNote.findOne({ _id: req.params.id, company: companyId });
    if (!note) return res.status(404).json({ success: false, message: 'Credit note not found' });
    if (note.status !== 'issued') return res.status(400).json({ success: false, message: 'Only issued credit notes can be applied' });
    if (!invoiceId) return res.status(400).json({ success: false, message: 'Target invoice required' });

    // Get target invoice
    const targetInvoice = await Invoice.findOne({ _id: invoiceId, company: companyId });
    if (!targetInvoice) return res.status(404).json({ success: false, message: 'Target invoice not found' });

    // Apply credit to client balance (reduce outstanding)
    const client = await Client.findOne({ _id: note.client, company: companyId });
    if (client) {
      client.outstandingBalance -= note.grandTotal;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      await client.save();
    }

    // Add credit note to target invoice
    if (!targetInvoice.creditNotes) targetInvoice.creditNotes = [];
    targetInvoice.creditNotes.push({
      creditNoteId: note._id,
      creditNoteNumber: note.creditNoteNumber,
      amount: note.grandTotal,
      appliedDate: new Date()
    });
    
    // Reduce the invoice balance by the credit note amount
    const creditAmount = note.grandTotal;
    targetInvoice.balance = Math.max(0, (targetInvoice.balance || 0) - creditAmount);
    
    // Update invoice status - keep 'paid' if it was paid
    if (targetInvoice.balance <= 0) {
      targetInvoice.status = 'paid';
      if (!targetInvoice.paidDate) {
        targetInvoice.paidDate = new Date();
      }
    }
    // Don't reduce amountPaid - credit note is a separate adjustment
    if (targetInvoice.balance <= 0) {
      targetInvoice.status = 'paid';
      if (!targetInvoice.paidDate) {
        targetInvoice.paidDate = new Date();
      }
    } else if (targetInvoice.amountPaid > 0 && targetInvoice.amountPaid < targetInvoice.grandTotal) {
      targetInvoice.status = 'partial';
    }
    
    await targetInvoice.save();

    // Update credit note status
    note.status = 'applied';
    note.appliedTo = targetInvoice.invoiceNumber;
    note.appliedDate = new Date();
    await note.save();

    res.json({ success: true, data: note, message: `Credit note applied to invoice ${targetInvoice.invoiceNumber}` });
  } catch (err) { next(err); }
};

// Record refund (money returned to client)
exports.recordRefund = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference } = req.body;
    const note = await CreditNote.findOne({ _id: req.params.id, company: companyId });
    if (!note) return res.status(404).json({ success: false, message: 'Not found' });
    if (note.status !== 'issued' && note.status !== 'applied' && note.status !== 'partially_refunded') return res.status(400).json({ success: false, message: 'Only issued/applied notes can be refunded' });

    const remaining = note.grandTotal - (note.amountRefunded || 0);
    if (amount > remaining) return res.status(400).json({ success: false, message: 'Refund amount exceeds credit note balance' });

    // attach payment
    note.payments.push({ amount, paymentMethod, reference, refundedBy: req.user.id });
    note.amountRefunded = (note.amountRefunded || 0) + amount;

    // Adjust invoice payments (reduce amountPaid)
    const invoice = await Invoice.findOne({ _id: note.invoice, company: companyId });
    if (invoice) {
      invoice.amountPaid = Math.max(0, (invoice.amountPaid || 0) - amount);
      await invoice.save();
    }

    // Adjust client stats
    const client = await Client.findOne({ _id: note.client, company: companyId });
    if (client) {
      client.totalPurchases = Math.max(0, (client.totalPurchases || 0) - amount);
      // If invoice existed and we decreased amountPaid, outstandingBalance may increase; keep consistent: recompute outstandingBalance as sum of invoices minus payments is complex; instead, adjust by -amount earlier when approving; now refund increases outstandingBalance by amount
      client.outstandingBalance = Math.max(0, (client.outstandingBalance || 0) + amount);
      await client.save();
    }

    if (note.amountRefunded >= note.grandTotal) {
      note.status = 'refunded';
    } else {
      note.status = 'partially_refunded';
    }

    await note.save();

    // Create journal entry for refund (Accounts Receivable Debit, Cash/Bank Credit)
    try {
      const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
      
      // Determine cash account based on payment method
      let cashAccount;
      if (paymentMethod === 'bank_transfer' || paymentMethod === 'cheque') {
        cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      } else if (paymentMethod === 'mobile_money') {
        cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      } else {
        // cash, card default to cash in hand
        cashAccount = DEFAULT_ACCOUNTS.cashInHand;
      }
      
      await JournalService.createEntry(companyId, req.user.id, {
        date: new Date(),
        description: `Refund for Credit Note ${note.creditNoteNumber}`,
        sourceType: 'credit_note_refund',
        sourceId: note._id,
        sourceReference: note.creditNoteNumber,
        lines: [
          JournalService.createDebitLine(DEFAULT_ACCOUNTS.accountsReceivable, amount, `Refund for Credit Note ${note.creditNoteNumber}`),
          JournalService.createCreditLine(cashAccount, amount, `Refund for Credit Note ${note.creditNoteNumber}`)
        ],
        isAutoGenerated: true
      });
    } catch (journalError) {
      console.error('Error creating journal entry for credit note refund:', journalError);
      // Don't fail the refund if journal entry fails
    }

    res.json({ success: true, data: note });
  } catch (err) { next(err); }
};

// Delete (only drafts)
exports.deleteCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({ _id: req.params.id, company: companyId });
    if (!note) return res.status(404).json({ success: false, message: 'Not found' });
    if (note.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft notes can be deleted' });
    await note.deleteOne();
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { next(err); }
};
