const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const Product = require('../models/Product');
const Client = require('../models/Client');
const Supplier = require('../models/Supplier');
const Category = require('../models/Category');

// Multer memory storage for CSV uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  }
});

exports.uploadCSV = upload.single('file');

// ──────────────── EXPORT ────────────────

// @desc    Export products to CSV
// @route   GET /api/bulk/export/products
// @access  Private
exports.exportProducts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const products = await Product.find({ company: companyId, isArchived: false })
      .populate('category', 'name')
      .populate('supplier', 'name code')
      .lean();

    const rows = products.map(p => ({
      name: p.name,
      sku: p.sku,
      description: p.description || '',
      category: p.category?.name || '',
      unit: p.unit,
      currentStock: p.currentStock,
      lowStockThreshold: p.lowStockThreshold,
      averageCost: p.averageCost,
      sellingPrice: p.sellingPrice || 0,
      supplier: p.supplier?.name || '',
      barcode: p.barcode || '',
      barcodeType: p.barcodeType || '',
      taxCode: p.taxCode || '',
      taxRate: p.taxRate || 0,
      reorderPoint: p.reorderPoint || '',
      reorderQuantity: p.reorderQuantity || '',
      weight: p.weight || '',
      brand: p.brand || '',
      location: p.location || ''
    }));

    const csv = stringify(rows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=products_export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
};

// @desc    Export clients to CSV
// @route   GET /api/bulk/export/clients
// @access  Private
exports.exportClients = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const clients = await Client.find({ company: companyId }).lean();

    const rows = clients.map(c => ({
      name: c.name,
      code: c.code || '',
      type: c.type || 'individual',
      phone: c.contact?.phone || '',
      email: c.contact?.email || '',
      fax: c.contact?.fax || '',
      website: c.contact?.website || '',
      contactPerson: c.contact?.contactPerson || '',
      address: c.contact?.address || '',
      city: c.contact?.city || '',
      state: c.contact?.state || '',
      zipCode: c.contact?.zipCode || '',
      country: c.contact?.country || '',
      salesArea: c.salesArea || '',
      salesRepId: c.salesRepId || '',
      region: c.region || '',
      industry: c.industry || '',
      registrationDate: c.registrationDate ? c.registrationDate.toISOString().split('T')[0] : '',
      taxId: c.taxId || '',
      paymentTerms: c.paymentTerms || 'cash',
      creditLimit: c.creditLimit || 0,
      notes: c.notes || '',
      isActive: c.isActive ? 'true' : 'false'
    }));

    const csv = stringify(rows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=clients_export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
};

// @desc    Export suppliers to CSV
// @route   GET /api/bulk/export/suppliers
// @access  Private
exports.exportSuppliers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const suppliers = await Supplier.find({ company: companyId }).lean();

    const rows = suppliers.map(s => ({
      name: s.name,
      code: s.code || '',
      phone: s.contact?.phone || '',
      email: s.contact?.email || '',
      fax: s.contact?.fax || '',
      website: s.contact?.website || '',
      contactPerson: s.contact?.contactPerson || '',
      address: s.contact?.address || '',
      city: s.contact?.city || '',
      state: s.contact?.state || '',
      zipCode: s.contact?.zipCode || '',
      country: s.contact?.country || '',
      region: s.region || '',
      currency: s.currency || '',
      leadTime: s.leadTime || '',
      minimumOrder: s.minimumOrder || '',
      bankName: s.bankName || '',
      bankAccount: s.bankAccount || '',
      taxId: s.taxId || '',
      paymentTerms: s.paymentTerms || 'cash',
      notes: s.notes || '',
      isActive: s.isActive ? 'true' : 'false'
    }));

    const csv = stringify(rows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=suppliers_export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
};

// ──────────────── IMPORT ────────────────

