/**
 * Comprehensive Audit Logging System for Financial Compliance
 * Tracks all critical operations, data changes, and access attempts
 * Compliant with financial regulations and data protection requirements
 */
require('dotenv').config();
const db = require('./db');
const security = require('./security');

// ── Audit Event Types ─────────────────────────────────────────────────────────
const AUDIT_EVENTS = {
  // Authentication
  AUTH_LOGIN_SUCCESS: 'auth.login.success',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_PASSWORD_RESET: 'auth.password.reset',
  AUTH_TOKEN_REVOKED: 'auth.token.revoked',
  
  // Member Operations
  MEMBER_CREATED: 'member.created',
  MEMBER_UPDATED: 'member.updated',
  MEMBER_DELETED: 'member.deleted',
  MEMBER_STATUS_CHANGED: 'member.status.changed',
  MEMBER_EXIT: 'member.exit',
  MEMBER_DATA_ACCESSED: 'member.data.accessed',
  MEMBER_BULK_EXPORT: 'member.bulk.export',
  
  // Financial Operations
  SAVINGS_CREATED: 'savings.created',
  SAVINGS_APPROVED: 'savings.approved',
  SAVINGS_REJECTED: 'savings.rejected',
  SAVINGS_BULK_APPROVED: 'savings.bulk.approved',
  
  LOAN_APPLIED: 'loan.applied',
  LOAN_APPROVED: 'loan.approved',
  LOAN_REJECTED: 'loan.rejected',
  LOAN_DISBURSED: 'loan.disbursed',
  LOAN_REFINANCED: 'loan.refinanced',
  
  REPAYMENT_SUBMITTED: 'repayment.submitted',
  REPAYMENT_CONFIRMED: 'repayment.confirmed',
  REPAYMENT_BULK_APPROVED: 'repayment.bulk.approved',
  
  // System Operations
  SETTINGS_CHANGED: 'settings.changed',
  BANK_ACCOUNT_ADDED: 'bank.account.added',
  BANK_ACCOUNT_UPDATED: 'bank.account.updated',
  BANK_ACCOUNT_DELETED: 'bank.account.deleted',
  
  // Data Operations
  BACKUP_CREATED: 'backup.created',
  BACKUP_RESTORED: 'backup.restored',
  DATA_EXPORTED: 'data.exported',
  DATA_IMPORTED: 'data.imported',
  
  // Security Events
  SUSPICIOUS_ACTIVITY: 'security.suspicious',
  RATE_LIMIT_EXCEEDED: 'security.rate_limit',
  UNAUTHORIZED_ACCESS: 'security.unauthorized',
  ENCRYPTION_FAILURE: 'security.encryption.failed',
  
  // Reports
  REPORT_GENERATED: 'report.generated',
  REPORT_ACCESSED: 'report.accessed',
  
  // Notifications
  SMS_SENT: 'notification.sms.sent',
  NOTIFICATION_FAILED: 'notification.failed',
};

