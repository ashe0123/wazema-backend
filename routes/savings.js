const express = require('express');
const db      = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { isValidAmount, isValidMonth, isValidDate } = require('../middleware/validate');

const router = express.Router();
const SAVINGS_DUE_DAY   = 5;
const LATE_PENALTY_RATE = 0.02;

const crypto = require('crypto');
function genId(p)      { return p + '-' + crypto.randomBytes(5).toString('hex').toUpperCase(); }
function validMonth(m) { return /^\d{4}-\d{2}$/.test(m); }

async function getGracePeriod() {
  try { const r = await db.one("SELECT value FROM settings WHERE key='grace_period_days'"); return parseInt(r?.value||'0'); } catch { return 0; }
}
async function getDueDay() {
  try { const r = await db.one("SELECT value FROM settings WHERE key='savings_due_day'"); return parseInt(r?.value||String(SAVINGS_DUE_DAY)); } catch { return SAVINGS_DUE_DAY; }
}
async function getPenaltyRate() {
  try { const r = await db.one("SELECT value FROM settings WHERE key='late_penalty_rate'"); return parseFloat(r?.value||String(LATE_PENALTY_RATE)); } catch { return LATE_PENALTY_RATE; }
}

async function calcPenalty(amount, paid_date, month) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  // No penalty for future/advance payments (month being paid is in the future)
  if (month && month > currentMonth) return 0;
  // For past months (overdue), penalty always applies
  if (month && month < currentMonth) {
    const rate = await getPenaltyRate();
    return parseFloat((amount * rate).toFixed(2));
  }
  // For current month, check if paid after due day + grace
  const dueDay = await getDueDay();
  const grace  = await getGracePeriod();
  const rate   = await getPenaltyRate();
  return new Date(paid_date).getDate() > (dueDay + grace)
    ? parseFloat((amount * rate).toFixed(2)) : 0;
}

// GET /api/savings/pending
router.get('/pending', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    res.json(await db.all(
      "SELECT s.*,m.name as member_name,m.phone as member_phone FROM savings s JOIN members m ON s.member_id=m.id WHERE s.status='pending_review' ORDER BY s.created_at DESC"
    ));
  } catch(e) { next(e); }
});

// GET /api/savings/summary
router.get('/summary', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0,7);
    if (!validMonth(month)) return res.status(400).json({ error: 'Invalid month format' });
    const members = await db.all("SELECT id,name,monthly_saving FROM members WHERE status='active' ORDER BY id ASC");
    const paid    = await db.all('SELECT * FROM savings WHERE month=$1', [month]);
    const paidMap = new Map(paid.map(p => [p.member_id, p]));
    const summary = members.map(m => ({ ...m, paid: paidMap.has(m.id), payment: paidMap.get(m.id)||null }));
    const totRow  = await db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE status IN ('paid','late')");
    const prRow   = await db.one("SELECT COUNT(*) as c FROM savings WHERE status='pending_review'");
    res.json({ month, summary, totalCollected: Number(totRow.t), paidCount: paidMap.size,
      unpaidCount: members.length - paidMap.size, pendingReview: Number(prRow.c), due_day: SAVINGS_DUE_DAY });
  } catch(e) { next(e); }
});

// GET /api/savings/yearly
router.get('/yearly', authMiddleware, async (req, res, next) => {
  try {
    const memberId = req.user.role==='member' ? req.user.id : req.query.memberId;
    let sql = "SELECT substr(month,1,4) as year,COUNT(*) as months_paid,SUM(amount) as total_amount,SUM(penalty) as total_penalty FROM savings WHERE status IN ('paid','late')";
    const p = [];
    if (memberId) { sql += ' AND member_id=$1'; p.push(memberId); }
    sql += ' GROUP BY year ORDER BY year DESC';
    res.json(await db.all(sql, p));
  } catch(e) { next(e); }
});

// GET /api/savings/export/csv
router.get('/export/csv', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { memberId, month } = req.query;
    let sql = 'SELECT s.*,m.name as member_name FROM savings s JOIN members m ON s.member_id=m.id';
    const p = [], c = [];
    if (memberId) { c.push('s.member_id=$' + (p.length+1)); p.push(memberId); }
    if (month)    { c.push('s.month=$'     + (p.length+1)); p.push(month); }
    if (c.length) sql += ' WHERE ' + c.join(' AND ');
    sql += ' ORDER BY s.month DESC';
    const rows = await db.all(sql, p);
    const header = 'ID,Member ID,Member Name,Month,Amount,Paid Date,Status,Penalty\n';
    const csv = rows.map(s =>
      s.id + ',' + s.member_id + ',"' + s.member_name + '",' + s.month + ',' + s.amount + ',' + (s.paid_date||'') + ',' + s.status + ',' + (s.penalty||0)
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="savings.csv"');
    res.send(header + csv);
  } catch(e) { next(e); }
});

