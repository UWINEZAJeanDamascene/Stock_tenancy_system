# Stock Management System - Backend

A comprehensive backend system for managing stock/inventory with full product lifecycle traceability, built with Node.js, Express, and MongoDB.

## Features

### 1. Product Management
- Create, update, and archive products
- Complete product history log with timestamps
- Support for multiple units of measurement (kg, pcs, m², etc.)
- Product categorization
- Low stock alerts

### 2. Stock/Inventory Management
- Receive stock from suppliers with batch/lot tracking
- Complete stock movement history
- Auto-calculated current stock levels
- Stock adjustments (damage, loss, corrections)
- Real-time stock valuation

### 3. Supplier Management
- Supplier profiles with contact information
- Link deliveries to specific suppliers
- Purchase history tracking
- Payment terms management

### 4. Quotation Management
- Create and manage quotations
- Multiple status tracking (Draft → Sent → Approved → Converted)
- Auto-convert quotations to invoices
- Product and client linkage

### 5. Invoice/Receipt Management
- Auto-generate invoices from quotations or manual creation
- Payment tracking
- Automatic stock deduction on payment
- Multi-payment support
- Invoice status management

### 6. Client/Consumer Management
- Client profiles and contact management
- Purchase history
- Outstanding invoices tracking
- Credit limit management

### 7. Full Product Lifecycle Traceability
- Complete product history from supplier to final consumer
- Timeline view for each product
- Track all quotations and invoices containing specific products

### 8. User & Role Management
- Multiple user roles: Admin, Stock Manager, Sales, Viewer
- Action logging for all user activities
- Secure authentication with JWT

### 9. Reporting & Export
- Stock valuation reports
- Sales summary reports
- Product movement reports
- Client and supplier reports
- Export to PDF and Excel

## Installation

1. **Clone the repository**
   ```bash
   cd stock-backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   - Copy `.env` file and update with your settings
   - Update `MONGODB_URI` with your MongoDB connection string
   - Set a secure `JWT_SECRET`

4. **Start the server**
   ```bash
   # Development mode with auto-restart
   npm run dev

   # Production mode
   npm start
   ```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/update-password` - Update password
- `POST /api/auth/logout` - Logout user

### Products
- `GET /api/products` - Get all products
- `GET /api/products/:id` - Get single product
- `POST /api/products` - Create product
- `PUT /api/products/:id` - Update product
- `PUT /api/products/:id/archive` - Archive product
- `PUT /api/products/:id/restore` - Restore product
- `GET /api/products/:id/history` - Get product history
- `GET /api/products/:id/lifecycle` - Get complete product lifecycle
- `GET /api/products/low-stock` - Get low stock products

### Stock Management
- `GET /api/stock/movements` - Get all stock movements
- `GET /api/stock/movements/:id` - Get single movement
- `POST /api/stock/movements` - Receive stock
- `POST /api/stock/adjust` - Adjust stock
- `GET /api/stock/product/:productId/movements` - Get product movements
- `GET /api/stock/summary` - Get stock summary

### Suppliers
- `GET /api/suppliers` - Get all suppliers
- `GET /api/suppliers/:id` - Get single supplier
- `POST /api/suppliers` - Create supplier
- `PUT /api/suppliers/:id` - Update supplier
- `DELETE /api/suppliers/:id` - Delete supplier
- `GET /api/suppliers/:id/purchase-history` - Get purchase history

### Clients
- `GET /api/clients` - Get all clients
- `GET /api/clients/:id` - Get single client
- `POST /api/clients` - Create client
- `PUT /api/clients/:id` - Update client
- `DELETE /api/clients/:id` - Delete client
- `GET /api/clients/:id/purchase-history` - Get purchase history
- `GET /api/clients/:id/outstanding-invoices` - Get outstanding invoices

### Quotations
- `GET /api/quotations` - Get all quotations
- `GET /api/quotations/:id` - Get single quotation
- `POST /api/quotations` - Create quotation
- `PUT /api/quotations/:id` - Update quotation
- `DELETE /api/quotations/:id` - Delete quotation
- `PUT /api/quotations/:id/approve` - Approve quotation
- `POST /api/quotations/:id/convert-to-invoice` - Convert to invoice

