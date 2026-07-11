/**
 * Financial Security & Compliance API Routes
 * Provides endpoints for backup, audit, integrity, and security operations
 */
const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const backup = require('../backup');
const audit = require('../audit');
const integrity = require('../integrity');
const security = require('../security');

// All routes require authentication and admin role
router.use(authMiddleware, adminOnly);

// ── Backup & Recovery ─────────────────────────────────────────────────────────

/**
 * POST /api/financial-security/backup
 * Create a full system backup
 */
router.post('/backup', async (req, res) => {
  try {
    await audit.logAuditEvent({
      eventType: audit.AUDIT_EVENTS.BACKUP_CREATED,
      actor: req.user.id,
      actorRole: req.user.role,
      action: 'Initiated backup',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const backupPath = await backup.performFullBackup();
    
    res.json({
      success: true,
      message: 'Backup created successfully',
      backup_path: backupPath,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Backup error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/backups
 * List all available backups
 */
router.get('/backups', async (req, res) => {
  try {
    const backups = await backup.listBackups();
    
    res.json({
      success: true,
      backups,
      count: backups.length,
    });
  } catch (error) {
    console.error('List backups error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/financial-security/backup/:filename/verify
 * Verify backup integrity
 */
router.post('/backup/:filename/verify', async (req, res) => {
  try {
    const backups = await backup.listBackups();
    const targetBackup = backups.find(b => b.filename === req.params.filename);
    
    if (!targetBackup) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    const isValid = await backup.verifyBackup(targetBackup.path);
    
    res.json({
      success: true,
      filename: req.params.filename,
      valid: isValid,
      verified_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Verify backup error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/financial-security/restore
 * Restore from backup (DANGEROUS - requires confirmation)
 */
router.post('/restore', async (req, res) => {
  try {
    const { backup_path, confirmation_token } = req.body;
    
    // Require explicit confirmation to prevent accidental restores
    if (confirmation_token !== 'CONFIRM_RESTORE') {
      return res.status(400).json({
        error: 'Invalid confirmation token',
        message: 'To restore, you must provide confirmation_token: "CONFIRM_RESTORE"',
      });
    }

    await audit.logAuditEvent({
      eventType: audit.AUDIT_EVENTS.BACKUP_RESTORED,
      actor: req.user.id,
      actorRole: req.user.role,
      action: 'Initiated restore from backup',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      details: { backup_path },
    });

    await backup.restoreFromBackup(backup_path);
    
    res.json({
      success: true,
      message: 'Backup restored successfully',
      restored_from: backup_path,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Audit Trail ───────────────────────────────────────────────────────────────

/**
 * GET /api/financial-security/audit
 * Query audit trail
 */
router.get('/audit', async (req, res) => {
  try {
    const filters = {
      actor: req.query.actor,
      target: req.query.target,
      eventType: req.query.event_type,
      status: req.query.status,
      startDate: req.query.start_date,
      endDate: req.query.end_date,
      limit: parseInt(req.query.limit) || 100,
      offset: parseInt(req.query.offset) || 0,
    };

    const records = await audit.queryAuditTrail(filters);
    
    res.json({
      success: true,
      records,
      count: records.length,
      filters,
    });
  } catch (error) {
    console.error('Audit query error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/audit/statistics
 * Get audit statistics
 */
router.get('/audit/statistics', async (req, res) => {
  try {
    const startDate = req.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = req.query.end_date || new Date().toISOString();

    const stats = await audit.getAuditStatistics(startDate, endDate);
    
    res.json({
      success: true,
      period: { start: startDate, end: endDate },
      statistics: stats,
    });
  } catch (error) {
    console.error('Audit statistics error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/audit/export
 * Export audit log for compliance
 */
router.get('/audit/export', async (req, res) => {
  try {
    const startDate = req.query.start_date || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = req.query.end_date || new Date().toISOString();
    const format = req.query.format || 'json';

    await audit.logAuditEvent({
      eventType: audit.AUDIT_EVENTS.DATA_EXPORTED,
      actor: req.user.id,
      actorRole: req.user.role,
      action: 'Exported audit log',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      details: { startDate, endDate, format },
    });

    const data = await audit.exportAuditLog(startDate, endDate, format);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=audit-log-${Date.now()}.csv`);
      res.send(data);
    } else {
      res.json({
        success: true,
        period: { start: startDate, end: endDate },
        records: data,
        count: data.length,
      });
    }
  } catch (error) {
    console.error('Audit export error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/audit/anomalies
 * Detect anomalies in audit log
 */
router.get('/audit/anomalies', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const anomalies = await audit.detectAnomalies(hours);
    
    res.json({
      success: true,
      period_hours: hours,
      anomalies,
      count: anomalies.length,
    });
  } catch (error) {
    console.error('Anomaly detection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Data Integrity ────────────────────────────────────────────────────────────

/**
 * GET /api/financial-security/integrity/report
 * Generate comprehensive integrity report
 */
router.get('/integrity/report', async (req, res) => {
  try {
    const report = await integrity.generateIntegrityReport();
    
    res.json({
      success: true,
      report,
    });
  } catch (error) {
    console.error('Integrity report error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/integrity/balances
 * Validate member balances
 */
router.get('/integrity/balances', async (req, res) => {
  try {
    const result = await integrity.validateMemberBalances();
    
    res.json({
      success: result.success,
      issues: result.issues,
      total_members: result.total_members,
      issues_found: result.issues?.length || 0,
    });
  } catch (error) {
    console.error('Balance validation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/integrity/schedules
 * Validate loan repayment schedules
 */
router.get('/integrity/schedules', async (req, res) => {
  try {
    const result = await integrity.validateLoanSchedules();
    
    res.json({
      success: result.success,
      issues: result.issues,
      total_loans: result.total_loans,
      issues_found: result.issues?.length || 0,
    });
  } catch (error) {
    console.error('Schedule validation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/integrity/duplicates
 * Detect duplicate transactions
 */
router.get('/integrity/duplicates', async (req, res) => {
  try {
    const result = await integrity.detectDuplicateTransactions();
    
    res.json({
      success: result.success,
      duplicates: result.duplicates,
      count: result.duplicates?.length || 0,
    });
  } catch (error) {
    console.error('Duplicate detection error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/integrity/consistency
 * Validate data consistency
 */
router.get('/integrity/consistency', async (req, res) => {
  try {
    const result = await integrity.validateDataConsistency();
    
    res.json({
      success: result.success,
      total_issues: result.total_issues,
      details: result.details,
    });
  } catch (error) {
    console.error('Consistency validation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/reconcile/:month
 * Reconcile financials for a specific month
 */
router.get('/reconcile/:month', async (req, res) => {
  try {
    const reconciliation = await integrity.reconcileFinancials(req.params.month);
    
    res.json({
      success: true,
      reconciliation,
    });
  } catch (error) {
    console.error('Reconciliation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Security Operations ───────────────────────────────────────────────────────

/**
 * POST /api/financial-security/encrypt
 * Encrypt sensitive data (utility endpoint for testing)
 */
router.post('/encrypt', async (req, res) => {
  try {
    const { data } = req.body;
    
    if (!data) {
      return res.status(400).json({ error: 'Data required' });
    }

    const encrypted = security.encrypt(data);
    
    res.json({
      success: true,
      encrypted,
    });
  } catch (error) {
    console.error('Encryption error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/financial-security/status
 * Get overall security status
 */
router.get('/status', async (req, res) => {
  try {
    const status = {
      timestamp: new Date().toISOString(),
      features: {
        backup_enabled: process.env.BACKUP_ENABLED !== 'false',
        encryption_enabled: !!process.env.DATA_ENCRYPTION_KEY,
        audit_trail_enabled: true,
        integrity_checks_enabled: process.env.INTEGRITY_CHECKS_ENABLED !== 'false',
      },
      health: {
        backup_dir_configured: !!process.env.BACKUP_DIR,
        retention_days: parseInt(process.env.BACKUP_RETENTION_DAYS || '30'),
        encryption_key_length: process.env.DATA_ENCRYPTION_KEY?.length || 0,
      },
    };

    // Check if backup encryption key is strong enough
    if (process.env.BACKUP_ENCRYPTION_KEY) {
      status.health.backup_encryption = process.env.BACKUP_ENCRYPTION_KEY.length >= 32 ? 'strong' : 'weak';
    } else {
      status.health.backup_encryption = 'disabled';
    }

    res.json({
      success: true,
      status,
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
