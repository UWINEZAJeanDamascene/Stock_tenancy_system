const RecurringInvoice = require('../models/RecurringInvoice');
const recurringService = require('../services/recurringService');

// List recurring templates
exports.getRecurringInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const recs = await RecurringInvoice.find({ company: companyId }).populate('client createdBy');
    res.json({ success: true, count: recs.length, data: recs });
  } catch (err) {
    next(err);
  }
};

// Get single
exports.getRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId }).populate('client createdBy');
    if (!rec) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rec });
  } catch (err) {
    next(err);
  }
};

// Create template
exports.createRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const payload = {
      ...req.body,
      company: companyId,
      createdBy: req.user.id
    };
    const rec = await RecurringInvoice.create(payload);

    // compute initial nextRunDate
    try {
      const next = recurringService.computeNextRunDate(rec.schedule, rec.startDate || new Date());
      rec.nextRunDate = next;
      await rec.save();
    } catch (e) {
      // ignore schedule compute errors
    }
    res.status(201).json({ success: true, data: rec });
  } catch (err) {
    next(err);
  }
};

// Update
exports.updateRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOneAndUpdate({ _id: req.params.id, company: companyId }, req.body, { new: true, runValidators: true });
    if (!rec) return res.status(404).json({ success: false, message: 'Not found' });
    try {
      const next = recurringService.computeNextRunDate(rec.schedule, rec.startDate || new Date());
      rec.nextRunDate = next;
      await rec.save();
    } catch (e) {}
    res.json({ success: true, data: rec });
  } catch (err) {
    next(err);
  }
};

// Delete
exports.deleteRecurringInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId });
    if (!rec) return res.status(404).json({ success: false, message: 'Not found' });
    await rec.deleteOne();
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    next(err);
  }
};

// Manual trigger for generation (admin)
exports.triggerGeneration = async (req, res, next) => {
  try {
    await recurringService.generateDueRecurringInvoices();
    res.json({ success: true, message: 'Generation started' });
  } catch (err) {
    next(err);
  }
};

// Trigger a specific template immediately
exports.triggerTemplate = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const rec = await RecurringInvoice.findOne({ _id: req.params.id, company: companyId });
    if (!rec) return res.status(404).json({ success: false, message: 'Template not found' });

    const invoice = await recurringService.generateForTemplate(rec._id);
    res.json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
};
