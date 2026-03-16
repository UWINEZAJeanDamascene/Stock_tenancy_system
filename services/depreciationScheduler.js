const cron = require('node-cron');
const FixedAsset = require('../models/FixedAsset');
const JournalService = require('../services/journalService');
const Company = require('../models/Company');

let depreciationSchedulerTask = null;

/**
 * Run depreciation for all companies for a specific period
 * @param {Date} periodDate - The period to run depreciation for
 */
const runDepreciationForAllCompanies = async (periodDate) => {
  try {
    const periodKey = `${periodDate.getUTCFullYear()}-${String(periodDate.getUTCMonth() + 1).padStart(2, '0')}`;
    console.log(`Running monthly depreciation for period: ${periodKey}`);
    
    // Get all companies
    const companies = await Company.find({});
    
    for (const company of companies) {
      try {
        await runDepreciationForCompany(company._id, periodDate);
      } catch (err) {
        console.error(`Error running depreciation for company ${company._id}:`, err.message);
      }
    }
    
    console.log(`Completed monthly depreciation for period: ${periodKey}`);
  } catch (error) {
    console.error('Error running depreciation for all companies:', error);
  }
};

/**
 * Run depreciation for a specific company
 * @param {string} companyId - The company ID
 * @param {Date} periodDate - The period to run depreciation for
 */
const runDepreciationForCompany = async (companyId, periodDate) => {
  const periodKey = `${periodDate.getUTCFullYear()}-${String(periodDate.getUTCMonth() + 1).padStart(2, '0')}`;
  
  // Get all active assets that need depreciation
  const assetsData = await FixedAsset.getAssetsForDepreciation(companyId, periodDate);
  
  let totalDepreciation = 0;
  let createdCount = 0;
  
  for (const item of assetsData) {
    // Skip if already recorded or no depreciation needed
    if (item.alreadyRecorded || item.monthlyDepreciation <= 0) {
      continue;
    }
    
    try {
      // Use system user ID for automatic entries (null will be handled by JournalService)
      const journalEntry = await JournalService.createDepreciationEntry(
        companyId,
        'system', // System-generated entry
        {
          amount: item.monthlyDepreciation,
          period: periodKey,
          date: periodDate
        }
      );
      
      // Update asset with depreciation entry reference
      await FixedAsset.findByIdAndUpdate(item.asset._id, {
        $push: {
          depreciationEntries: {
            journalEntryId: journalEntry._id,
            period: periodKey,
            amount: item.monthlyDepreciation,
            date: periodDate
          }
        }
      });
      
      totalDepreciation += item.monthlyDepreciation;
      createdCount++;
      
    } catch (err) {
      console.error(`Error creating depreciation for asset ${item.asset.name}:`, err.message);
    }
  }
  
  console.log(`Company ${companyId}: Created ${createdCount} depreciation entries, total: ${totalDepreciation}`);
};

/**
 * Start the depreciation scheduler
 * Runs on the 1st of each month at 1:00 AM
 */
const startDepreciationScheduler = () => {
  if (depreciationSchedulerTask) return;
  
  // Run on the 1st of each month at 1:00 AM
  depreciationSchedulerTask = cron.schedule('0 1 1 * *', () => {
    console.log('Running scheduled monthly depreciation...');
    
    // Run for previous month (current date minus 1 month)
    const now = new Date();
    const lastMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    runDepreciationForAllCompanies(lastMonth);
  }, { scheduled: true });
  
  console.log('Depreciation scheduler started (runs monthly on 1st at 1:00 AM)');
};

/**
 * Stop the depreciation scheduler
 */
const stopDepreciationScheduler = () => {
  if (depreciationSchedulerTask) {
    depreciationSchedulerTask.stop();
    depreciationSchedulerTask = null;
    console.log('Depreciation scheduler stopped');
  }
};

/**
 * Manually trigger depreciation for a specific period
 * @param {string} companyId - Optional company ID (if not provided, runs for all companies)
 * @param {string} period - Period in YYYY-MM format (defaults to previous month)
 */
const triggerManualDepreciation = async (companyId, period) => {
  let periodDate;
  
  if (period) {
    const [year, month] = period.split('-');
    periodDate = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, 1));
  } else {
    // Default to previous month
    const now = new Date();
    periodDate = new Date(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  }
  
  if (companyId) {
    await runDepreciationForCompany(companyId, periodDate);
  } else {
    await runDepreciationForAllCompanies(periodDate);
  }
};

module.exports = {
  startDepreciationScheduler,
  stopDepreciationScheduler,
  runDepreciationForAllCompanies,
  runDepreciationForCompany,
  triggerManualDepreciation
};
