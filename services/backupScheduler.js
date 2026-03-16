const cron = require('node-cron');
const Backup = require('../models/Backup');
const Company = require('../models/Company');
const { performBackup, performVerification } = require('../controllers/backupController');

let backupSchedulerTask = null;
let verificationTask = null;

// Get cron expression based on frequency
const getCronExpression = (frequency) => {
  switch (frequency) {
    case 'hourly':
      return '0 * * * *'; // Every hour at minute 0
    case 'daily':
      return '0 2 * * *'; // Daily at 2 AM
    case 'weekly':
      return '0 2 * * 0'; // Weekly on Sunday at 2 AM
    case 'monthly':
      return '0 2 1 * *'; // Monthly on 1st at 2 AM
    default:
      return '0 2 * * *'; // Default to daily
  }
};

// Run automated backup for a company
const runAutomatedBackup = async (companyId, backupSettings) => {
  try {
    console.log(`Running automated backup for company ${companyId}`);

    const backup = await Backup.create({
      company: companyId,
      name: `Automated_Backup_${new Date().toISOString().replace(/[:.]/g, '-')}`,
      type: 'automated',
      status: 'pending',
      storageLocation: backupSettings.storageLocation || 'local',
      createdBy: null // System-generated
    });

    // Get all collections
    const collections = [
      'ActionLog', 'Budget', 'CashDrawer', 'Category', 'Client', 
      'Company', 'CreditNote', 'Department', 'ExchangeRate', 
      'InventoryBatch', 'Invoice', 'InvoiceReceiptMetadata', 'IPWhitelist',
      'Notification', 'NotificationSettings', 'Product', 'Purchase', 
      'Quotation', 'RecurringInvoice', 'ReorderPoint', 'Role',
      'SerialNumber', 'StockAudit', 'StockMovement', 'StockTransfer',
      'Subscription', 'Supplier', 'User', 'Warehouse'
    ];

    await performBackup(backup._id, companyId, collections);

    // Auto-verify if enabled
    if (backupSettings.autoVerify) {
      setTimeout(async () => {
        await performVerification(backup._id, null);
      }, 5000); // Wait 5 seconds after backup completes
    }

    // Cleanup old backups based on retention policy
    await cleanupOldBackups(companyId, backupSettings.retention?.keepForDays || 30);

    console.log(`Automated backup completed for company ${companyId}`);
  } catch (error) {
    console.error(`Automated backup failed for company ${companyId}:`, error);
  }
};

// Cleanup old backups based on retention policy
const cleanupOldBackups = async (companyId, keepForDays) => {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - keepForDays);

    const oldBackups = await Backup.find({
      company: companyId,
      createdAt: { $lt: cutoffDate },
      'retention.autoDelete': true
    });

    for (const backup of oldBackups) {
      try {
        await backup.deleteOne();
        console.log(`Deleted old backup ${backup._id}`);
      } catch (err) {
        console.warn(`Failed to delete backup ${backup._id}:`, err.message);
      }
    }
  } catch (error) {
    console.error('Error cleaning up old backups:', error);
  }
};

// Process all companies with enabled backup schedules
const processScheduledBackups = async () => {
  try {
    const now = new Date();

    // Find all companies with scheduled backups
    const scheduledBackups = await Backup.find({
      'schedule.enabled': true,
      'schedule.nextRun': { $lte: now }
    }).populate('company', 'name');

    for (const backupSettings of scheduledBackups) {
      try {
        await runAutomatedBackup(backupSettings.company._id, {
          storageLocation: backupSettings.storageLocation,
          retention: backupSettings.retention,
          autoVerify: backupSettings.schedule?.autoVerify || false
        });

        // Update next run time
        const frequency = backupSettings.schedule.frequency;
        let nextRun = new Date();

        switch (frequency) {
          case 'hourly':
            nextRun.setHours(nextRun.getHours() + 1);
            break;
          case 'daily':
            nextRun.setDate(nextRun.getDate() + 1);
            break;
          case 'weekly':
            nextRun.setDate(nextRun.getDate() + 7);
            break;
          case 'monthly':
            nextRun.setMonth(nextRun.getMonth() + 1);
            break;
        }

        backupSettings.schedule.lastRun = now;
        backupSettings.schedule.nextRun = nextRun;
        await backupSettings.save();
      } catch (err) {
        console.error(`Error processing scheduled backup for company:`, err);
      }
    }
  } catch (error) {
    console.error('Error processing scheduled backups:', error);
  }
};

// Run verification on all completed backups
const runScheduledVerification = async () => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Find completed backups from the last day that haven't been verified
    const unverifiedBackups = await Backup.find({
      status: 'completed',
      createdAt: { $gte: oneDayAgo },
      'verification.verified': false
    });

    for (const backup of unverifiedBackups) {
      try {
        await performVerification(backup._id, null);
      } catch (err) {
        console.error(`Error verifying backup ${backup._id}:`, err);
      }
    }
  } catch (error) {
    console.error('Error running scheduled verification:', error);
  }
};

// Start the backup scheduler
const startBackupScheduler = () => {
  if (backupSchedulerTask) return;
  
  // Run scheduled backups every hour
  backupSchedulerTask = cron.schedule('0 * * * *', () => {
    console.log('Running scheduled backup check...');
    processScheduledBackups();
  }, { scheduled: true });

  // Run initial check
  processScheduledBackups();
  
  console.log('Backup scheduler started');
};

// Start the verification scheduler
const startVerificationScheduler = () => {
  if (verificationTask) return;
  
  // Run verification check every day at 3 AM
  verificationTask = cron.schedule('0 3 * * *', () => {
    console.log('Running backup verification check...');
    runScheduledVerification();
  }, { scheduled: true });

  // Run initial verification
  runScheduledVerification();
  
  console.log('Backup verification scheduler started');
};

// Stop all schedulers
const stopBackupScheduler = () => {
  if (backupSchedulerTask) {
    backupSchedulerTask.stop();
    backupSchedulerTask = null;
  }
  if (verificationTask) {
    verificationTask.stop();
    verificationTask = null;
  }
  console.log('Backup schedulers stopped');
};

// Manual trigger for backup
const triggerManualBackup = async (companyId, options = {}) => {
  const { name, type = 'manual', storageLocation = 'local', collections } = options;

  const backup = await Backup.create({
    company: companyId,
    name: name || `Manual_Backup_${new Date().toISOString().replace(/[:.]/g, '-')}`,
    type,
    status: 'pending',
    storageLocation,
    createdBy: null
  });

  await performBackup(backup._id, companyId, collections || getAllCollections());
  
  return backup;
};

const getAllCollections = () => {
  return [
    'ActionLog', 'Budget', 'CashDrawer', 'Category', 'Client', 
    'Company', 'CreditNote', 'Department', 'ExchangeRate', 
    'InventoryBatch', 'Invoice', 'InvoiceReceiptMetadata', 'IPWhitelist',
    'Notification', 'NotificationSettings', 'Product', 'Purchase', 
    'Quotation', 'RecurringInvoice', 'ReorderPoint', 'Role',
    'SerialNumber', 'StockAudit', 'StockMovement', 'StockTransfer',
    'Subscription', 'Supplier', 'User', 'Warehouse'
  ];
};

module.exports = {
  startBackupScheduler,
  startVerificationScheduler,
  stopBackupScheduler,
  runAutomatedBackup,
  processScheduledBackups,
  runScheduledVerification,
  triggerManualBackup,
  getCronExpression
};
