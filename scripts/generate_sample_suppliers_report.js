const fs = require('fs');
const PDFDocument = require('pdfkit');

const sampleCompany = { name: 'NBG', tin: 'GHJ123', address: 'Bank Street, Kigali' };
const sampleSuppliers = [
  { code: 'SUP17729', name: 'Rwandabuild Sup', email: 'info@rwandabuild.rw', phone: '+250 788 456 789', address: 'Industrial Area', totalPurchases: 3388000, balance: 0 },
  { code: 'SUP2001', name: 'Example Supplier', email: 'supplier@example.com', phone: '+250 700 000 001', address: 'Kigali', totalPurchases: 1500000, balance: 50000 }
];

function fmt(v) { return Number(v || 0).toFixed(2); }

function generate(outputPath) {
  if (!fs.existsSync('Stock-management/backups')) fs.mkdirSync('Stock-management/backups', { recursive: true });
  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  doc.fontSize(16).text(sampleCompany.name, { align: 'center' });
  doc.fontSize(10).text(`TIN: ${sampleCompany.tin}`, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(14).text('SUPPLIERS LIST', { align: 'center', underline: true });
  doc.fontSize(9).text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });
  doc.moveDown(1.5);

  const supHeaders = ['Code', 'Supplier Name', 'Email', 'Phone', 'Address', 'Total Purchases', 'Balance'];
  const supColWidths = [50, 120, 120, 80, 120, 80, 80];

  const renderTableHeader = (y) => {
    doc.rect(40, y, doc.page.width - 80, 28).fill('#111827');
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
    let x = 48;
    supHeaders.forEach((h, i) => { doc.text(h, x, y + 8, { width: supColWidths[i] }); x += supColWidths[i]; });
  };

  let y = doc.y;
  renderTableHeader(y);
  y += 36;
  doc.font('Helvetica').fontSize(9).fillColor('#111827');

  sampleSuppliers.forEach((supplier, idx) => {
    if (idx % 2 === 0) doc.rect(40, y - 6, doc.page.width - 80, 18).fill('#f9fafb');
    const row = [supplier.code, supplier.name, supplier.email, supplier.phone, supplier.address, fmt(supplier.totalPurchases), fmt(supplier.balance)];
    let x = 48;
    row.forEach((cell, i) => {
      if (i >= 5) doc.text(cell, x, y, { width: supColWidths[i], align: 'right' });
      else doc.text(String(cell).substring(0, Math.floor(supColWidths[i] / 6)), x, y, { width: supColWidths[i] });
      x += supColWidths[i];
    });
    y += 20;
  });

  y += 10;
  doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
  y += 10;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827');
  doc.text(`Total Suppliers: ${sampleSuppliers.length}`, 48, y);
  doc.text(`Total Purchases: ${sampleSuppliers.reduce((s, p) => s + p.totalPurchases,0).toFixed(2)}`, 48, y + 16);
  doc.text(`Total Balance Due: ${sampleSuppliers.reduce((s,p)=>s+p.balance,0).toFixed(2)}`, 300, y + 16);

  doc.fontSize(8).fillColor('#9ca3af').text(`Generated: ${new Date().toLocaleString()}`, 50, doc.page.height - 40, { align: 'left' });

  doc.end();
  stream.on('finish', () => console.log('Sample suppliers report generated at', outputPath));
}

generate('Stock-management/backups/sample-suppliers-report.pdf');
