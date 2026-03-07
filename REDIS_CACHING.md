# Redis Caching Layer Documentation

This document describes the Redis caching layer implementation for the Stock Management System, providing high-speed performance for millions of company data operations.

## Overview

The caching layer provides three main functionalities:
1. **Session Management** - Fast distributed session storage
2. **Query Caching** - Cache database query results
3. **Rate Limiting** - Distributed rate limiting across multiple server instances

## Architecture

### Files Created

| File | Description |
|------|-------------|
| [`config/redis.js`](config/redis.js) | Redis client configuration with connection pooling |
| [`services/sessionService.js`](services/sessionService.js) | Session management with Redis |
| [`services/cacheService.js`](services/cacheService.js) | Query caching service |
| [`middleware/redisRateLimiter.js`](middleware/redisRateLimiter.js) | Redis-based rate limiter |
| [`middleware/cacheMiddleware.js`](middleware/cacheMiddleware.js) | Express middleware for caching |

## Configuration

### Environment Variables

Add these to your `.env` file:

```env
# Redis Connection
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_DB=0

# Session TTL (seconds)
SESSION_TTL=86400
```

### Redis Connection Options

The configuration includes:
- **Connection pooling** - Optimized for high throughput
- **Auto-retry** - Automatic reconnection with exponential backoff
- **Fail-open** - System continues working if Redis fails
- **Cluster support** - Horizontal scaling with Redis Cluster

## Session Management

### Features

- **Distributed sessions** - Works across multiple server instances
- **Token mapping** - Quick lookup from token to user
- **Session extension** - Automatically extends active sessions
- **Token blacklist** - Immediate session revocation on logout
- **Activity tracking** - Last activity timestamp

### Usage

```javascript
const sessionService = require('./services/sessionService');

// Create session on login
await sessionService.createSession(userId, companyId, role, token, metadata);

// Get session
const session = await sessionService.getSession(userId);

// Get user by token (fast lookup)
const session = await sessionService.getUserByToken(token);

// Delete session on logout
await sessionService.deleteSession(userId, token);

// Blacklist token (immediate revocation)
await sessionService.blacklistToken(token);

// Check if token is blacklisted
const isBlacklisted = await sessionService.isTokenBlacklisted(token);
```

### Default TTL

- Session: 24 hours (configurable via `SESSION_TTL`)

## Query Caching

### Features

- **Type-based caching** - Different TTLs per data type
- **Company isolation** - Cache per company for multi-tenant
- **Automatic invalidation** - Clear cache on data mutations
- **Cache warming** - Pre-load common queries

### Cache Types & TTL

| Type | Default TTL | Use Case |
|------|-------------|----------|
| `product` | 2 min | Frequently updated |
| `category` | 10 min | Rarely changes |
| `company` | 5 min | Company data |
| `user` | 5 min | User profiles |
| `dashboard` | 1 min | Dynamic stats |
| `stock` | 1 min | Stock levels |
| `report` | 15 min | Expensive queries |
| `default` | 5 min | Generic |

### Usage

```javascript
const cacheService = require('./services/cacheService');

// Cache a query result
await cacheService.cacheQuery('product', { companyId: 'abc', id: '123' }, productData);

// Get cached query
const cached = await cacheService.getCachedQuery('product', { companyId: 'abc', id: '123' });

// Wrap function with caching
const { data, fromCache } = await cacheService.cached(
  () => Product.findById(id),
  'product',
  { companyId, id },
  120 // custom TTL
);

// Invalidate cache
await cacheService.invalidate('product', productId);
await cacheService.invalidateType('product');
await cacheService.invalidateByCompany(companyId);

// Cache middleware usage
const cacheMiddleware = require('./middleware/cacheMiddleware').cacheMiddleware;

// Apply to route
app.get('/api/products', cacheMiddleware({ type: 'product', ttl: 120 }), productController.getProducts);
```

## Rate Limiting

### Features

