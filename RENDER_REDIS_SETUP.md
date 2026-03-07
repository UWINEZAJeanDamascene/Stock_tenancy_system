# Setting Up Redis on Render

Since your system is hosted on Render, here's how to add Redis:

## Option 1: Render Redis Addon (Recommended)

1. **Go to your Render Dashboard**
2. **Select your backend service** (the Express/Node.js service)
3. **Click "Environment"** in the left sidebar
4. **Scroll down and click "Add Redis"** under "Add-ons"
5. **Select a plan** (Free tier available: 25MB cache, expires after 30 days of inactivity)
6. **Click "Add Redis"**

After adding, Render automatically adds a `REDIS_URL` environment variable to your service.

## Option 2: External Redis Service

If you prefer a separate Redis hosting:

### Redis Cloud (Free Tier)
1. Sign up at https://redis.com/cloud/
2. Create a free database
3. Copy the connection URL (looks like: `redis://default:password@host:port`)
4. Add as `REDIS_URL` environment variable in Render

### Upstash (Serverless Redis)
1. Sign up at https://upstash.com/
2. Create a free Redis database
3. Copy the connection URL
4. Add as `REDIS_URL` in Render

## Environment Variable

After setting up Redis on Render, the system will automatically detect and use:

```
REDIS_URL=redis://username:password@host:port
```

The caching layer already supports `REDIS_URL` - no code changes needed!

## Testing Locally

For local development, you can use:

```env
REDIS_URL=redis://localhost:6379
```

Or use individual settings:
```env
REDIS_HOST=localhost
REDIS_PORT=6379
```

## Verifying Connection

The server logs will show:
- `Redis connected successfully` on successful connection
- If Redis is unavailable, the system continues working (fail-open design)
