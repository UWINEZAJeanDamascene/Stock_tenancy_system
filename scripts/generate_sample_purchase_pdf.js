const fs = require('fs');
const PDFDocument = require('pdfkit');

// Generates a sample purchase PDF using purchaseController layout
// Run: node scripts/generate_sample_purchase_pdf.js

const company = { name: 'NBG', address: '123 Bank Street, Kigali', phone: '+250 788 456 789', email: 'info@nbg.rw' };

const samplePurchase = {
  purchaseNumber: 'PUR-2026-00010',
  purchaseDate: new Date(),
  status: 'received',
  currency: 'FRW',
  supplierName: 'RwandaBuild Sup',
  supplierTin: 'SUP-TIN-12345',
  supplierAddress: 'Industrial Area, Kigali',
  items: [
    { product: { name: 'Cement' }, quantity: 100, unitCost: 15000, taxCode: 'A', taxRate: 0, totalWithTax: 1500000 },
    { product: { name: 'Steel Rods' }, quantity: 50, unitCost: 20000, taxCode: 'A', taxRate: 18, totalWithTax: 1180000 }
  ],
  subtotal: 2680000,
  totalTax: 216000,
  grandTotal: 2896000,
  amountPaid: 1000000,
  balance: 1896000,
  notes: 'Deliver to warehouse 3. Inspect goods on arrival.'
};

function fmt(v) { return (samplePurchase.currency === 'USD' ? '$ ' : '') + Number(v || 0).toFixed(2); }

function generate(outputPath) {
  if (!fs.existsSync('Stock-management/backups')) fs.mkdirSync('Stock-management/backups', { recursive: true });
  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // Header
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#111827').text(company.name, 50, 48);
  doc.fontSize(9).fillColor('#6b7280');
  doc.text(company.address, 50, 70);
  doc.text(`Phone: ${company.phone}`, 50, 82);
  doc.text(`Email: ${company.email}`, 50, 94);

  doc.fontSize(14).font('Helvetica-Bold').text('PURCHASE ORDER', 0, 50, { align: 'right' });
  doc.fontSize(10).font('Helvetica').fillColor('#6b7280').text(`# ${samplePurchase.purchaseNumber}`, 0, 70, { align: 'right' });

  // Supplier box
  doc.rect(330, 74, 220, 70).fillAndStroke('#ffffff', '#e5e7eb');
  doc.fillColor('#374151').font('Helvetica-Bold').fontSize(10).text('SUPPLIER', 340, 78);
  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  doc.text(samplePurchase.supplierName, 340, 96);
  doc.text(`TIN: ${samplePurchase.supplierTin}`, 340, 110);
  doc.text(samplePurchase.supplierAddress, 340, 124, { width: 200 });

  // Table header
  let y = 170;
  doc.rect(50, y, doc.page.width - 100, 28).fill('#111827');
  doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
  doc.text('#', 56, y + 8);
  doc.text('Item / Description', 80, y + 8);
  doc.text('Qty', 320, y + 8, { width: 30, align: 'right' });
  doc.text('Unit Cost', 370, y + 8, { width: 70, align: 'right' });
  doc.text('Tax', 450, y + 8, { width: 50, align: 'right' });
  doc.text('Total', 510, y + 8, { width: 70, align: 'right' });
  y += 36;

  doc.font('Helvetica').fontSize(9).fillColor('#111827');
  samplePurchase.items.forEach((item, idx) => {
    if (idx % 2 === 0) doc.rect(50, y - 6, doc.page.width - 100, 18).fill('#f9fafb');
    doc.fillColor('#111827');
    doc.text(String(idx + 1), 56, y);
    doc.text(item.product.name, 80, y, { width: 230 });
    doc.text(String(item.quantity), 320, y, { width: 40, align: 'right' });
    doc.text(fmt(item.unitCost), 370, y, { width: 70, align: 'right' });
    doc.text(`${item.taxCode} (${item.taxRate}%)`, 450, y, { width: 50, align: 'right' });
    doc.text(fmt(item.totalWithTax), 510, y, { width: 70, align: 'right' });
    y += 20;
  });

  // Totals
  y += 10;
  const totalsX = doc.page.width - 260;
  doc.rect(totalsX - 10, y, 230, 110).fill('#ffffff').stroke('#e5e7eb');
  let ty = y + 8;
  doc.fillColor('#6b7280').fontSize(10).font('Helvetica');
  doc.text('Subtotal', totalsX, ty, { width: 140, align: 'left' });
  doc.fillColor('#111827').text(fmt(samplePurchase.subtotal), totalsX + 100, ty, { width: 120, align: 'right' });
  ty += 18;
  doc.fillColor('#6b7280').text('Tax', totalsX, ty);
  doc.fillColor('#111827').text(fmt(samplePurchase.totalTax), totalsX + 100, ty, { width: 120, align: 'right' });
  ty += 18;
  doc.rect(totalsX - 10, ty - 6, 230, 40).fill('#111827');
  doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold').text('TOTAL', totalsX, ty, { width: 140, align: 'left' });
  doc.text(fmt(samplePurchase.grandTotal), totalsX + 100, ty + 2, { width: 120, align: 'right' });

  y += 140;
  if (samplePurchase.notes) {
    doc.fillColor('#374151').fontSize(10).font('Helvetica-Bold').text('NOTES', 56, y);
    y += 14;
    doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(samplePurchase.notes, 56, y, { width: doc.page.width - 120 });
  }

  doc.fontSize(8).fillColor('#9ca3af').text(`Generated: ${new Date().toLocaleString()}`, 50, doc.page.height - 40, { align: 'left' });

  doc.end();
  stream.on('finish', () => console.log('Sample purchase PDF generated at', outputPath));
}

generate('Stock-management/backups/sample-purchase.pdf');
