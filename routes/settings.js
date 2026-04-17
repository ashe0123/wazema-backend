const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

async function auditLog(actor, action, target, detail) {
  try { await db.run('INSERT INTO audit_log (actor,action,target,detail) VALUES ($1,$2,$3,$4)', [actor, action, target||null, detail||null]); } catch {}
}

// GET /api/settings
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'admin') return res.json(await db.all('SELECT * FROM settings ORDER BY key ASC'));
    const publicKeys = ['org_name','org_phone','org_email','org_address','savings_due_day','repayment_due_day','late_penalty_rate','loan_multiplier','interest_rate','repayment_months','currency'];
    const placeholders = publicKeys.map((_,i) => `$${i+1}`).join(',');
    res.json(await db.all(`SELECT key,value,label FROM settings WHERE key IN (${placeholders})`, publicKeys));
  } catch(e) { next(e); }
});

// PATCH /api/settings
router.patch('/', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const updates = req.body;
    const changed = [];
    for (const [key, value] of Object.entries(updates)) {
      const r = await db.run("UPDATE settings SET value=$1,updated_at=CURRENT_TIMESTAMP WHERE key=$2", [String(value), key]);
      if (r.rowCount) changed.push(key);
    }
    await auditLog('admin','UPDATE_SETTINGS',null,'Updated: '+changed.join(', '));
    res.json({ message: 'Settings updated', updated: changed });
  } catch(e) { next(e); }
});

// POST /api/settings/change-admin-password
router.post('/change-admin-password', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Missing fields' });
    if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const admin = await db.one('SELECT * FROM admins WHERE id=$1', [req.user.id]);
    if (!admin || !bcrypt.compareSync(current_password, admin.password)) return res.status(401).json({ error: 'Current password incorrect' });
    await db.run('UPDATE admins SET password=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), req.user.id]);
    await auditLog('admin','CHANGE_ADMIN_PASSWORD',null,null);
    res.json({ message: 'Admin password updated' });
  } catch(e) { next(e); }
});

// GET /api/settings/audit
router.get('/audit', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)||50, 200);
    const offset = parseInt(req.query.offset)||0;
    const rows   = await db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    const total  = (await db.one('SELECT COUNT(*) as c FROM audit_log')).c;
    res.json({ rows, total: Number(total), limit, offset });
  } catch(e) { next(e); }
});

// GET /api/settings/announcements
router.get('/announcements', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'admin') return res.json(await db.all('SELECT * FROM announcements ORDER BY created_at DESC'));
    res.json(await db.all("SELECT * FROM announcements WHERE active=1 ORDER BY created_at DESC LIMIT 10"));
  } catch(e) { next(e); }
});

// POST /api/settings/announcements
router.post('/announcements', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { title, body, priority } = req.body;
    if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'title and body required' });
    const validPriority = ['normal','important','urgent'].includes(priority) ? priority : 'normal';
    const r = await db.run("INSERT INTO announcements (title,body,priority,active) VALUES ($1,$2,$3,1)", [title.trim(), body.trim(), validPriority]);
    await auditLog('admin','CREATE_ANNOUNCEMENT',String(r.lastId),title.trim());
    res.status(201).json({ id: r.lastId, message: 'Announcement created' });
  } catch(e) { next(e); }
});

// PATCH /api/settings/announcements/:id
router.patch('/announcements/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const ann = await db.one('SELECT * FROM announcements WHERE id=$1', [req.params.id]);
    if (!ann) return res.status(404).json({ error: 'Announcement not found' });
    const { active, title, body, priority } = req.body;
    await db.run('UPDATE announcements SET title=$1,body=$2,priority=$3,active=$4 WHERE id=$5',
      [title??ann.title, body??ann.body, priority??ann.priority, active!==undefined?(active?1:0):ann.active, req.params.id]);
    res.json({ message: 'Announcement updated' });
  } catch(e) { next(e); }
});

// DELETE /api/settings/announcements/:id
router.delete('/announcements/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const r = await db.run('DELETE FROM announcements WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Announcement deleted' });
  } catch(e) { next(e); }
});

// ── DIVIDENDS ─────────────────────────────────────────────────────────────

