/**
 * Health Check & Metrics Endpoint
 * Provides detailed system health information for monitoring
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const cache   = require('../cache');
const queue   = require('../queue');

// ── Basic Health Check (Public) ───────────────────────────────────────────────
router.get('/', async (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '2.0.0',
  });
});

// ── Detailed Health Check (Admin only) ────────────────────────────────────────
router.get('/detailed', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Check database connection
    let dbStatus = 'unknown';
    let dbLatency = 0;
    try {
      const dbStart = Date.now();
      await db.one('SELECT 1 as test');
      dbLatency = Date.now() - dbStart;
      dbStatus = 'ok';
    } catch (e) {
      dbStatus = 'error';
      console.error('DB health check failed:', e.message);
    }
    
    // Check cache
    const cacheStatus = cache.isAvailable() ? 'ok' : 'unavailable';
    const cacheStats = cache.getStats();
    
    // Check queue
    const queueStats = queue.getStats();
    
    // Get system metrics
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    // Database connection pool info (PostgreSQL only)
    let poolInfo = null;
    if (db._type === 'pg' && db.query) {
      try {
        // Access pool stats if available
        poolInfo = {
          type: 'postgresql',
          // Pool size info would need to be exposed from db.js
        };
      } catch (e) {
        // Pool info not available
      }
    }
    
    const health = {
      status: dbStatus === 'ok' ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '2.0.0',
      
      // Component health
      components: {
        database: {
          status: dbStatus,
          latency: dbLatency,
          type: db._type || 'unknown',
          pool: poolInfo,
        },
        cache: {
          status: cacheStatus,
          provider: cacheStats.provider,
          redis: cacheStats.redis,
          memoryCache: cacheStats.memoryCache,
        },
        queue: {
          status: 'ok',
          queued: queueStats.queued,
          processing: queueStats.processing,
          completed: queueStats.completed,
          failed: queueStats.failed,
        },
      },
      
      // System metrics
      system: {
        memory: {
          rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
          external: Math.round(memUsage.external / 1024 / 1024) + ' MB',
        },
        cpu: {
          user: Math.round(cpuUsage.user / 1000) + ' ms',
          system: Math.round(cpuUsage.system / 1000) + ' ms',
        },
        process: {
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
        },
      },
      
      // Response time
      responseTime: Date.now() - startTime + ' ms',
    };
    
    // Return appropriate status code
    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
    
  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
});

// ── Readiness Check (for k8s/docker) ──────────────────────────────────────────
router.get('/ready', async (_req, res) => {
  try {
    // Check if database is accessible
    await db.one('SELECT 1 as test');
    res.status(200).json({ status: 'ready' });
  } catch (e) {
    res.status(503).json({ status: 'not ready', error: e.message });
  }
});

// ── Liveness Check (for k8s/docker) ───────────────────────────────────────────
router.get('/live', (_req, res) => {
  // Simple check - process is alive
  res.status(200).json({ status: 'alive', uptime: process.uptime() });
});

// ── Database Statistics (Admin only) ──────────────────────────────────────────
router.get('/db-stats', async (_req, res) => {
  try {
    const stats = {};
    
    // Get table counts
    const tables = ['members', 'savings', 'loans', 'repayments', 'admins', 'announcements'];
    
    for (const table of tables) {
      try {
        const result = await db.one(`SELECT COUNT(*) as count FROM ${table}`);
        stats[table] = Number(result.count);
      } catch (e) {
        stats[table] = 'error';
      }
    }
    
    // Get active users count
    try {
      const activeMembers = await db.one(
        "SELECT COUNT(*) as count FROM members WHERE status = 'active'"
      );
      stats.activeMembers = Number(activeMembers.count);
    } catch (e) {
      stats.activeMembers = 'error';
    }
    
    // Get pending payments count
    try {
      const pendingSavings = await db.one(
        "SELECT COUNT(*) as count FROM savings WHERE status = 'pending_review'"
      );
      stats.pendingSavings = Number(pendingSavings.count);
    } catch (e) {
      stats.pendingSavings = 'error';
    }
    
    res.json({
      timestamp: new Date().toISOString(),
      stats,
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Cache Statistics (Admin only) ─────────────────────────────────────────────
router.get('/cache-stats', (_req, res) => {
  const stats = cache.getStats();
  res.json({
    timestamp: new Date().toISOString(),
    cache: stats,
  });
});

// ── Queue Statistics (Admin only) ─────────────────────────────────────────────
router.get('/queue-stats', (_req, res) => {
  const stats = queue.getStats();
  res.json({
    timestamp: new Date().toISOString(),
    queue: stats,
  });
});

module.exports = router;
