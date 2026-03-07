const { redisClient } = require('../config/redis');
const jwt = require('jsonwebtoken');

// Session configuration
const SESSION_TTL = parseInt(process.env.SESSION_TTL) || 86400; // 24 hours default
const SESSION_PREFIX = 'session:';
const TOKEN_BLACKLIST_PREFIX = 'blacklist:';

// Session data structure
class SessionService {
  /**
   * Create a new session for a user
   * @param {string} userId - User ID
   * @param {string} companyId - Company ID
   * @param {string} role - User role
   * @param {string} token - JWT token
   * @param {Object} additionalData - Additional session data
   */
  async createSession(userId, companyId, role, token, additionalData = {}) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    const sessionData = {
      userId,
      companyId,
      role,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      ...additionalData,
    };

    try {
      // Store session data
      await redisClient.setex(sessionKey, SESSION_TTL, JSON.stringify(sessionData));

      // Store token-to-user mapping for quick lookup
      const tokenKey = `${SESSION_PREFIX}token:${token}`;
      await redisClient.setex(tokenKey, SESSION_TTL, userId);

      console.log(`Session created for user: ${userId}`);
      return sessionData;
    } catch (error) {
      console.error('Error creating session:', error);
      throw error;
    }
  }

  /**
   * Get session data by user ID
   * @param {string} userId - User ID
   */
  async getSession(userId) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;

    try {
      const sessionData = await redisClient.get(sessionKey);
      if (!sessionData) {
        return null;
      }

      const parsed = JSON.parse(sessionData);
      // Update last activity
      parsed.lastActivity = new Date().toISOString();
      await redisClient.setex(sessionKey, SESSION_TTL, JSON.stringify(parsed));

      return parsed;
    } catch (error) {
      console.error('Error getting session:', error);
      return null;
    }
  }

  /**
   * Get user by token (quick lookup)
   * @param {string} token - JWT token
   */
  async getUserByToken(token) {
    const tokenKey = `${SESSION_PREFIX}token:${token}`;

    try {
      const userId = await redisClient.get(tokenKey);
      if (!userId) {
        return null;
      }

      return await this.getSession(userId);
    } catch (error) {
      console.error('Error getting user by token:', error);
      return null;
    }
  }

  /**
   * Update session data
   * @param {string} userId - User ID
   * @param {Object} data - Data to update
   */
  async updateSession(userId, data) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;

    try {
      const currentSession = await this.getSession(userId);
      if (!currentSession) {
        return null;
      }

      const updatedSession = {
        ...currentSession,
        ...data,
        lastActivity: new Date().toISOString(),
      };

      await redisClient.setex(sessionKey, SESSION_TTL, JSON.stringify(updatedSession));
      return updatedSession;
    } catch (error) {
      console.error('Error updating session:', error);
      throw error;
    }
  }

  /**
   * Delete a session (logout)
   * @param {string} userId - User ID
   * @param {string} token - JWT token
   */
  async deleteSession(userId, token = null) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;

    try {
      // Delete main session
      await redisClient.del(sessionKey);

      // Delete token mapping if provided
      if (token) {
        const tokenKey = `${SESSION_PREFIX}token:${token}`;
        await redisClient.del(tokenKey);
      }

      console.log(`Session deleted for user: ${userId}`);
      return true;
    } catch (error) {
      console.error('Error deleting session:', error);
      return false;
    }
  }

  /**
   * Delete all sessions for a user (force logout from all devices)
   * @param {string} userId - User ID
   */
  async deleteAllSessions(userId) {
    try {
      // Delete main session
      await this.deleteSession(userId);

      // For additional security, we could track all tokens per user
      // but for simplicity, we'll rely on token TTL
      console.log(`All sessions deleted for user: ${userId}`);
      return true;
    } catch (error) {
      console.error('Error deleting all sessions:', error);
      return false;
    }
  }

  /**
   * Check if session exists
   * @param {string} userId - User ID
   */
  async hasSession(userId) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    try {
      const exists = await redisClient.exists(sessionKey);
      return exists === 1;
    } catch (error) {
      console.error('Error checking session:', error);
      return false;
    }
  }

  /**
   * Get session TTL remaining
   * @param {string} userId - User ID
   */
  async getSessionTTL(userId) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    try {
      return await redisClient.ttl(sessionKey);
    } catch (error) {
      console.error('Error getting session TTL:', error);
      return 0;
    }
  }

  /**
   * Extend session TTL
   * @param {string} userId - User ID
   * @param {number} additionalTime - Additional time in seconds
   */
  async extendSession(userId, additionalTime = SESSION_TTL) {
    const sessionKey = `${SESSION_PREFIX}${userId}`;
    try {
      await redisClient.expire(sessionKey, additionalTime);
      return true;
    } catch (error) {
      console.error('Error extending session:', error);
      return false;
    }
  }

  /**
   * Get all active sessions count (for admin)
   */
  async getActiveSessionsCount() {
    try {
      // Use SCAN to avoid blocking Redis with KEYS
      const pattern = `${SESSION_PREFIX}*`;
      let cursor = '0';
      let count = 0;
      do {
        const reply = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        if (Array.isArray(reply)) {
          cursor = reply[0];
          const keys = reply[1] || [];
          const sessionKeys = keys.filter(k => !k.includes('token:'));
          count += sessionKeys.length;
        } else if (reply && reply.cursor !== undefined) {
          cursor = reply.cursor;
          const keys = reply.keys || [];
          const sessionKeys = keys.filter(k => !k.includes('token:'));
          count += sessionKeys.length;
        } else {
          break;
        }
      } while (cursor !== '0');

      return count;
    } catch (error) {
      console.error('Error getting active sessions count:', error);
      return 0;
    }
  }

  /**
   * Blacklist a token (for immediate logout)
   * @param {string} token - JWT token to blacklist
   * @param {number} expiresIn - Token expiration time in seconds
   */
  async blacklistToken(token, expiresIn = 86400) {
    const blacklistKey = `${TOKEN_BLACKLIST_PREFIX}${token}`;
    try {
      await redisClient.setex(blacklistKey, expiresIn, '1');
      return true;
    } catch (error) {
      console.error('Error blacklisting token:', error);
      return false;
    }
  }

  /**
   * Check if token is blacklisted
   * @param {string} token - JWT token
   */
  async isTokenBlacklisted(token) {
    const blacklistKey = `${TOKEN_BLACKLIST_PREFIX}${token}`;
    try {
      const result = await redisClient.get(blacklistKey);
      return result === '1';
    } catch (error) {
      console.error('Error checking token blacklist:', error);
      return false;
    }
  }

  /**
   * Clean up expired sessions (run periodically)
   */
  async cleanupExpiredSessions() {
    try {
      // Redis handles TTL automatically, but we can log stats
      const info = await redisClient.info('stats');
      console.log('Redis stats:', info);
      return true;
    } catch (error) {
      console.error('Error cleaning up sessions:', error);
      return false;
    }
  }
}

module.exports = new SessionService();
