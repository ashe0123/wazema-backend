const express = require('express');
const db      = require('../db');
const sms     = require('../services/sms');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

// Helper to get organization settings
async function getOrgSettings() {
  const settings = await db.all('SELECT key, value FROM settings');
  const map = {};
  settings.forEach(s => { map[s.key] = s.value; });
  return {
    org_name: map.org_name || 'Wazema SCBC',
    org_phone: map.org_phone || '+251911000000',
    savings_due_day: parseInt(map.savings_due_day || '5'),
    repayment_due_day: parseInt(map.repayment_due_day || '10'),
  };
}

// GET /api/notifications/status — Check SMS service status
router.get('/status', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    res.json({
      enabled: sms.isEnabled,
      provider: sms.provider,
      message: sms.isEnabled 
        ? `SMS notifications are enabled via ${sms.provider}` 
        : 'SMS notifications are disabled. Set SMS_ENABLED=true in environment variables.',
    });
  } catch(e) { next(e); }
});

// POST /api/notifications/test — Send test SMS
router.post('/test', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message required' });
    }
    
    const result = await sms.sendSMS(phone, message);
    res.json({ 
      success: true, 
      message: 'Test SMS sent successfully',
      result 
    });
  } catch(e) { 
    res.status(500).json({ 
      success: false, 
      error: e.message 
    }); 
  }
});

// POST /api/notifications/send-savings-reminders — Send reminders for unpaid savings
router.post('/send-savings-reminders', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { month, daysBeforeDue } = req.body;
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    const days = parseInt(daysBeforeDue) || 3;
    
    const org = await getOrgSettings();
    
    // Get members with unpaid savings for the target month
    const members = await db.all(`
      SELECT m.id, m.name, m.phone, m.monthly_saving
      FROM members m
      WHERE m.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM savings s 
        WHERE s.member_id = m.id 
        AND s.month = $1 
        AND s.status IN ('paid', 'late', 'pending_review')
      )
    `, [targetMonth]);
    
    if (members.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No unpaid savings found',
        sent: 0 
      });
    }
    
    // Prepare SMS messages
    const recipients = members.map(m => ({
      phone: m.phone,
      message: sms.templates.savingsDueReminder(
        m.name,
        m.monthly_saving,
        org.savings_due_day,
        org.org_name
      ),
      context: { member_id: m.id, type: 'savings_reminder', month: targetMonth },
    }));
    
    // Send bulk SMS
    const results = await sms.sendBulkSMS(recipients);
    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    res.json({
      success: true,
      message: `Sent ${sent} reminder(s), ${failed} failed`,
      sent,
      failed,
      total: members.length,
      results: results.map(r => ({
        member_id: r.context.member_id,
        phone: r.phone,
        success: r.success,
        error: r.error || null,
      })),
    });
  } catch(e) { next(e); }
});

// POST /api/notifications/send-overdue-alerts — Send alerts for overdue payments
router.post('/send-overdue-alerts', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const org = await getOrgSettings();
    
    // Get members with overdue savings (past months not paid)
    const overdueMembers = await db.all(`
      SELECT DISTINCT m.id, m.name, m.phone, m.monthly_saving
      FROM members m
      WHERE m.status = 'active'
      AND EXISTS (
        SELECT 1 FROM generate_series(
          date_trunc('month', m.join_date::date),
          date_trunc('month', CURRENT_DATE) - interval '1 month',
          interval '1 month'
        ) AS month_series(month)
        WHERE NOT EXISTS (
          SELECT 1 FROM savings s
          WHERE s.member_id = m.id
          AND s.month = to_char(month_series.month, 'YYYY-MM')
          AND s.status IN ('paid', 'late')
        )
      )
    `);
    
    if (overdueMembers.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No overdue payments found',
        sent: 0 
      });
    }
    
    // Prepare SMS messages
    const recipients = overdueMembers.map(m => ({
      phone: m.phone,
      message: sms.templates.savingsOverdueAlert(
        m.name,
        m.monthly_saving,
        org.org_name,
        org.org_phone
      ),
      context: { member_id: m.id, type: 'savings_overdue' },
    }));
    
    // Send bulk SMS
    const results = await sms.sendBulkSMS(recipients);
    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    res.json({
      success: true,
      message: `Sent ${sent} overdue alert(s), ${failed} failed`,
      sent,
      failed,
      total: overdueMembers.length,
      results: results.map(r => ({
        member_id: r.context.member_id,
        phone: r.phone,
        success: r.success,
        error: r.error || null,
      })),
    });
  } catch(e) { next(e); }
});

