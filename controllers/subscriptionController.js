const Subscription = require('../models/Subscription');
const recurringService = require('../services/recurringService');

exports.getSubscriptions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const subs = await Subscription.find({ company: companyId }).populate('client recurringInvoice createdBy');
    res.json({ success: true, count: subs.length, data: subs });
  } catch (err) {
    next(err);
  }
};

exports.getSubscription = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const sub = await Subscription.findOne({ _id: req.params.id, company: companyId }).populate('client recurringInvoice createdBy');
    if (!sub) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: sub });
  } catch (err) {
    next(err);
  }
};

exports.createSubscription = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const payload = { ...req.body, company: companyId, createdBy: req.user.id };
    const sub = await Subscription.create(payload);

    // compute initial nextBillingDate
    try {
      const schedule = { frequency: sub.billingCycle, interval: sub.interval };
      const next = recurringService.computeNextRunDate(schedule, sub.startDate || new Date());
      sub.nextBillingDate = next;
      await sub.save();
    } catch (e) {}
    res.status(201).json({ success: true, data: sub });
  } catch (err) {
    next(err);
  }
};

exports.updateSubscription = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const sub = await Subscription.findOneAndUpdate({ _id: req.params.id, company: companyId }, req.body, { new: true, runValidators: true });
    if (!sub) return res.status(404).json({ success: false, message: 'Not found' });
    try {
      const schedule = { frequency: sub.billingCycle, interval: sub.interval };
      const next = recurringService.computeNextRunDate(schedule, sub.startDate || new Date());
      sub.nextBillingDate = next;
      await sub.save();
    } catch (e) {}
    res.json({ success: true, data: sub });
  } catch (err) {
    next(err);
  }
};

exports.deleteSubscription = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const sub = await Subscription.findOne({ _id: req.params.id, company: companyId });
    if (!sub) return res.status(404).json({ success: false, message: 'Not found' });
    await sub.deleteOne();
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    next(err);
  }
};