// GET /api/settings/dividends
router.get('/dividends', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'member') {
      return res.json(await db.all('SELECT * FROM dividends WHERE member_id=$1 ORDER BY year DESC', [req.user.id]));
    }
    const year = req.query.year ? parseInt(req.query.year) : null;
    const sql  = year
      ? 'SELECT d.*,m.name as member_name FROM dividends d JOIN members m ON d.member_id=m.id WHERE d.year=$1 ORDER BY d.member_id ASC'
      : 'SELECT d.*,m.name as member_name FROM dividends d JOIN members m ON d.member_id=m.id ORDER BY d.year DESC,d.member_id ASC';
    res.json(await db.all(sql, year ? [year] : []));
  } catch(e) { next(e); }
});

// POST /api/settings/dividends/distribute — calculate & create dividend records for a year
router.post('/dividends/distribute', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { year, total_pool } = req.body;
    if (!year || !total_pool) return res.status(400).json({ error: 'year and total_pool required' });
    const members = await db.all("SELECT id,share_qty FROM members WHERE status='active'");
    const totalShares = members.reduce((a, m) => a + Number(m.share_qty||1), 0);
    if (totalShares === 0) return res.status(400).json({ error: 'No active members with shares' });
    const perShare = Number(total_pool) / totalShares;
    const results  = [];
    for (const m of members) {
      const shares = Number(m.share_qty||1);
      const memberShare = parseFloat((shares * perShare).toFixed(2));
      // Upsert
      const existing = await db.one('SELECT id FROM dividends WHERE member_id=$1 AND year=$2', [m.id, year]);
      if (existing) {
        await db.run('UPDATE dividends SET share_qty=$1,total_pool=$2,member_share=$3,status=$4 WHERE member_id=$5 AND year=$6',
          [shares, Number(total_pool), memberShare, 'pending', m.id, year]);
      } else {
        await db.run('INSERT INTO dividends (member_id,year,share_qty,total_pool,member_share,status) VALUES ($1,$2,$3,$4,$5,$6)',
          [m.id, year, shares, Number(total_pool), memberShare, 'pending']);
      }
      results.push({ member_id: m.id, shares, member_share: memberShare });
    }
    await auditLog('admin','DISTRIBUTE_DIVIDENDS',String(year),'Pool: '+total_pool+', Members: '+members.length);
    res.json({ year, total_pool: Number(total_pool), total_shares: totalShares, per_share: perShare, members: results.length, results });
  } catch(e) { next(e); }
});

// PATCH /api/settings/dividends/:id/pay — mark a dividend as paid
router.patch('/dividends/:id/pay', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { paid_date } = req.body;
    const r = await db.run("UPDATE dividends SET status='paid',paid_date=$1 WHERE id=$2", [paid_date || new Date().toISOString().split('T')[0], req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Dividend record not found' });
    res.json({ message: 'Dividend marked as paid' });
  } catch(e) { next(e); }
});

// GET /api/settings/reminders
router.get('/reminders', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const today = new Date();
    const cm    = today.toISOString().slice(0,7);
    const sdRow = await db.one("SELECT value FROM settings WHERE key='savings_due_day'");
    const rdRow = await db.one("SELECT value FROM settings WHERE key='repayment_due_day'");
    const savingsDueDay = parseInt(sdRow?.value||'5');
    const repayDueDay   = parseInt(rdRow?.value||'10');
    const unpaidSavings = await db.all(
      `SELECT m.id,m.name,m.phone,m.monthly_saving FROM members m WHERE m.status='active' AND NOT EXISTS (SELECT 1 FROM savings s WHERE s.member_id=m.id AND s.month=$1)`,
      [cm]
    );
    const unpaidRepayments = await db.all(
      `SELECT r.*,m.name as member_name,m.phone as member_phone,l.id as loan_id FROM repayments r JOIN loans l ON r.loan_id=l.id JOIN members m ON l.member_id=m.id WHERE l.status='active' AND r.month=$1 AND r.status NOT IN ('paid','pending_review')`,
      [cm]
    );
    res.json({ today: today.toISOString().split('T')[0], savings_due_day: savingsDueDay, repay_due_day: repayDueDay,
      days_until_savings_due: savingsDueDay - today.getDate(), days_until_repay_due: repayDueDay - today.getDate(),
      savings_overdue: today.getDate() > savingsDueDay, repay_overdue: today.getDate() > repayDueDay,
      unpaid_savings: unpaidSavings, unpaid_repayments: unpaidRepayments });
  } catch(e) { next(e); }
});