// POST /api/notifications/send-repayment-reminders — Send loan repayment reminders
router.post('/send-repayment-reminders', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { month } = req.body;
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    const org = await getOrgSettings();
    
    // Get members with due/overdue repayments
    const dueRepayments = await db.all(`
      SELECT r.id, r.month, r.amount, r.penalty, r.status, r.due_date,
             l.member_id, m.name as member_name, m.phone
      FROM repayments r
      JOIN loans l ON r.loan_id = l.id
      JOIN members m ON l.member_id = m.id
      WHERE r.month = $1
      AND r.status IN ('due', 'overdue')
      AND m.status = 'active'
    `, [targetMonth]);
    
    if (dueRepayments.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No due repayments found',
        sent: 0 
      });
    }
    
    // Prepare SMS messages
    const recipients = dueRepayments.map(r => ({
      phone: r.phone,
      message: r.status === 'overdue'
        ? sms.templates.repaymentOverdueAlert(
            r.member_name,
            r.amount,
            r.penalty || 0,
            org.org_name,
            org.org_phone
          )
        : sms.templates.repaymentDueReminder(
            r.member_name,
            r.amount,
            r.due_date,
            org.org_name
          ),
      context: { 
        member_id: r.member_id, 
        repayment_id: r.id,
        type: r.status === 'overdue' ? 'repayment_overdue' : 'repayment_due',
        month: targetMonth 
      },
    }));
    
    // Send bulk SMS
    const results = await sms.sendBulkSMS(recipients);
    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    res.json({
      success: true,
      message: `Sent ${sent} repayment reminder(s), ${failed} failed`,
      sent,
      failed,
      total: dueRepayments.length,
      results: results.map(r => ({
        member_id: r.context.member_id,
        phone: r.phone,
        success: r.success,
        error: r.error || null,
      })),
    });
  } catch(e) { next(e); }
});

// POST /api/notifications/send-custom — Send custom SMS to selected members
router.post('/send-custom', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { member_ids, message } = req.body;
    
    if (!Array.isArray(member_ids) || member_ids.length === 0) {
      return res.status(400).json({ error: 'member_ids array required' });
    }
    
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'message required' });
    }
    
    if (member_ids.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 members per batch' });
    }
    
    // Get member phone numbers
    const placeholders = member_ids.map((_, i) => `$${i + 1}`).join(',');
    const members = await db.all(
      `SELECT id, name, phone FROM members WHERE id IN (${placeholders}) AND status = 'active'`,
      member_ids
    );
    
    if (members.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No active members found',
        sent: 0 
      });
    }
    
    // Prepare SMS messages
    const recipients = members.map(m => ({
      phone: m.phone,
      message: message,
      context: { member_id: m.id, type: 'custom' },
    }));
    
    // Send bulk SMS
    const results = await sms.sendBulkSMS(recipients);
    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    res.json({
      success: true,
      message: `Sent ${sent} message(s), ${failed} failed`,
      sent,
      failed,
      total: members.length,
      results: results.map(r => ({
        member_id: r.context.member_id,
        phone: r.phone,
        success: r.success,
        error: r.error || null,
      })),
    });
  } catch(e) { next(e); }
});

module.exports = router;