// GET /api/savings/interest — get accrued interest for a member
router.get('/interest', authMiddleware, async (req, res, next) => {
  try {
    const memberId = req.user.role === 'member' ? req.user.id : req.query.memberId;
    if (!memberId) return res.status(400).json({ error: 'memberId required' });
    const rows = await db.all('SELECT * FROM interest_accruals WHERE member_id=$1 ORDER BY month DESC', [memberId]);
    const total = rows.reduce((a, r) => a + Number(r.interest_amount), 0);
    res.json({ member_id: memberId, accruals: rows, total_interest: total });
  } catch(e) { next(e); }
});

// POST /api/savings/accrue-interest — admin triggers monthly interest accrual
router.post('/accrue-interest', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const month = req.body.month || new Date().toISOString().slice(0,7);
    if (!validMonth(month)) return res.status(400).json({ error: 'Invalid month format' });
    const enabledRow = await db.one("SELECT value FROM settings WHERE key='savings_interest_enabled'");
    if (!enabledRow || enabledRow.value !== '1') return res.status(400).json({ error: 'Savings interest accrual is disabled. Enable it in Settings.' });
    const members = await db.all("SELECT id,saving_interest_pct FROM members WHERE status='active' AND saving_interest_pct > 0");
    const results = [];
    for (const m of members) {
      const existing = await db.one('SELECT id FROM interest_accruals WHERE member_id=$1 AND month=$2', [m.id, month]);
      if (existing) { results.push({ member_id: m.id, status: 'already_accrued' }); continue; }
      const balRow = await db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE member_id=$1 AND status IN ('paid','late')", [m.id]);
      const balance = Number(balRow.t);
      if (balance <= 0) continue;
      const rate   = Number(m.saving_interest_pct) / 100;
      const interest = parseFloat((balance * rate / 12).toFixed(2)); // monthly interest
      await db.run('INSERT INTO interest_accruals (member_id,month,balance,rate,interest_amount) VALUES ($1,$2,$3,$4,$5)',
        [m.id, month, balance, rate, interest]);
      results.push({ member_id: m.id, balance, rate, interest_amount: interest, status: 'accrued' });
    }
    res.json({ month, processed: results.length, results });
  } catch(e) { next(e); }
});

// GET /api/savings
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'member')
      return res.json(await db.all('SELECT * FROM savings WHERE member_id=$1 ORDER BY month ASC', [req.user.id]));
    const { memberId, month } = req.query;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(500, parseInt(req.query.limit) || 200);
    const offset = (page - 1) * limit;
    let baseSql = 'SELECT s.*,m.name as member_name FROM savings s JOIN members m ON s.member_id=m.id';
    const p = [], c = [];
    if (memberId) { c.push('s.member_id=$' + (p.length+1)); p.push(memberId); }
    if (month)    { c.push('s.month=$'     + (p.length+1)); p.push(month); }
    if (c.length) baseSql += ' WHERE ' + c.join(' AND ');
    const rows = await db.all(baseSql + ' ORDER BY s.month DESC LIMIT $' + (p.length+1) + ' OFFSET $' + (p.length+2), [...p, limit, offset]);
    if (!req.query.page && !req.query.limit) return res.json(rows);
    const total = await db.one('SELECT COUNT(*) as c FROM savings s' + (c.length ? ' WHERE ' + c.join(' AND ') : ''), p);
    res.json({ data: rows, total: Number(total.c), page, limit });
  } catch(e) { next(e); }
});

