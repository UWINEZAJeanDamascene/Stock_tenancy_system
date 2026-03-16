# Stock Management System - API Documentation

## Base URL
```
http://localhost:5000/api
```

## Authentication

All endpoints (except login and register) require a JWT token in the Authorization header:

```
Authorization: Bearer <token>
```

## Common Response Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Server Error

## Quick Start Guide

### 1. Register/Login

**Register a new user:**
```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "password123",
  "role": "admin"
}
```

**Login:**
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "password123"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "admin"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 2. Create a Category

```http
POST /api/categories
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Building Materials",
  "description": "Materials for construction"
}
```

### 3. Create a Product

```http
POST /api/products
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Cement",
  "sku": "CEM001",
  "description": "Portland Cement 50kg",
  "category": "<category_id>",
  "unit": "bag",
  "lowStockThreshold": 20
}
```

### 4. Create a Supplier

```http
POST /api/suppliers
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "ABC Building Supplies",
  "contact": {
    "phone": "+1234567890",
    "email": "abc@supplies.com",
    "address": "123 Main St",
    "city": "New York",
    "country": "USA"
  },
  "paymentTerms": "credit_30"
}
```

### 5. Receive Stock

```http
POST /api/stock/movements
Authorization: Bearer <token>
Content-Type: application/json

{
  "product": "<product_id>",
  "quantity": 100,
  "unitCost": 15.50,
  "supplier": "<supplier_id>",
  "batchNumber": "BATCH001",
  "notes": "Initial stock received"
}
```

### 6. Create a Client

```http
POST /api/clients
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "XYZ Construction",
  "type": "company",
  "contact": {
    "phone": "+0987654321",
    "email": "xyz@construction.com",
    "address": "456 Oak Ave",
    "city": "Los Angeles",
    "country": "USA"
  },
  "paymentTerms": "credit_30",
  "creditLimit": 50000
}
```

### 7. Create a Quotation

```http
POST /api/quotations
Authorization: Bearer <token>
Content-Type: application/json

{
  "client": "<client_id>",
  "items": [
    {
      "product": "<product_id>",
      "description": "Cement 50kg bags",
      "quantity": 50,
      "unit": "bag",
      "unitPrice": 20.00,
      "discount": 50,
      "taxRate": 10
    }
  ],
  "validUntil": "2026-03-31",
  "terms": "Payment due within 30 days",
  "notes": "Delivery included"
}
```

### 8. Approve and Convert Quotation to Invoice

**Approve:**
```http
PUT /api/quotations/<quotation_id>/approve
Authorization: Bearer <token>
```

**Convert to Invoice:**
```http
POST /api/quotations/<quotation_id>/convert-to-invoice
Authorization: Bearer <token>
Content-Type: application/json

{
  "dueDate": "2026-04-30"
}
```

### 9. Record Payment

```http
POST /api/invoices/<invoice_id>/payment
Authorization: Bearer <token>
Content-Type: application/json

{
  "amount": 1000,
  "paymentMethod": "bank_transfer",
  "reference": "TXN123456",
  "notes": "Partial payment received"
}
```

## Query Parameters

### Pagination

Most list endpoints support pagination:

```http
GET /api/products?page=1&limit=20
```

### Filtering

```http
GET /api/products?category=<category_id>&isArchived=false
GET /api/invoices?status=pending&clientId=<client_id>
GET /api/stock/movements?type=in&startDate=2026-01-01&endDate=2026-03-01
```

### Sorting

```http
GET /api/products?sortBy=name&order=asc
```

### Search

```http
GET /api/products?search=cement
GET /api/suppliers?search=ABC
```

## Product Lifecycle Tracking

Get complete product history from supplier to consumer:

```http
GET /api/products/<product_id>/lifecycle
Authorization: Bearer <token>
```

Response includes:
- Product details and history
- All stock movements (purchases, sales, adjustments)
- All quotations containing the product
- All invoices containing the product
- Complete timeline of all activities

## Reporting

### Stock Valuation Report

```http
GET /api/reports/stock-valuation?categoryId=<category_id>
Authorization: Bearer <token>
```

### Sales Summary Report

```http
GET /api/reports/sales-summary?startDate=2026-01-01&endDate=2026-03-01
Authorization: Bearer <token>
```

### Product Movement Report

```http
GET /api/reports/product-movement?productId=<product_id>&type=in
Authorization: Bearer <token>
```

