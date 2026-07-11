/**
 * cache.js — Redis-based caching layer with graceful fallback
 * Provides caching for settings, member data, and frequently accessed data
 */
require('dotenv').config();

let redisClient = null;
let isRedisAvailable = false;

// ── Initialize Redis (optional) ───────────────────────────────────────────────
if (process.env.REDIS_URL) {
  try {
    const redis = require('redis');
    redisClient = redis.createClient({
      url: process.env.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('❌ Redis: Max retries exceeded');
            return new Error('Redis max retries exceeded');
          }
          return Math.min(retries * 50, 2000);
        },
      },
    });

    redisClient.on('error', (err) => {
      console.error('Redis error:', err.message);
      isRedisAvailable = false;
    });

    redisClient.on('connect', () => {
      console.log('✅ Redis connected');
      isRedisAvailable = true;
    });

    redisClient.on('ready', () => {
      isRedisAvailable = true;
    });

    redisClient.on('end', () => {
      console.warn('⚠️  Redis connection closed');
      isRedisAvailable = false;
    });

    // Connect asynchronously
    redisClient.connect().catch((e) => {
      console.warn('⚠️  Redis connection failed, running without cache:', e.message);
      isRedisAvailable = false;
    });
  } catch (e) {
    console.warn('⚠️  Redis not available, running without cache:', e.message);
    redisClient = null;
  }
} else {
  console.log('💾 Redis not configured — caching disabled (set REDIS_URL to enable)');
}

// ── In-Memory Fallback Cache ──────────────────────────────────────────────────
const memoryCache = new Map();
const MEMORY_CACHE_MAX = 1000; // Prevent memory leaks

// Clean up old entries every 5 minutes
setInterval(() => {
  if (memoryCache.size > MEMORY_CACHE_MAX) {
    const keysToDelete = Array.from(memoryCache.keys()).slice(0, memoryCache.size - MEMORY_CACHE_MAX);
    keysToDelete.forEach(k => memoryCache.delete(k));
    console.log(`🧹 Memory cache cleaned: removed ${keysToDelete.length} old entries`);
  }
}, 5 * 60 * 1000);

// ── Cache Interface ───────────────────────────────────────────────────────────

/**
 * Get value from cache
 * @param {string} key - Cache key
 * @returns {Promise<any|null>} - Cached value or null
 */
async function get(key) {
  try {
    if (isRedisAvailable && redisClient) {
      const value = await redisClient.get(key);
      if (value) {
        return JSON.parse(value);
      }
    } else {
      // Fallback to memory cache
      const entry = memoryCache.get(key);
      if (entry && entry.expiry > Date.now()) {
        return entry.value;
      } else if (entry) {
        memoryCache.delete(key);
      }
    }
  } catch (e) {
    console.error('Cache get error:', e.message);
  }
  return null;
}

/**
 * Set value in cache
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttl - Time to live in seconds (default: 300 = 5 minutes)
 * @returns {Promise<boolean>} - Success status
 */
async function set(key, value, ttl = 300) {
  try {
    if (isRedisAvailable && redisClient) {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
      return true;
    } else {
      // Fallback to memory cache
      memoryCache.set(key, {
        value,
        expiry: Date.now() + (ttl * 1000),
      });
      return true;
    }
  } catch (e) {
    console.error('Cache set error:', e.message);
    return false;
  }
}

/**
 * Delete value from cache
 * @param {string} key - Cache key
 * @returns {Promise<boolean>} - Success status
 */
async function del(key) {
  try {
    if (isRedisAvailable && redisClient) {
      await redisClient.del(key);
    } else {
      memoryCache.delete(key);
    }
    return true;
  } catch (e) {
    console.error('Cache delete error:', e.message);
    return false;
  }
}

/**
 * Delete all keys matching a pattern
 * @param {string} pattern - Pattern to match (e.g., "settings:*")
 * @returns {Promise<number>} - Number of keys deleted
 */
async function delPattern(pattern) {
  try {
    if (isRedisAvailable && redisClient) {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(keys);
        return keys.length;
      }
      return 0;
    } else {
      // For memory cache, match pattern manually
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      let count = 0;
      for (const key of memoryCache.keys()) {
        if (regex.test(key)) {
          memoryCache.delete(key);
          count++;
        }
      }
      return count;
    }
  } catch (e) {
    console.error('Cache pattern delete error:', e.message);
    return 0;
  }
}

/**
 * Get or set cache with function
 * @param {string} key - Cache key
 * @param {Function} fn - Function to call if cache miss
 * @param {number} ttl - Time to live in seconds
 * @returns {Promise<any>} - Cached or fresh value
 */
async function getOrSet(key, fn, ttl = 300) {
  const cached = await get(key);
  if (cached !== null) {
    return cached;
  }
  
  const value = await fn();
  await set(key, value, ttl);
  return value;
}

/**
 * Invalidate all settings cache
 */
async function invalidateSettings() {
  return await delPattern('settings:*');
}

/**
 * Invalidate member cache
 * @param {string} memberId - Member ID (optional, if not provided clears all)
 */
async function invalidateMember(memberId) {
  if (memberId) {
    return await del(`member:${memberId}`);
  }
  return await delPattern('member:*');
}

/**
 * Check if cache is available
 */
function isAvailable() {
  return isRedisAvailable || true; // Memory cache always available
}

/**
 * Get cache stats
 */
function getStats() {
  return {
    redis: isRedisAvailable,
    memoryCache: memoryCache.size,
    provider: isRedisAvailable ? 'redis' : 'memory',
  };
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  if (redisClient) {
    try {
      await redisClient.quit();
      console.log('Redis connection closed gracefully');
    } catch (e) {
      console.error('Error closing Redis:', e.message);
    }
  }
});

module.exports = {
  get,
  set,
  del,
  delPattern,
  getOrSet,
  invalidateSettings,
  invalidateMember,
  isAvailable,
  getStats,
};