// GET /api/settings/due-alerts — comprehensive due date alerts for admin home
router.get('/due-alerts', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const today = new Date();
    const cm    = today.toISOString().slice(0,7);
    const todayStr = today.toISOString().split('T')[0];
    const dayOfMonth = today.getDate();

    const [sdRow, rdRow, graceRow] = await Promise.all([
      db.one("SELECT value FROM settings WHERE key='savings_due_day'"),
      db.one("SELECT value FROM settings WHERE key='repayment_due_day'"),
      db.one("SELECT value FROM settings WHERE key='grace_period_days'"),
    ]);
    const savingsDueDay = parseInt(sdRow?.value||'5');
    const repayDueDay   = parseInt(rdRow?.value||'10');
    const graceDays     = parseInt(graceRow?.value||'3');

    // Members who haven't paid savings this month
    const unpaidSavings = await db.all(
      `SELECT m.id,m.name,m.phone,m.monthly_saving,
        CASE WHEN $2::int > $3::int THEN 'overdue' WHEN $2::int > ($3::int - 3) THEN 'due_soon' ELSE 'upcoming' END as urgency
       FROM members m WHERE m.status='active'
       AND NOT EXISTS (SELECT 1 FROM savings s WHERE s.member_id=m.id AND s.month=$1)
       ORDER BY m.name ASC`,
      [cm, dayOfMonth, savingsDueDay]
    );

    // Repayments due this month not yet paid
    const unpaidRepayments = await db.all(
      `SELECT r.*,m.name as member_name,m.phone as member_phone,l.id as loan_id,
        CASE WHEN $2::int > $3::int THEN 'overdue' WHEN $2::int > ($3::int - 3) THEN 'due_soon' ELSE 'upcoming' END as urgency
       FROM repayments r JOIN loans l ON r.loan_id=l.id JOIN members m ON l.member_id=m.id
       WHERE l.status='active' AND r.month=$1 AND r.status NOT IN ('paid','pending_review')
       ORDER BY m.name ASC`,
      [cm, dayOfMonth, repayDueDay]
    );

    // Overdue repayments from previous months
    const overdueRepayments = await db.all(
      `SELECT r.*,m.name as member_name,m.phone as member_phone,l.id as loan_id
       FROM repayments r JOIN loans l ON r.loan_id=l.id JOIN members m ON l.member_id=m.id
       WHERE l.status='active' AND r.status='overdue'
       ORDER BY r.month ASC, m.name ASC`
    );

    // Pending savings approvals
    const pendingSavings = await db.all(
      `SELECT s.*,m.name as member_name,m.phone as member_phone
       FROM savings s JOIN members m ON s.member_id=m.id
       WHERE s.status='pending_review' ORDER BY s.created_at DESC`
    );

    // Pending repayment approvals
    const pendingRepayments = await db.all(
      `SELECT r.*,m.name as member_name,l.id as loan_id
       FROM repayments r JOIN loans l ON r.loan_id=l.id JOIN members m ON l.member_id=m.id
       WHERE r.status='pending_review' ORDER BY r.paid_date DESC`
    );

    // Pending loan applications
    const pendingLoans = await db.all(
      `SELECT l.*,m.name as member_name,m.phone as member_phone
       FROM loans l JOIN members m ON l.member_id=m.id
       WHERE l.status='pending' ORDER BY l.queue_position ASC`
    );

    res.json({
      today: todayStr,
      savings_due_day: savingsDueDay,
      repay_due_day: repayDueDay,
      grace_days: graceDays,
      days_until_savings_due: savingsDueDay - dayOfMonth,
      days_until_repay_due: repayDueDay - dayOfMonth,
      savings_overdue: dayOfMonth > savingsDueDay + graceDays,
      repay_overdue: dayOfMonth > repayDueDay + graceDays,
      unpaid_savings: unpaidSavings,
      unpaid_repayments: unpaidRepayments,
      overdue_repayments: overdueRepayments,
      pending_savings: pendingSavings,
      pending_repayments: pendingRepayments,
      pending_loans: pendingLoans,
      summary: {
        unpaid_savings_count: unpaidSavings.length,
        unpaid_repayments_count: unpaidRepayments.length,
        overdue_count: overdueRepayments.length,
        pending_approvals: pendingSavings.length + pendingRepayments.length,
        pending_loans: pendingLoans.length,
      }
    });
  } catch(e) { next(e); }
});