### Export Reports

**Excel:**
```http
GET /api/reports/export/excel/stock-valuation
Authorization: Bearer <token>
```

**PDF:**
```http
GET /api/reports/export/pdf/sales-summary
Authorization: Bearer <token>
```

## Dashboard Statistics

```http
GET /api/dashboard/stats
Authorization: Bearer <token>
```

Returns:
- Product statistics (total, low stock, out of stock, total value)
- Invoice statistics (total, pending, monthly, yearly)
- Active quotations
- Total clients

## Low Stock Alerts

```http
GET /api/dashboard/low-stock-alerts
Authorization: Bearer <token>
```

Returns products where current stock ≤ low stock threshold.

## Stock Adjustment

```http
POST /api/stock/adjust
Authorization: Bearer <token>
Content-Type: application/json

{
  "product": "<product_id>",
  "quantity": 5,
  "type": "out",
  "reason": "damage",
  "notes": "Damaged during handling"
}
```

Valid reasons: `damage`, `loss`, `theft`, `expired`, `correction`, `transfer`

## User Management (Admin Only)

### Create User

```http
POST /api/users
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "password": "password123",
  "role": "stock_manager",
  "isActive": true
}
```

### Get User Action Logs

```http
GET /api/users/<user_id>/action-logs?page=1&limit=50&module=product
Authorization: Bearer <token>
```

## Invoice PDF Generation

```http
GET /api/invoices/<invoice_id>/pdf
Authorization: Bearer <token>
```

Returns a PDF file download of the invoice.

## Status Workflows

### Quotation Status Flow
1. `draft` - Initial creation
2. `sent` - Sent to client
3. `approved` - Approved by manager
4. `converted` - Converted to invoice
5. `rejected` - Rejected by client
6. `expired` - Past valid date

### Invoice Status Flow
1. `draft` - Initial creation
2. `pending` - Awaiting payment
3. `partial` - Partially paid
4. `paid` - Fully paid
5. `overdue` - Past due date
6. `cancelled` - Cancelled

## Units of Measurement Supported

- `kg` - Kilogram
- `g` - Gram
- `pcs` - Pieces
- `box` - Box
- `m` - Meter
- `m²` - Square Meter
- `m³` - Cubic Meter
- `l` - Liter
- `ml` - Milliliter
- `ton` - Ton
- `bag` - Bag
- `roll` - Roll
- `sheet` - Sheet
- `set` - Set

## Payment Methods

- `cash`
- `card`
- `bank_transfer`
- `cheque`
- `mobile_money`

## Payment Terms

- `cash` - Cash on delivery
- `credit_7` - 7 days credit
- `credit_15` - 15 days credit
- `credit_30` - 30 days credit
- `credit_45` - 45 days credit
- `credit_60` - 60 days credit

## Best Practices

1. **Always authenticate** - Include JWT token in all requests
2. **Handle pagination** - Use appropriate page size for large datasets
3. **Filter data** - Use query parameters to get relevant data
4. **Check stock before sales** - Ensure sufficient stock before creating invoices
5. **Track everything** - System automatically logs all activities
6. **Use lifecycle endpoint** - For complete product traceability
7. **Regular reports** - Generate reports for business insights
8. **Manage permissions** - Use appropriate user roles

## Error Handling Examples

**Invalid credentials:**
```json
{
  "success": false,
  "message": "Invalid credentials"
}
```

**Insufficient stock:**
```json
{
  "success": false,
  "message": "Adjustment quantity exceeds current stock"
}
```

**Unauthorized:**
```json
{
  "success": false,
  "message": "User role 'viewer' is not authorized to access this route"
}
```

**Validation error:**
```json
{
  "success": false,
  "message": "Please provide a product name, Please provide a SKU"
}
```

## Testing with cURL

```bash
# Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john@example.com","password":"password123"}'

# Get products (replace <token> with actual token)
curl -X GET http://localhost:5000/api/products \
  -H "Authorization: Bearer <token>"

# Create product
curl -X POST http://localhost:5000/api/products \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Cement","sku":"CEM001","category":"<category_id>","unit":"bag"}'
```

## Rate Limiting

API is rate-limited to 100 requests per 15 minutes per IP address to prevent abuse.

## CORS

CORS is enabled for all origins in development. Configure appropriately for production.

## Health Check

```http
GET /health
```

Returns server status without authentication.