- **Distributed limiting** - Works across multiple instances
- **Multiple limiters** - Different limits per route type
- **Per-IP/User/Company** - Flexible limiting strategies
- **Custom handlers** - Configurable response

### Pre-configured Limiters

| Limiter | Window | Max Requests | Use Case |
|---------|--------|--------------|----------|
| `auth` | 15 min | 10 | Login/Register |
| `api` | 1 min | 100 | General API |
| `write` | 1 min | 30 | Write operations |
| `search` | 1 min | 20 | Search queries |
| `upload` | 1 min | 10 | File uploads |
| `company` | 1 min | 200 | Per-company |
| `strict` | 1 min | 50 | IP strict |

### Usage

```javascript
const { createRateLimiter, createRateLimiters } = require('./middleware/redisRateLimiter');

// Use predefined limiter
const { api } = createRateLimiters();
app.use('/api/', api);

// Create custom limiter
const customLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 50,
  keyPrefix: 'ratelimit:custom',
  limitBy: 'user', // ip, user, company
});

app.get('/api/custom', customLimiter, controller);

// Check rate limit status
const { getRateLimitStatus, resetRateLimit } = require('./middleware/redisRateLimiter');

const status = await getRateLimitStatus('192.168.1.1', 'ratelimit:api');
await resetRateLimit(userId, 'ratelimit:api');
```

## Integration

### Server Integration

The caching layer is integrated in `server.js`:

```javascript
// Redis rate limiting
const { createRateLimiters } = require('./middleware/redisRateLimiter');
const rateLimiters = createRateLimiters();

// Apply to routes
app.use('/api/auth', rateLimiters.auth);
app.use('/api/', rateLimiters.api);

// Session middleware
const { sessionMiddleware } = require('./middleware/cacheMiddleware');
app.use(sessionMiddleware);
```

### Auth Controller Integration

Sessions are created automatically on login and cleared on logout:

```javascript
// On login (in authController.js)
await sessionService.createSession(userId, companyId, role, token, metadata);

// On logout
await sessionService.deleteSession(userId, token);
await sessionService.blacklistToken(token);
```

## Performance Optimization Tips

### For Millions of Companies

1. **Use Redis Cluster** - Horizontal scaling for high throughput
   ```env
   REDIS_CLUSTER_NODES=node1:6379,node2:6379,node3:6379
   ```

2. **Optimize Cache TTLs** - Shorter TTLs for frequently changing data
   - Products: 30-60 seconds
   - Dashboard: 10-30 seconds
   - Static data: 5-15 minutes

3. **Use Pipeline** - Batch multiple Redis operations
   ```javascript
   const pipeline = redisClient.pipeline();
   pipeline.set('key1', 'value1');
   pipeline.set('key2', 'value2');
   await pipeline.exec();
   ```

4. **Monitor Redis** - Use Redis INFO for monitoring
   ```javascript
   const info = await redisClient.info('stats');
   ```

5. **Connection Pooling** - Configure pool size for your workload

## Troubleshooting

### Redis Connection Issues

If Redis fails to connect:
- Check Redis server is running: `redis-cli ping`
- Verify connection settings in `.env`
- Check firewall rules

### Cache Not Working

- Ensure Redis is connected
- Check cache key generation
- Verify TTL settings

### Rate Limiting Issues

- Check Redis is connected
- Verify limit configuration
- Check headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`

## Monitoring

### Redis Health Check

```javascript
const { redisClient } = require('./config/redis');

// Check connection
redisClient.ping().then(console.log);

// Get memory info
redisClient.info('memory');
```

### Cache Statistics

```javascript
const cacheService = require('./services/cacheService');
const stats = await cacheService.getStats();
```

## Future Enhancements

1. **Cache tags** - Group and invalidate by tags
2. **Serialization** - Support for more data types
3. **Cache aside pattern** - Full implementation
4. **Redis Sentinel** - High availability
5. **Monitoring dashboard** - Real-time cache metrics