// GET /api/settings/dashboard-stats
router.get('/dashboard-stats', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const cm = new Date().toISOString().slice(0,7);
    const d = new Date(); d.setMonth(d.getMonth()-1);
    const prevMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const [tm, ts, tlb, cl, pl, sp, tps, tpr, cms, pms, ptm] = await Promise.all([
      db.one("SELECT COUNT(*) as c FROM members WHERE status='active'"),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE status IN ('paid','late')"),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM loans WHERE status='active'"),
      db.one("SELECT COUNT(*) as c FROM loans WHERE status='completed'"),
      db.one("SELECT COUNT(*) as c FROM loans WHERE status='pending'"),
      db.one("SELECT COALESCE(SUM(penalty),0) as t FROM savings"),
      db.one("SELECT COALESCE(SUM(penalty),0) as t FROM repayments"),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM repayments WHERE status='paid'"),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE month=$1 AND status IN ('paid','late')", [cm]),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE month=$1 AND status IN ('paid','late')", [prevMonth]),
      db.one("SELECT COUNT(*) as c FROM savings WHERE month=$1 AND status IN ('paid','late')", [cm]),
    ]);
    const totalPenalties = Number(sp.t) + Number(tpr.t);
    const trend = [];
    for (let i=5; i>=0; i--) {
      const dd=new Date(); dd.setMonth(dd.getMonth()-i);
      const mo=`${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}`;
      const row = await db.one("SELECT COALESCE(SUM(amount),0) as t,COUNT(*) as c FROM savings WHERE month=$1 AND status IN ('paid','late')", [mo]);
      trend.push({ month:mo, total:Number(row.t), count:Number(row.c) });
    }
    const totalMembers = Number(tm.c), paidThisMonth = Number(ptm.c);
    res.json({ totalMembers, totalSavings: Number(ts.t), totalLoanBook: Number(tlb.t),
      completedLoans: Number(cl.c), pendingLoans: Number(pl.c), totalPenalties,
      thisMonthSavings: Number(cms.t), prevMonthSavings: Number(pms.t), paidThisMonth,
      collectionRate: totalMembers>0 ? Math.round(paidThisMonth/totalMembers*100) : 0,
      savingsGrowth: Number(pms.t)>0 ? Math.round((Number(cms.t)-Number(pms.t))/Number(pms.t)*100) : 0,
      trend });
  } catch(e) { next(e); }
});

// GET /api/settings/financial-report
router.get('/financial-report', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const fromDate = req.query.from || '2020-01-01';
    const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
    const [tm, ts, tps, tpr, la, lc, tr, od, al] = await Promise.all([
      db.one("SELECT COUNT(*) as c FROM members WHERE status='active'"),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE status IN ('paid','late') AND paid_date BETWEEN $1 AND $2", [fromDate, toDate]),
      db.one("SELECT COALESCE(SUM(penalty),0) as t FROM savings WHERE paid_date BETWEEN $1 AND $2", [fromDate, toDate]),
      db.one("SELECT COALESCE(SUM(penalty),0) as t FROM repayments WHERE paid_date BETWEEN $1 AND $2", [fromDate, toDate]),
      db.one("SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as t FROM loans WHERE approve_date BETWEEN $1 AND $2", [fromDate, toDate]),
      db.one("SELECT COUNT(*) as c FROM loans WHERE status='completed'"),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM repayments WHERE status='paid' AND paid_date BETWEEN $1 AND $2", [fromDate, toDate]),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM repayments WHERE status='overdue'"),
      db.one("SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as t FROM loans WHERE status='active'"),
    ]);
    const totalPenalties = Number(tps.t) + Number(tpr.t);
    const monthlyBreakdown = await db.all(
      `SELECT LEFT(paid_date,7) as month, COUNT(*) as payments, SUM(amount) as collected, SUM(penalty) as penalties FROM savings WHERE status IN ('paid','late') AND paid_date BETWEEN $1 AND $2 GROUP BY LEFT(paid_date,7) ORDER BY LEFT(paid_date,7) ASC`,
      [fromDate, toDate]
    );
    res.json({ period: { from: fromDate, to: toDate }, members: { total: Number(tm.c) },
      savings: { total: Number(ts.t), penalties: totalPenalties },
      loans: { approved_count: Number(la.c), approved_amount: Number(la.t), completed: Number(lc.c),
        active_count: Number(al.c), active_book: Number(al.t), total_repaid: Number(tr.t), overdue: Number(od.t) },
      income: { savings_penalties: totalPenalties },
      monthly_breakdown: monthlyBreakdown });
  } catch(e) { next(e); }
});