// @desc    Import products from CSV
// @route   POST /api/bulk/import/products
// @access  Private (admin, stock_manager)
exports.importProducts = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a CSV file' });
    }

    const companyId = req.user.company._id;
    const csvContent = req.file.buffer.toString('utf-8');
    
    let records;
    try {
      records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Invalid CSV format: ' + e.message });
    }

    if (!records.length) {
      return res.status(400).json({ success: false, message: 'CSV file is empty' });
    }

    // Validate required columns
    const requiredCols = ['name', 'sku', 'unit'];
    const missingCols = requiredCols.filter(c => !(c in records[0]));
    if (missingCols.length) {
      return res.status(400).json({ success: false, message: `Missing required columns: ${missingCols.join(', ')}` });
    }

    // Pre-fetch categories and suppliers for lookup
    const categories = await Category.find({ company: companyId }).lean();
    const suppliers = await Supplier.find({ company: companyId }).lean();
    const catMap = {};
    categories.forEach(c => { catMap[c.name.toLowerCase()] = c._id; });
    const supMap = {};
    suppliers.forEach(s => { supMap[s.name.toLowerCase()] = s._id; });

    const results = { created: 0, updated: 0, errors: [] };

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2; // 1-indexed + header row

      try {
        if (!row.name || !row.sku || !row.unit) {
          results.errors.push({ row: rowNum, message: 'Missing required field (name, sku, or unit)' });
          continue;
        }

        // Resolve category
        let categoryId = null;
        if (row.category) {
          categoryId = catMap[row.category.toLowerCase()];
          if (!categoryId) {
            // Auto-create category
            const newCat = await Category.create({ name: row.category, company: companyId, isActive: true });
            categoryId = newCat._id;
            catMap[row.category.toLowerCase()] = categoryId;
          }
        }

        if (!categoryId) {
          results.errors.push({ row: rowNum, message: 'Category is required' });
          continue;
        }

        // Resolve supplier
        let supplierId = null;
        if (row.supplier) {
          supplierId = supMap[row.supplier.toLowerCase()];
        }

        const productData = {
          company: companyId,
          name: row.name,
          sku: row.sku.toUpperCase(),
          description: row.description || '',
          category: categoryId,
          unit: row.unit,
          currentStock: Number(row.currentStock) || 0,
          lowStockThreshold: Number(row.lowStockThreshold) || 10,
          averageCost: Number(row.averageCost) || 0,
          sellingPrice: Number(row.sellingPrice) || 0,
          barcode: row.barcode || null,
          barcodeType: row.barcodeType || 'CODE128',
          taxCode: row.taxCode || 'A',
          taxRate: Number(row.taxRate) || 0,
          createdBy: req.user.id
        };

        if (supplierId) productData.supplier = supplierId;
        if (row.reorderPoint) productData.reorderPoint = Number(row.reorderPoint);
        if (row.reorderQuantity) productData.reorderQuantity = Number(row.reorderQuantity);
        if (row.weight) productData.weight = Number(row.weight) || 0;
        if (row.brand) productData.brand = row.brand;
        if (row.location) productData.location = row.location;

        // Check if product with same SKU exists
        const existing = await Product.findOne({ company: companyId, sku: productData.sku });
        if (existing) {
          // Update existing
          Object.assign(existing, productData);
          existing.history.push({
            action: 'updated',
            changedBy: req.user.id,
            changes: productData,
            notes: 'Bulk import update'
          });
          await existing.save();
          results.updated++;
        } else {
          await Product.create(productData);
          results.created++;
        }
      } catch (err) {
        results.errors.push({ row: rowNum, message: err.message });
      }
    }

    res.json({
      success: true,
      message: `Import complete: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors`,
      data: results
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Import clients from CSV
// @route   POST /api/bulk/import/clients
// @access  Private (admin, sales)
exports.importClients = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a CSV file' });
    }

    const companyId = req.user.company._id;
    const csvContent = req.file.buffer.toString('utf-8');

    let records;
    try {
      records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Invalid CSV format: ' + e.message });
    }

    if (!records.length) {
      return res.status(400).json({ success: false, message: 'CSV file is empty' });
    }

    const requiredCols = ['name'];
    const missingCols = requiredCols.filter(c => !(c in records[0]));
    if (missingCols.length) {
      return res.status(400).json({ success: false, message: `Missing required columns: ${missingCols.join(', ')}` });
    }

    const results = { created: 0, updated: 0, errors: [] };

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2;

      try {
        if (!row.name) {
          results.errors.push({ row: rowNum, message: 'Missing required field: name' });
          continue;
        }

        const validPaymentTerms = ['cash', 'credit_7', 'credit_15', 'credit_30', 'credit_45', 'credit_60'];
        const clientData = {
          company: companyId,
          name: row.name,
          type: ['individual', 'company'].includes(row.type) ? row.type : 'individual',
          contact: {
            phone: row.phone || '',
            email: row.email || '',
            fax: row.fax || '',
            website: row.website || '',
            contactPerson: row.contactPerson || '',
            address: row.address || '',
            city: row.city || '',
            state: row.state || '',
            zipCode: row.zipCode || '',
            country: row.country || ''
          },
          salesArea: row.salesArea || '',
          salesRepId: row.salesRepId || '',
          region: row.region || '',
          industry: row.industry || '',
          registrationDate: row.registrationDate ? new Date(row.registrationDate) : undefined,
          taxId: row.taxId || '',
          paymentTerms: validPaymentTerms.includes(row.paymentTerms) ? row.paymentTerms : 'cash',
          creditLimit: Number(row.creditLimit) || 0,
          notes: row.notes || '',
          isActive: row.isActive !== 'false',
          createdBy: req.user.id
        };

        // Check if client with same code exists
        if (row.code) {
          const existing = await Client.findOne({ company: companyId, code: row.code.toUpperCase() });
          if (existing) {
            Object.assign(existing, {
              name: clientData.name,
              type: clientData.type,
              contact: clientData.contact,
              salesArea: clientData.salesArea,
              salesRepId: clientData.salesRepId,
              region: clientData.region,
              industry: clientData.industry,
              registrationDate: clientData.registrationDate,
              taxId: clientData.taxId,
              paymentTerms: clientData.paymentTerms,
              creditLimit: clientData.creditLimit,
              notes: clientData.notes,
              isActive: clientData.isActive
            });
            await existing.save();
            results.updated++;
            continue;
          }
          clientData.code = row.code.toUpperCase();
        }

        await Client.create(clientData);
        results.created++;
      } catch (err) {
        results.errors.push({ row: rowNum, message: err.message });
      }
    }

    res.json({
      success: true,
      message: `Import complete: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors`,
      data: results
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Import suppliers from CSV
// @route   POST /api/bulk/import/suppliers
// @access  Private (admin, stock_manager)
exports.importSuppliers = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a CSV file' });
    }

    const companyId = req.user.company._id;
    const csvContent = req.file.buffer.toString('utf-8');

    let records;
    try {
      records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) {
      return res.status(400).json({ success: false, message: 'Invalid CSV format: ' + e.message });
    }

    if (!records.length) {
      return res.status(400).json({ success: false, message: 'CSV file is empty' });
    }

    const requiredCols = ['name'];
    const missingCols = requiredCols.filter(c => !(c in records[0]));
    if (missingCols.length) {
      return res.status(400).json({ success: false, message: `Missing required columns: ${missingCols.join(', ')}` });
    }

    const results = { created: 0, updated: 0, errors: [] };
    console.log(`[BULK IMPORT] Importing ${records.length} suppliers for company ${companyId}`);
    console.log(`[BULK IMPORT] CSV columns:`, Object.keys(records[0] || {}));

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2;

      try {
        if (!row.name) {
          results.errors.push({ row: rowNum, message: 'Missing required field: name' });
          continue;
        }

        const validPaymentTerms = ['cash', 'credit_7', 'credit_15', 'credit_30', 'credit_45', 'credit_60'];
        const supplierData = {
          company: companyId,
          name: row.name,
          contact: {
            phone: row.phone || '',
            email: row.email || '',
            fax: row.fax || '',
            website: row.website || '',
            contactPerson: row.contactPerson || '',
            address: row.address || '',
            city: row.city || '',
            state: row.state || '',
            zipCode: row.zipCode || '',
            country: row.country || ''
          },
          region: row.region || '',
          currency: row.currency || '',
          leadTime: row.leadTime ? Number(row.leadTime) : undefined,
          minimumOrder: row.minimumOrder ? Number(row.minimumOrder) : undefined,
          bankName: row.bankName || '',
          bankAccount: row.bankAccount || '',
          taxId: row.taxId || '',
          paymentTerms: validPaymentTerms.includes(row.paymentTerms) ? row.paymentTerms : 'cash',
          notes: row.notes || '',
          isActive: row.isActive !== 'false',
          createdBy: req.user.id
        };

        // Check if supplier with same code exists
        if (row.code) {
          const existing = await Supplier.findOne({ company: companyId, code: row.code.toUpperCase() });
          if (existing) {
            Object.assign(existing, {
              name: supplierData.name,
              contact: supplierData.contact,
              region: supplierData.region,
              currency: supplierData.currency,
              leadTime: supplierData.leadTime,
              minimumOrder: supplierData.minimumOrder,
              bankName: supplierData.bankName,
              bankAccount: supplierData.bankAccount,
              taxId: supplierData.taxId,
              paymentTerms: supplierData.paymentTerms,
              notes: supplierData.notes,
              isActive: supplierData.isActive
            });
            await existing.save();
            results.updated++;
            continue;
          }
          supplierData.code = row.code.toUpperCase();
        }

        console.log(`[BULK IMPORT] Row ${rowNum}: Creating supplier "${supplierData.name}"`);
        await Supplier.create(supplierData);
        results.created++;
        console.log(`[BULK IMPORT] Row ${rowNum}: Created successfully`);
      } catch (err) {
        console.error(`[BULK IMPORT] Row ${rowNum}: ERROR - ${err.message}`);
        results.errors.push({ row: rowNum, message: err.message });
      }
    }

    console.log(`[BULK IMPORT] Final results:`, JSON.stringify(results));
    res.json({
      success: true,
      message: `Import complete: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors`,
      data: results
    });
  } catch (error) {
    console.error(`[BULK IMPORT] Top-level error:`, error);
    next(error);
  }
};

