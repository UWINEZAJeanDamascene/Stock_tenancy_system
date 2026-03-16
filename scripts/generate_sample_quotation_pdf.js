const fs = require('fs');
const path = require('path');

// Monkeypatch Quotation.findOne to return a mock without DB connection
const QuotationModelPath = path.join(__dirname, '..', 'models', 'Quotation.js');
const Quotation = require(QuotationModelPath);

const mockQuotation = {
  quotationNumber: 'QUO-2026-00093',
  createdAt: new Date('2026-03-09T00:00:00Z'),
  validUntil: new Date('2026-04-08T00:00:00Z'),
  status: 'CONVERTED',
  client: {
    name: 'WASAC Ltd',
    taxId: '103370539',
    contact: {
      address: 'KG 7 Ave, Kigali',
      phone: '+250 788 456 789',
      email: 'info@wasac.rw'
    }
  },
  items: [
    {
      product: { name: 'Cement' },
      description: 'Cement',
      quantity: 50,
      unit: 'bag',
      unitPrice: 18000,
      taxRate: 0,
      total: 900000
    },
    {
      product: { name: 'Nails' },
      description: 'Nails',
      quantity: 100,
      unit: 'kg',
      unitPrice: 12000,
      taxRate: 18,
      total: 1416000
    }
  ],
  subtotal: 2100000,
  totalTax: 216000,
  grandTotal: 2316000,
  terms: 'Payment due within 30 days',
  notes: 'Deliver to site on receipt of order'
};

// Override findOne to return object with populate chain
Quotation.findOne = function () {
  return {
    populate: function () {
      return {
        populate: function () {
          return {
            populate: function () {
              return Promise.resolve(mockQuotation);
            }
          };
        }
      };
    }
  };
};

const controller = require(path.join(__dirname, '..', 'controllers', 'quotationController.js'));

const outDir = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'sample-quotation.pdf');
const ws = fs.createWriteStream(outPath);

// preserve original end to avoid recursive override
const originalWsEnd = ws.end.bind(ws);
const res = Object.assign(ws, {
  setHeader: () => {},
  status: () => ({ json: () => {} }),
  end: () => originalWsEnd()
});

const req = {
  user: { company: { _id: 'mock-company' } },
  params: { id: 'mock-id' }
};

(async () => {
  try {
    await controller.generateQuotationPDF(req, res, (err) => { if (err) console.error(err); });
    ws.on('finish', () => console.log('Sample quotation PDF generated at', outPath));
  } catch (e) {
    console.error('Error generating sample quotation PDF', e);
    ws.end();
  }
})();