// ── PAYMENT BANKS ─────────────────────────────────────────────────────────

// GET /api/settings/banks — public (members need to see where to pay)
router.get('/banks', authMiddleware, async (req, res, next) => {
  try {
    const banks = await db.all('SELECT * FROM payment_banks WHERE is_active=1 ORDER BY sort_order ASC, bank_name ASC');
    res.json(banks);
  } catch(e) { next(e); }
});

// GET /api/settings/banks/all — admin sees all including inactive
router.get('/banks/all', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    res.json(await db.all('SELECT * FROM payment_banks ORDER BY sort_order ASC, bank_name ASC'));
  } catch(e) { next(e); }
});

// POST /api/settings/banks
router.post('/banks', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { bank_name, account_number, account_holder, sort_order } = req.body;
    if (!bank_name?.trim())      return res.status(400).json({ error: 'bank_name is required' });
    if (!account_number?.trim()) return res.status(400).json({ error: 'account_number is required' });
    // Sanitize: only allow digits, spaces, dashes in account number
    if (!/^[\d\s\-]+$/.test(account_number.trim()))
      return res.status(400).json({ error: 'account_number must contain only digits, spaces, or dashes' });
    const r = await db.run(
      'INSERT INTO payment_banks (bank_name,account_number,account_holder,is_active,sort_order) VALUES ($1,$2,$3,1,$4)',
      [bank_name.trim(), account_number.trim(), (account_holder||'Wazema SCBC').trim(), Number(sort_order)||0]
    );
    await auditLog('admin', 'ADD_BANK', String(r.lastId), bank_name.trim());
    res.status(201).json({ id: r.lastId, message: 'Bank account added' });
  } catch(e) { next(e); }
});

// PATCH /api/settings/banks/:id
router.patch('/banks/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const bank = await db.one('SELECT * FROM payment_banks WHERE id=$1', [req.params.id]);
    if (!bank) return res.status(404).json({ error: 'Bank not found' });
    const { bank_name, account_number, account_holder, is_active, sort_order } = req.body;
    if (account_number && !/^[\d\s\-]+$/.test(account_number.trim()))
      return res.status(400).json({ error: 'account_number must contain only digits, spaces, or dashes' });
    await db.run(
      'UPDATE payment_banks SET bank_name=$1,account_number=$2,account_holder=$3,is_active=$4,sort_order=$5 WHERE id=$6',
      [
        bank_name?.trim()       || bank.bank_name,
        account_number?.trim()  || bank.account_number,
        account_holder?.trim()  || bank.account_holder,
        is_active !== undefined ? (is_active ? 1 : 0) : bank.is_active,
        sort_order !== undefined ? Number(sort_order) : bank.sort_order,
        req.params.id
      ]
    );
    await auditLog('admin', 'UPDATE_BANK', req.params.id, bank_name || bank.bank_name);
    res.json({ message: 'Bank account updated' });
  } catch(e) { next(e); }
});

// DELETE /api/settings/banks/:id
router.delete('/banks/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const r = await db.run('DELETE FROM payment_banks WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Bank not found' });
    await auditLog('admin', 'DELETE_BANK', req.params.id, null);
    res.json({ message: 'Bank account deleted' });
  } catch(e) { next(e); }
});

module.exports = router;
