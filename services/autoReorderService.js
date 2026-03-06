const cron = require('node-cron');
const ReorderPoint = require('../models/ReorderPoint');
const Product = require('../models/Product');
const Purchase = require('../models/Purchase');
const Company = require('../models/Company');
const User = require('../models/User');

let task = null;

// Process automatic reorders for all companies
async function processAutoReorders() {
  try {
    console.log('Running automatic reorder check...');
    
    // Get all companies
    const companies = await Company.find({ status: 'active' });
    
    for (const company of companies) {
      await processCompanyReorders(company._id);
    }
    
    console.log('Automatic reorder check completed');
  } catch (error) {
    console.error('Error in auto reorder process:', error);
  }
}

// Process reorders for a specific company
async function processCompanyReorders(companyId) {
  try {
    // Find all active reorder points that need reordering
    const reorderPoints = await ReorderPoint.find({ 
      company: companyId, 
      isActive: true,
      autoReorder: true
    }).populate('product', 'name sku currentStock').populate('supplier', 'name code');

    for (const rp of reorderPoints) {
      const currentStock = rp.product.currentStock || 0;
      
      // Check if stock is at or below reorder point
      if (currentStock <= rp.reorderPoint) {
        // Check if there's already a pending purchase order for this product
        const existingPO = await Purchase.findOne({
          company: companyId,
          supplier: rp.supplier._id,
          status: { $in: ['pending', 'confirmed'] },
          'items.product': rp.product._id
        });

        if (!existingPO) {
          // Create automatic purchase order
          await createAutoPurchaseOrder(companyId, rp);
        }
      }
    }
  } catch (error) {
    console.error(`Error processing reorders for company ${companyId}:`, error);
  }
}

// Create automatic purchase order
async function createAutoPurchaseOrder(companyId, reorderPoint) {
  try {
    // Get company settings for auto PO
    const company = await Company.findById(companyId);
    if (!company) return;

    // Get default warehouse if set
    const warehouse = company.settings?.defaultWarehouse;

    // Create purchase order
    const purchase = await Purchase.create({
      company: companyId,
      supplier: reorderPoint.supplier._id,
      status: 'pending',
      items: [{
        product: reorderPoint.product._id,
        quantity: reorderPoint.reorderQuantity,
        unitCost: reorderPoint.estimatedUnitCost || 0,
        receivedQuantity: 0
      }],
      warehouse,
      notes: `Automatic reorder - Stock low (${reorderPoint.product.currentStock} units remaining)`,
      createdBy: company.settings?.autoReorderCreatedBy || null
    });

    console.log(`Auto PO created: ${purchase.purchaseNumber} for product ${reorderPoint.product.name}`);
    return purchase;
  } catch (error) {
    console.error(`Error creating auto PO for ${reorderPoint.product.name}:`, error);
  }
}

// Get company settings and apply reorder point to product
async function applyReorderPointToProduct(companyId, productId, reorderPoint, reorderQuantity, safetyStock, supplierId) {
  try {
    // Update product with reorder settings
    await Product.findOneAndUpdate(
      { _id: productId, company: companyId },
      { 
        reorderPoint,
        reorderQuantity: reorderQuantity || reorderPoint * 2,
        preferredSupplier: supplierId,
        lowStockThreshold: safetyStock
      }
    );

    // Create or update reorder point
    await ReorderPoint.findOneAndUpdate(
      { company: companyId, product: productId },
      {
        company: companyId,
        product: productId,
        supplier: supplierId,
        reorderPoint,
        reorderQuantity: reorderQuantity || reorderPoint * 2,
        safetyStock: safetyStock || 0,
        isActive: true,
        autoReorder: true
      },
      { upsert: true, new: true }
    );

    return { success: true };
  } catch (error) {
    console.error('Error applying reorder point:', error);
    throw error;
  }
}

// Start the auto reorder scheduler
function startScheduler() {
  if (task) return;
  
  // Run every hour
  task = cron.schedule('0 * * * *', () => {
    processAutoReorders();
  }, { scheduled: true });
  
  console.log('Auto reorder scheduler started');
}

// Stop the scheduler
function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

// Manual trigger for testing
async function triggerManualReorder() {
  await processAutoReorders();
}

module.exports = {
  processAutoReorders,
  processCompanyReorders,
  createAutoPurchaseOrder,
  applyReorderPointToProduct,
  startScheduler,
  stopScheduler,
  triggerManualReorder
};