// POST /api/savings
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { member_id, month, amount, paid_date, status, penalty, bank_name, account_number } = req.body;
    const targetId = req.user.role === 'member' ? req.user.id : member_id;
    if (!targetId) return res.status(400).json({ error: 'member_id required' });
    if (!month || !amount || !paid_date) return res.status(400).json({ error: 'Missing required fields' });
    if (!isValidMonth(month)) return res.status(400).json({ error: 'Invalid month format (YYYY-MM)' });
    if (!isValidDate(paid_date)) return res.status(400).json({ error: 'Invalid payment date' });
    if (!isValidAmount(amount)) return res.status(400).json({ error: 'Amount must be a positive number under 100,000,000' });
    // Validate bank info for member submissions
    if (req.user.role === 'member') {
      if (!bank_name?.trim()) return res.status(400).json({ error: 'Bank name is required' });
      if (!account_number?.trim()) return res.status(400).json({ error: 'Account number is required' });
    }
    const member = await db.one('SELECT id,monthly_saving FROM members WHERE id=$1', [targetId]);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    // Calculate penalty first to enforce minimum amount
    const isFutureMonth = month > new Date().toISOString().slice(0, 7);
    const autoPenalty   = req.user.role === 'member' ? await calcPenalty(Number(member.monthly_saving), paid_date, month) : (Number(penalty)||0);
    const minRequired   = Number(member.monthly_saving) + autoPenalty;
    if (Number(amount) < Number(member.monthly_saving))
      return res.status(400).json({ error: 'Amount must be at least ETB ' + member.monthly_saving + ' (your monthly saving)' });
    if (autoPenalty > 0 && Number(amount) < minRequired)
      return res.status(400).json({ error: `Amount must be at least ETB ${minRequired.toFixed(2)} (ETB ${member.monthly_saving} + ETB ${autoPenalty} penalty for late payment)` });
    const existing = await db.one('SELECT id FROM savings WHERE member_id=$1 AND month=$2', [targetId, month]);
    if (existing) return res.status(409).json({ error: 'Payment already recorded for this month' });
    const finalStatus   = req.user.role === 'member'
      ? 'pending_review'
      : (isFutureMonth ? 'paid' : (['paid','late'].includes(status) ? status : 'paid'));
    const id = genId('SV');
    await db.run('INSERT INTO savings (id,member_id,month,amount,paid_date,status,penalty,bank_name,account_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, targetId, month, Number(amount), paid_date, finalStatus, autoPenalty,
       bank_name?.trim()||null, account_number?.trim()||null]);
    res.status(201).json({ id, message: req.user.role==='member'?'Payment submitted for review':'Savings recorded', penalty_applied: autoPenalty });
  } catch(e) { next(e); }
});

// POST /api/savings/bulk-admin
router.post('/bulk-admin', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { month, paid_date, status } = req.body;
    if (!month || !paid_date) return res.status(400).json({ error: 'month and paid_date required' });
    const members = await db.all("SELECT id,monthly_saving FROM members WHERE status='active'");
    const finalStatus = ['paid','late'].includes(status) ? status : 'paid';
    const results = [];
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const existing = await db.one('SELECT id FROM savings WHERE member_id=$1 AND month=$2', [m.id, month]);
      if (existing) { results.push({ member_id: m.id, status: 'already_recorded' }); continue; }
      const id = genId('SV') + i;
      await db.run('INSERT INTO savings (id,member_id,month,amount,paid_date,status,penalty) VALUES ($1,$2,$3,$4,$5,$6,0)',
        [id, m.id, month, m.monthly_saving, paid_date, finalStatus]);
      results.push({ member_id: m.id, id, amount: m.monthly_saving, status: finalStatus });
    }
    res.status(201).json({ message: 'Recorded ' + results.filter(r=>r.id).length + ' payments', results });
  } catch(e) { next(e); }
});

// GET /api/savings/:id — full detail for admin review
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const row = await db.one(
      'SELECT s.*,m.name as member_name,m.phone as member_phone,m.monthly_saving FROM savings s JOIN members m ON s.member_id=m.id WHERE s.id=$1',
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Saving record not found' });
    if (req.user.role === 'member' && row.member_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json(row);
  } catch(e) { next(e); }
});

// PATCH /api/savings/:id/confirm
router.patch('/:id/confirm', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { status, penalty } = req.body;
    const row = await db.one('SELECT * FROM savings WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Record not found' });
    await db.run('UPDATE savings SET status=$1,penalty=$2 WHERE id=$3',
      [['paid','late'].includes(status)?status:'paid', Number(penalty)||0, req.params.id]);
    res.json({ message: 'Savings confirmed' });
  } catch(e) { next(e); }
});

// POST /api/savings/bulk-confirm — bulk approve multiple savings
router.post('/bulk-confirm', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    if (ids.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });
    }
    const finalStatus = ['paid', 'late'].includes(status) ? status : 'paid';
    const results = [];
    
    for (const id of ids) {
      try {
        const row = await db.one('SELECT * FROM savings WHERE id=$1', [id]);
        if (!row) {
          results.push({ id, status: 'not_found' });
          continue;
        }
        if (row.status !== 'pending_review') {
          results.push({ id, status: 'already_processed', current_status: row.status });
          continue;
        }
        await db.run('UPDATE savings SET status=$1 WHERE id=$2', [finalStatus, id]);
        results.push({ id, status: 'confirmed', new_status: finalStatus });
      } catch (err) {
        results.push({ id, status: 'error', error: err.message });
      }
    }
    
    const confirmed = results.filter(r => r.status === 'confirmed').length;
    res.json({ 
      message: `Confirmed ${confirmed} of ${ids.length} payment(s)`, 
      confirmed,
      total: ids.length,
      results 
    });
  } catch(e) { next(e); }
});

// PATCH /api/savings/:id/waive-penalty
router.patch('/:id/waive-penalty', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const row = await db.one('SELECT * FROM savings WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Record not found' });
    await db.run('UPDATE savings SET penalty=0 WHERE id=$1', [req.params.id]);
    res.json({ message: 'Penalty waived successfully' });
  } catch(e) { next(e); }
});

module.exports = router;