### Invoices
- `GET /api/invoices` - Get all invoices
- `GET /api/invoices/:id` - Get single invoice
- `POST /api/invoices` - Create invoice
- `PUT /api/invoices/:id` - Update invoice
- `DELETE /api/invoices/:id` - Delete invoice
- `POST /api/invoices/:id/payment` - Record payment
- `PUT /api/invoices/:id/cancel` - Cancel invoice
- `GET /api/invoices/:id/pdf` - Generate PDF

### Reports
- `GET /api/reports/stock-valuation` - Stock valuation report
- `GET /api/reports/sales-summary` - Sales summary report
- `GET /api/reports/product-movement` - Product movement report
- `GET /api/reports/client-sales` - Client sales report
- `GET /api/reports/supplier-purchase` - Supplier purchase report
- `GET /api/reports/export/excel/:reportType` - Export to Excel
- `GET /api/reports/export/pdf/:reportType` - Export to PDF

### Dashboard
- `GET /api/dashboard/stats` - Get dashboard statistics
- `GET /api/dashboard/recent-activities` - Get recent activities
- `GET /api/dashboard/low-stock-alerts` - Get low stock alerts
- `GET /api/dashboard/top-selling-products` - Get top selling products
- `GET /api/dashboard/top-clients` - Get top clients
- `GET /api/dashboard/sales-chart` - Get sales chart data
- `GET /api/dashboard/stock-movement-chart` - Get stock movement chart

### Users (Admin only)
- `GET /api/users` - Get all users
- `GET /api/users/:id` - Get single user
- `POST /api/users` - Create user
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user
- `GET /api/users/:id/action-logs` - Get user action logs

### Categories
- `GET /api/categories` - Get all categories
- `GET /api/categories/:id` - Get single category
- `POST /api/categories` - Create category
- `PUT /api/categories/:id` - Update category
- `DELETE /api/categories/:id` - Delete category

## User Roles & Permissions

### Admin
- Full access to all features
- User management
- System configuration

### Stock Manager
- Product management
- Stock management
- Supplier management
- View all reports

### Sales
- Create and manage quotations
- Create and manage invoices
- Client management
- View sales reports

### Viewer
- Read-only access
- View products, stock, and reports
- Cannot create or modify data

## Authentication

All API endpoints (except login and register) require authentication using JWT tokens.

Include the token in the Authorization header:
```
Authorization: Bearer <your-token>
```

## Database Models

- **User** - User accounts and authentication
- **Product** - Product information and history
- **Category** - Product categories
- **Supplier** - Supplier information
- **Client** - Client/customer information
- **StockMovement** - All stock in/out movements
- **Quotation** - Sales quotations
- **Invoice** - Sales invoices and payments
- **ActionLog** - User activity logging

## Environment Variables

```env
PORT=5000
NODE_ENV=development
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
JWT_EXPIRE=7d
LOW_STOCK_THRESHOLD=10
DEFAULT_PAGE_SIZE=20
MAX_PAGE_SIZE=100
```

## Error Handling

The API uses consistent error responses:

```json
{
  "success": false,
  "message": "Error message here"
}
```

## Success Responses

All successful responses follow this format:

```json
{
  "success": true,
  "data": { ... }
}
```

For paginated responses:

```json
{
  "success": true,
  "count": 20,
  "total": 100,
  "pages": 5,
  "currentPage": 1,
  "data": [ ... ]
}
```

## Development

```bash
npm run dev
```

This runs the server with nodemon for auto-restart on file changes.

## Production Deployment

