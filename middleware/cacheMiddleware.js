const cacheService = require('../services/cacheService');
const jwt = require('jsonwebtoken');
const sessionService = require('../services/sessionService');

/**
 * Cache middleware factory
 * Caches GET request responses automatically
 * 
 * @param {Object} options - Cache options
 * @param {string} options.type - Cache type (product, category, etc.)
 * @param {Function} options.keyGenerator - Function to generate cache key from req
 * @param {number} options.ttl - Custom TTL in seconds
 * @param {boolean} options.skipCache - Function to determine if should skip cache
 */
const cacheMiddleware = (options = {}) => {
  const {
    type = 'default',
    keyGenerator = null,
    ttl = null,
    skipCache = null,
  } = options;

  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Skip cache if configured
    if (skipCache && skipCache(req)) {
      return next();
    }

    try {
      // Generate cache key
      let cacheKey;
      if (keyGenerator) {
        cacheKey = keyGenerator(req);
      } else {
        // Default key generation based on URL
        const params = {
          path: req.path,
          query: req.query,
          companyId: req.company?._id?.toString() || req.query.companyId,
        };
        cacheKey = cacheService.generateKey(type, params);
      }

      // Try to get cached response
      const cachedResponse = await cacheService.get(cacheKey);
      
      if (cachedResponse) {
        // Return cached response
        return res.status(200).json({
          ...cachedResponse,
          fromCache: true,
        });
      }

      // Store original json method
      const originalJson = res.json.bind(res);

      // Override json method to cache response
      res.json = async (data) => {
        // Only cache successful responses
        if (res.statusCode === 200 && data) {
          await cacheService.set(cacheKey, data, ttl);
        }
        return originalJson(data);
      };

      next();
    } catch (error) {
      console.error('Cache middleware error:', error);
      next();
    }
  };
};

/**
 * Cache invalidation middleware
 * Invalidates cache after mutations (POST, PUT, DELETE)
 * 
 * @param {Object} options - Invalidation options
 * @param {string} options.type - Cache type to invalidate
 * @param {Function} options.keyGenerator - Function to generate key to invalidate
 * @param {boolean} options.invalidateAll - Invalidate all cache of this type
 */
const cacheInvalidationMiddleware = (options = {}) => {
  const {
    type = 'default',
    keyGenerator = null,
    invalidateAll = false,
    invalidateByCompany = true,
  } = options;

  return async (req, res, next) => {
    // Only invalidate on mutations
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    // Store original json to intercept response
    const originalJson = res.json.bind(res);

    // Override json to invalidate after successful mutation
    res.json = async (data) => {
      // Only invalidate on successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          if (invalidateAll) {
            await cacheService.invalidateType(type);
          } else if (keyGenerator) {
            const key = keyGenerator(req, data);
            await cacheService.delete(key);
          } else if (invalidateByCompany && req.company?._id) {
            await cacheService.invalidateByCompany(
              req.company._id.toString(),
              type
            );
          }
        } catch (error) {
          console.error('Cache invalidation error:', error);
        }
      }

      return originalJson(data);
    };

    next();
  };
};

/**
 * Express middleware for session management with Redis
 * Adds session data to request object
 */
const sessionMiddleware = async (req, res, next) => {
  // Skip for public routes
  if (req.path.startsWith('/api/auth/login') || 
      req.path.startsWith('/api/auth/register')) {
    return next();
  }

  // Try to attach session data based on token or user
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer')) {
      return next();
    }

    const token = authHeader.split(' ')[1];

    // Check blacklist first
    const isBlacklisted = await sessionService.isTokenBlacklisted(token);
    if (isBlacklisted) {
      return res.status(401).json({ success: false, message: 'Token has been revoked' });
    }

    // If `req.user` already exists (auth middleware ran earlier), use it
    if (req.user && req.user._id) {
      const session = await sessionService.getSession(req.user._id.toString());
      if (session) req.session = session;
      return next();
    }

    // Try quick token->user mapping stored in Redis
    const byToken = await sessionService.getUserByToken(token);
    if (byToken) {
      req.session = byToken;
      return next();
    }

    // As a last resort, decode JWT to find user id and load session
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const userId = payload.id || payload._id || null;
      if (userId) {
        const session = await sessionService.getSession(userId.toString());
        if (session) req.session = session;
      }
    } catch (e) {
      // ignore invalid tokens here; auth middleware will handle if required
    }
  } catch (error) {
    console.error('Session middleware error:', error);
  }

  next();
};

/**
 * Middleware to add cache control headers
 */
const cacheControl = (options = {}) => {
  const {
    maxAge = 0,
    mustRevalidate = true,
    private = false,
  } = options;

  return (req, res, next) => {
    if (req.method !== 'GET') {
      return next();
    }

    const directives = [];
    
    if (maxAge > 0) {
      directives.push(`max-age=${maxAge}`);
      if (mustRevalidate) {
        directives.push('must-revalidate');
      }
    } else {
      directives.push('no-cache');
    }

    if (private) {
      directives.push('private');
    } else {
      directives.push('public');
    }

    res.setHeader('Cache-Control', directives.join(', '));
    next();
  };
};

module.exports = {
  cacheMiddleware,
  cacheInvalidationMiddleware,
  sessionMiddleware,
  cacheControl,
};