// @desc    Download CSV template
// @route   GET /api/bulk/template/:type
// @access  Private
exports.downloadTemplate = async (req, res, next) => {
  try {
    const { type } = req.params;

    let columns;
    switch (type) {
      case 'products':
        columns = ['name', 'sku', 'description', 'category', 'unit', 'currentStock', 'lowStockThreshold', 'averageCost', 'sellingPrice', 'supplier', 'barcode', 'barcodeType', 'taxCode', 'taxRate', 'reorderPoint', 'reorderQuantity', 'weight', 'brand', 'location'];
        break;
      case 'clients':
        columns = ['name', 'code', 'type', 'phone', 'email', 'fax', 'website', 'contactPerson', 'address', 'city', 'state', 'zipCode', 'country', 'salesArea', 'salesRepId', 'region', 'industry', 'registrationDate', 'taxId', 'paymentTerms', 'creditLimit', 'notes', 'isActive'];
        break;
      case 'suppliers':
        columns = ['name', 'code', 'phone', 'email', 'fax', 'website', 'contactPerson', 'address', 'city', 'state', 'zipCode', 'country', 'region', 'currency', 'leadTime', 'minimumOrder', 'bankName', 'bankAccount', 'taxId', 'paymentTerms', 'notes', 'isActive'];
        break;
      default:
        return res.status(400).json({ success: false, message: 'Invalid template type. Use: products, clients, suppliers' });
    }

    const csv = stringify([columns], { header: false });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${type}_template.csv`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
};
