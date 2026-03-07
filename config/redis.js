const Redis = require('ioredis');
const { UpstashRedis } = (() => {
  try {
    // lazy require to avoid hard dependency if not installed
    return { UpstashRedis: require('@upstash/redis').Redis };
  } catch (e) {
    return {};
  }
})();

// Redis configuration with connection pooling for high performance
// Supports: Local Redis, Redis Cloud, Render Redis, Upstash, AWS ElastiCache, etc.
// Uses REDIS_URL if available, or UPSTASH_REDIS_REST_URL for Upstash serverless Redis

const createRedisClient = () => {
  const redisConfig = {
    // Connection settings optimized for high throughput
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) {
        console.error('Redis connection failed after 3 retries');
        return null; // Stop retrying
      }
      return Math.min(times * 200, 2000);
    },
    enableReadyCheck: true,
    lazyConnect: false,
    // Performance optimizations
    family: 4, // IPv4
    keepAlive: true,
    connectTimeout: 10000,
    commandTimeout: 5000,
  };

  // Check for Upstash Redis (serverless Redis with REST API)
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    // Prefer the Upstash HTTP client for serverless Upstash endpoints
    if (UpstashRedis) {
      console.log('Using @upstash/redis (REST) client for Upstash');
      return new UpstashRedis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
    }

    // Fallback: if @upstash/redis not available, attempt ioredis with a compatible URL
    console.log('Using ioredis with UPSTASH_REDIS_REST_URL (ensure URL is Redis-compatible)');
    return new Redis(process.env.UPSTASH_REDIS_REST_URL, {
      ...redisConfig,
      password: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }

  // Check for REDIS_URL (Render, Redis Cloud, Upstash legacy, etc.)
  if (process.env.REDIS_URL) {
    console.log('Using REDIS_URL for connection (production mode)');
    return new Redis(process.env.REDIS_URL, redisConfig);
  }

  // Check if running in cluster mode
  if (process.env.REDIS_CLUSTER_NODES) {
    const clusterNodes = process.env.REDIS_CLUSTER_NODES.split(',').map(node => {
      const [host, port] = node.split(':');
      return { host, port: parseInt(port) };
    });

    return new Redis.Cluster(clusterNodes, {
      ...redisConfig,
      redisOptions: {
        password: process.env.REDIS_PASSWORD,
      },
    });
  }

  // Single Redis instance configuration (local/development)
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
    ...redisConfig,
  });
};

// Create Redis client instance
const redisClient = createRedisClient();

// Event handlers for monitoring
redisClient.on('connect', () => {
  console.log('Redis connected successfully');
});

redisClient.on('ready', () => {
  console.log('Redis client ready');
});

redisClient.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redisClient.on('close', () => {
  console.log('Redis connection closed');
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Closing Redis connection...');
  await redisClient.quit();
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Export the client and a function to get a new client if needed
module.exports = {
  redisClient,
  createRedisClient,
  // Helper to get a client for specific operations (e.g., different DB)
  getClient: (db = 0) => {
    if (process.env.REDIS_URL) {
      return new Redis(process.env.REDIS_URL, { db });
    }
    if (process.env.REDIS_CLUSTER_NODES) {
      return redisClient; // Cluster mode uses same client
    }

    // If using Upstash REST and upstash client exists, return a new Upstash client
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN && UpstashRedis) {
      return new UpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    }

    return new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db,
    });
  },
};