// ── Log Audit Event ───────────────────────────────────────────────────────────
async function logAuditEvent(event) {
  try {
    const {
      eventType,
      actor,
      actorRole = 'unknown',
      target,
      targetType,
      action,
      status = 'success',
      ipAddress,
      userAgent,
      details = {},
      amount,
      beforeValue,
      afterValue,
      sensitiveFields = [],
    } = event;

    // Validate required fields
    if (!eventType || !actor || !action) {
      console.error('Audit log missing required fields:', { eventType, actor, action });
      return;
    }

    // Mask sensitive fields
    const maskedDetails = { ...details };
    for (const field of sensitiveFields) {
      if (maskedDetails[field]) {
        maskedDetails[field] = '***REDACTED***';
      }
    }

    // Create audit entry
    const auditEntry = {
      event_type: eventType,
      actor,
      actor_role: actorRole,
      target,
      target_type: targetType,
      action,
      status,
      ip_address: ipAddress,
      user_agent: userAgent ? userAgent.substring(0, 255) : null,
      details: JSON.stringify(maskedDetails),
      amount: amount || null,
      before_value: beforeValue ? JSON.stringify(beforeValue) : null,
      after_value: afterValue ? JSON.stringify(afterValue) : null,
      created_at: new Date().toISOString(),
    };

    // Insert into database
    await db.run(`
      INSERT INTO audit_trail (
        event_type, actor, actor_role, target, target_type, action,
        status, ip_address, user_agent, details, amount,
        before_value, after_value, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      auditEntry.event_type,
      auditEntry.actor,
      auditEntry.actor_role,
      auditEntry.target,
      auditEntry.target_type,
      auditEntry.action,
      auditEntry.status,
      auditEntry.ip_address,
      auditEntry.user_agent,
      auditEntry.details,
      auditEntry.amount,
      auditEntry.before_value,
      auditEntry.after_value,
      auditEntry.created_at,
    ]);

    // Console log for important events
    if (status === 'failed' || eventType.includes('security')) {
      console.warn(`🔒 AUDIT: ${eventType} by ${actor} - ${status}`, maskedDetails);
    } else if (amount && amount > 100000) {
      console.log(`💰 AUDIT: ${eventType} by ${actor} - Amount: ${amount}`);
    }

  } catch (error) {
    console.error('Failed to log audit event:', error.message);
    // Never let audit failures crash the application
  }
}

// ── Query Audit Trail ─────────────────────────────────────────────────────────
async function queryAuditTrail(filters = {}) {
  const {
    actor,
    target,
    eventType,
    status,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
  } = filters;

  const conditions = [];
  const params = [];

  if (actor) {
    conditions.push('actor = ?');
    params.push(actor);
  }

  if (target) {
    conditions.push('target = ?');
    params.push(target);
  }

  if (eventType) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (startDate) {
    conditions.push('created_at >= ?');
    params.push(startDate);
  }

  if (endDate) {
    conditions.push('created_at <= ?');
    params.push(endDate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT * FROM audit_trail
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;

  params.push(limit, offset);

  return await db.all(sql, params);
}

// ── Get Audit Statistics ──────────────────────────────────────────────────────
async function getAuditStatistics(startDate, endDate) {
  const stats = {};

  // Total events
  const totalResult = await db.one(`
    SELECT COUNT(*) as count FROM audit_trail
    WHERE created_at >= ? AND created_at <= ?
  `, [startDate, endDate]);
  stats.totalEvents = totalResult.count;

  // Events by type
  const byType = await db.all(`
    SELECT event_type, COUNT(*) as count FROM audit_trail
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 10
  `, [startDate, endDate]);
  stats.eventsByType = byType;

  // Events by actor
  const byActor = await db.all(`
    SELECT actor, COUNT(*) as count FROM audit_trail
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY actor
    ORDER BY count DESC
    LIMIT 10
  `, [startDate, endDate]);
  stats.eventsByActor = byActor;

  // Failed events
  const failedResult = await db.one(`
    SELECT COUNT(*) as count FROM audit_trail
    WHERE status = 'failed' AND created_at >= ? AND created_at <= ?
  `, [startDate, endDate]);
  stats.failedEvents = failedResult.count;

  // Security events
  const securityResult = await db.one(`
    SELECT COUNT(*) as count FROM audit_trail
    WHERE event_type LIKE 'security.%' AND created_at >= ? AND created_at <= ?
  `, [startDate, endDate]);
  stats.securityEvents = securityResult.count;

  // Financial transactions (total amount)
  const amountResult = await db.one(`
    SELECT 
      SUM(CASE WHEN event_type LIKE 'savings.%' THEN amount ELSE 0 END) as savings_total,
      SUM(CASE WHEN event_type LIKE 'loan.%' THEN amount ELSE 0 END) as loan_total,
      SUM(CASE WHEN event_type LIKE 'repayment.%' THEN amount ELSE 0 END) as repayment_total
    FROM audit_trail
    WHERE created_at >= ? AND created_at <= ? AND amount IS NOT NULL
  `, [startDate, endDate]);
  stats.financialTotals = amountResult;

  return stats;
}

// ── Export Audit Log (for Compliance) ────────────────────────────────────────
async function exportAuditLog(startDate, endDate, format = 'json') {
  const records = await db.all(`
    SELECT * FROM audit_trail
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC
  `, [startDate, endDate]);

  if (format === 'csv') {
    return convertToCSV(records);
  }

  return records;
}

function convertToCSV(records) {
  if (records.length === 0) return '';

  const headers = Object.keys(records[0]).join(',');
  const rows = records.map(record => {
    return Object.values(record).map(value => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }).join(',');
  });

  return [headers, ...rows].join('\n');
}

// ── Detect Anomalies in Audit Log ─────────────────────────────────────────────
async function detectAnomalies(hours = 24) {
  const startDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const anomalies = [];

  // Check for excessive failed login attempts
  const failedLogins = await db.all(`
    SELECT actor, COUNT(*) as count, MAX(created_at) as last_attempt
    FROM audit_trail
    WHERE event_type = 'auth.login.failed' AND created_at >= ?
    GROUP BY actor
    HAVING count > 5
    ORDER BY count DESC
  `, [startDate]);

  if (failedLogins.length > 0) {
    anomalies.push({
      type: 'EXCESSIVE_FAILED_LOGINS',
      severity: 'HIGH',
      details: failedLogins,
    });
  }

  // Check for suspicious activity patterns
  const suspiciousEvents = await db.all(`
    SELECT * FROM audit_trail
    WHERE event_type LIKE 'security.%' AND created_at >= ?
    ORDER BY created_at DESC
  `, [startDate]);

  if (suspiciousEvents.length > 10) {
    anomalies.push({
      type: 'HIGH_SECURITY_EVENTS',
      severity: 'MEDIUM',
      count: suspiciousEvents.length,
      details: suspiciousEvents.slice(0, 5),
    });
  }

  // Check for unusual large transactions
  const largeTransactions = await db.all(`
    SELECT * FROM audit_trail
    WHERE amount > 1000000 AND created_at >= ?
    ORDER BY amount DESC
  `, [startDate]);

  if (largeTransactions.length > 0) {
    anomalies.push({
      type: 'LARGE_TRANSACTIONS',
      severity: 'MEDIUM',
      details: largeTransactions,
    });
  }

  // Check for after-hours activity
  const afterHours = await db.all(`
    SELECT actor, COUNT(*) as count FROM audit_trail
    WHERE created_at >= ?
      AND (
        CAST(strftime('%H', created_at) AS INTEGER) < 6
        OR CAST(strftime('%H', created_at) AS INTEGER) > 22
      )
    GROUP BY actor
    HAVING count > 10
  `, [startDate]);

  if (afterHours.length > 0) {
    anomalies.push({
      type: 'AFTER_HOURS_ACTIVITY',
      severity: 'LOW',
      details: afterHours,
    });
  }

  return anomalies;
}

// ── Initialize Audit Trail Table ──────────────────────────────────────────────
async function initializeAuditTable() {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS audit_trail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_role TEXT DEFAULT 'unknown',
        target TEXT,
        target_type TEXT,
        action TEXT NOT NULL,
        status TEXT DEFAULT 'success',
        ip_address TEXT,
        user_agent TEXT,
        details TEXT,
        amount REAL,
        before_value TEXT,
        after_value TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_trail(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_trail(target);
      CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_trail(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_trail(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_trail(status);
    `);

    console.log('✅ Audit trail table initialized');
  } catch (error) {
    console.error('Failed to initialize audit trail table:', error.message);
  }
}

