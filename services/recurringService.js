const cron = require('node-cron');
const RecurringInvoice = require('../models/RecurringInvoice');
const Invoice = require('../models/Invoice');

function addMonthsSafe(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) {
    d.setDate(0);
  }
  return d;
}

function computeNextRunDate(schedule, fromDate) {
  const now = new Date(fromDate || Date.now());
  const freq = schedule.frequency;
  const interval = schedule.interval || 1;

  if (freq === 'weekly') {
    const dayOfWeek = (typeof schedule.dayOfWeek === 'number') ? schedule.dayOfWeek : now.getDay();
    const base = new Date(now);
    base.setHours(0,0,0,0);
    const delta = (dayOfWeek - base.getDay() + 7) % 7;
    base.setDate(base.getDate() + delta);
    if (base <= now) base.setDate(base.getDate() + (7 * interval));
    return base;
  }

  if (freq === 'monthly' || freq === 'quarterly') {
    const monthsToAdd = freq === 'quarterly' ? 3 * interval : interval;
    const dayOfMonth = schedule.dayOfMonth || now.getDate();
    let candidate = addMonthsSafe(now, monthsToAdd);
    candidate.setDate(Math.min(dayOfMonth, 28));
    if (candidate <= now) candidate = addMonthsSafe(candidate, monthsToAdd);
    return candidate;
  }

  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 1);
  return fallback;
}

async function generateForTemplate(templateId) {
  const r = await RecurringInvoice.findById(templateId);
  if (!r || !r.active) throw new Error('Template not found or inactive');

  const invoiceData = {
    company: r.company,
    client: r.client,
    items: r.items.map(i => ({
      product: i.product,
      description: i.description,
      itemCode: i.itemCode,
      quantity: i.quantity,
      unit: i.unit,
      unitPrice: i.unitPrice,
      discount: i.discount,
      taxCode: i.taxCode,
      taxRate: i.taxRate
    })),
    currency: 'FRW',
    paymentTerms: 'cash',
    createdBy: r.createdBy,
    status: 'draft',
    generatedFromRecurring: r._id,
    invoiceDate: new Date()
  };

  const created = await Invoice.create(invoiceData);

  const next = computeNextRunDate(r.schedule, r.nextRunDate || r.startDate || new Date());
  r.nextRunDate = next;
  await r.save();

  return created;
}

async function generateDueRecurringInvoices() {
  try {
    const now = new Date();
    const due = await RecurringInvoice.find({ active: true, startDate: { $lte: now }, $or: [ { nextRunDate: { $lte: now } }, { nextRunDate: null } ] });

    for (const r of due) {
      try {
        await generateForTemplate(r._id);
      } catch (errInner) {
        console.error('Error creating recurring invoice for template', r._id, errInner);
      }
    }
  } catch (err) {
    console.error('Recurring invoice generation error', err);
  }
}

let task = null;

function startScheduler() {
  if (task) return;
  task = cron.schedule('*/15 * * * *', () => {
    generateDueRecurringInvoices();
  }, { scheduled: true });
  generateDueRecurringInvoices();
}

module.exports = {
  startScheduler,
  generateDueRecurringInvoices,
  generateForTemplate,
  computeNextRunDate
};