1. Set `NODE_ENV=production` in your environment
2. Use a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name stock-backend
   ```

## Security Features

- JWT authentication
- Password hashing with bcrypt
- Helmet.js for HTTP headers security
- Rate limiting
- CORS configuration
- Input validation
- Role-based access control

## Support

For issues and questions, please contact the development team.

## License

ISC

---

# Performance & Scalability Guide

This document covers performance optimizations and scalability recommendations for handling big data and multiple companies.

## Current Capacity Estimates

| Scenario | Expected Performance |
|----------|---------------------|
| 1 company, 10K invoices | Fast |
| 10 companies, 100K invoices | Moderate (needs caching) |
| 100 companies, 1M invoices | Slow (needs optimization) |
| 1000+ companies | Needs architectural changes |

---

## Critical Performance Issues

### 1. Missing Database Indexes
The current indexes are insufficient for report queries. Add these indexes to improve query performance:

```javascript
// models/Invoice.js - Add these indexes
invoiceSchema.index({ company: 1, status: 1 });
invoiceSchema.index({ company: 1, paidDate: 1 });
invoiceSchema.index({ company: 1, invoiceDate: 1 });
invoiceSchema.index({ 'payments.paidDate': 1 });

// models/Product.js
productSchema.index({ company: 1, category: 1 });
productSchema.index({ company: 1, isArchived: 1 });

// models/Purchase.js
purchaseSchema.index({ company: 1, status: 1 });
purchaseSchema.index({ company: 1, purchaseDate: 1 });
```

### 2. N+1 Query Problem
Report controllers loop through invoices and populate items individually - extremely slow. Use MongoDB Aggregation Pipeline instead.

### 3. No Caching Implemented
Redis services exist in `/services/` but are NOT integrated. Implement caching for:
- Report results (5-15 min TTL)
- Product/category lists (2-10 min TTL)
- Dashboard stats (1 min TTL)

---

## Optimization Roadmap

### Phase 1: Quick Wins (1-2 weeks)

1. **Add Database Indexes** - Immediate performance boost
2. **Integrate Redis Caching** - Services already exist in `/services/`
3. **Optimize Report Queries** - Use Aggregation Pipeline

### Phase 2: Architecture (1-2 months)

1. **Pre-computed Aggregations** - Run nightly jobs to calculate totals
2. **Background Jobs** - Use Bull/BullMQ for:
   - Recurring invoice generation
   - Report generation
   - Email notifications
3. **Read Replicas** - MongoDB Atlas for scaling reads

### Phase 3: Enterprise (Ongoing)

1. **Microservices** - Split into:
   - Auth service
   - Invoice service
   - Inventory service
   - Report service
2. **CDN** - Cloudflare for static assets
3. **Database Sharding** - By company_id for massive scale

---

## Redis Caching Implementation

Redis services are already created but not integrated. To enable:

1. Add Redis configuration to `.env`:
```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_DB=0
SESSION_TTL=86400
```

2. Import and use in controllers:
```javascript
const cacheService = require('./services/cacheService');

// Cache expensive queries
const cached = await cacheService.getCachedQuery('report', { companyId, type });
if (cached) return cached;

// After query completes
await cacheService.cacheQuery('report', { companyId, type }, result, 900); // 15 min
```

---

## Background Jobs (Recommended)

For better performance, implement background job processing:

1. **Install BullMQ**:
```bash
npm install bullmq
```

2. **Use cases**:
- Generate large reports asynchronously
- Send email notifications
- Process recurring invoices
- Data cleanup tasks

---

## Monitoring Recommendations

1. **MongoDB Ops Manager** or **MongoDB Atlas** - Track slow queries
2. **PM2 Plus** - Node.js application monitoring
3. **Redis Monitor** - Track cache hit rates
4. **APM Tools** - New Relic, DataDog, or open-source alternatives

---

## Quick Wins Checklist

- [x] Add database indexes to Invoice, Purchase, Product models
- [ ] Integrate Redis caching services
- [ ] Optimize report aggregation queries
- [ ] Add pagination to all list endpoints
- [ ] Implement request timeout handling
- [ ] Add connection pooling configuration

---

*For detailed Redis caching documentation, see `REDIS_CACHING.md`*
*For missing features recommendations, see `MISSING_FEATURES_RECOMMENDATIONS.md`*

# Stock-management