// Initialize on module load
initializeAuditTable();

// ── Middleware for Express Routes ─────────────────────────────────────────────
function auditMiddleware(eventType, options = {}) {
  return async (req, res, next) => {
    const originalSend = res.send;

    res.send = function(data) {
      // Log after response
      setImmediate(async () => {
        try {
          await logAuditEvent({
            eventType,
            actor: req.user?.id || 'anonymous',
            actorRole: req.user?.role || 'unknown',
            target: options.getTarget ? options.getTarget(req) : req.params.id,
            targetType: options.targetType,
            action: `${req.method} ${req.path}`,
            status: res.statusCode >= 400 ? 'failed' : 'success',
            ipAddress: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            userAgent: req.headers['user-agent'],
            details: {
              method: req.method,
              path: req.path,
              statusCode: res.statusCode,
              ...options.getDetails ? options.getDetails(req) : {},
            },
            amount: options.getAmount ? options.getAmount(req) : undefined,
          });
        } catch (error) {
          console.error('Audit middleware error:', error.message);
        }
      });

      originalSend.call(this, data);
    };

    next();
  };
}

// ── Export Functions ──────────────────────────────────────────────────────────
module.exports = {
  AUDIT_EVENTS,
  logAuditEvent,
  queryAuditTrail,
  getAuditStatistics,
  exportAuditLog,
  detectAnomalies,
  auditMiddleware,
};
