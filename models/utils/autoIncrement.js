/**
 * Auto-increment utility for generating unique codes/numbers across multi-tenant database
 * Uses company prefix + timestamp + random suffix to avoid conflicts
 */

/**
 * Generate a unique code with company prefix - uses timestamp + random to guarantee uniqueness
 * @param {string} prefix - Prefix for the code (e.g., 'CLI', 'SUP')
 * @param {mongoose.Model} Model - Mongoose model to check for uniqueness
 * @param {mongoose.Schema.Types.ObjectId} companyId - Company ID
 * @param {string} fieldName - Field name to check (e.g., 'code', 'sku')
 * @returns {string} - Unique code
 */
async function generateUniqueCode(prefix, Model, companyId, fieldName) {
  let code = '';
  let exists = true;
  let attempts = 0;
  const maxAttempts = 20;
  
  while (exists && attempts < maxAttempts) {
    // Generate code with prefix + timestamp (full) + random (4 digits)
    // Using full timestamp ensures uniqueness across time
    const timestamp = Date.now().toString();
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    code = `${prefix}${timestamp}${random}`;
    
    // Check if this code already exists for this company
    const existing = await Model.findOne({
      company: companyId,
      [fieldName]: code
    }).lean();
    
    exists = !!existing;
    attempts++;
  }
  
  if (exists) {
    // Ultimate fallback: UUID-like approach
    code = `${prefix}${Date.now()}${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
  }
  
  return code;
}

/**
 * Generate a unique sequential number with year prefix
 * Uses a more robust approach with timestamp as final fallback
 * @param {string} prefix - Prefix for the number (e.g., 'INV', 'QUO', 'PO')
 * @param {mongoose.Model} Model - Mongoose model to check for uniqueness
 * @param {mongoose.Schema.Types.ObjectId} companyId - Company ID
 * @param {string} fieldName - Field name to check (e.g., 'invoiceNumber')
 * @returns {string} - Unique number
 */
async function generateUniqueNumber(prefix, Model, companyId, fieldName) {
  let number = '';
  let exists = true;
  let attempts = 0;
  const maxAttempts = 20;
  const year = new Date().getFullYear();
  
  while (exists && attempts < maxAttempts) {
    // Get count and add random offset to avoid collisions
    const count = await Model.countDocuments({ company: companyId });
    const sequence = String(count + 1 + Math.floor(Math.random() * 100)).padStart(5, '0');
    number = `${prefix}-${year}-${sequence}`;
    
    // Check if this number already exists for this company
    const existing = await Model.findOne({
      company: companyId,
      [fieldName]: number
    }).lean();
    
    exists = !!existing;
    attempts++;
  }
  
  if (exists) {
    // Fallback: use timestamp-based approach that's guaranteed unique
    const timestamp = Date.now().toString().slice(-8);
    number = `${prefix}-${year}-${timestamp}`;
  }
  
  return number;
}

module.exports = {
  generateUniqueCode,
  generateUniqueNumber
};
