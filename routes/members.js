const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

function buildName(f, m, l) { return [f, m, l].filter(Boolean).join(' ').trim(); }
function normalizePhone(p) {
  if (!p) return '';
  const s = p.toString().trim().replace(/\s+/g, '');
  if (s.startsWith('+251')) return s;
  if (s.startsWith('251'))  return '+' + s;
  if (s.startsWith('0'))    return '+251' + s.slice(1);
  return '+251' + s;
}

function validateEthiopianPhone(p) {
  if (!p) return 'Phone number is required';
  const s = p.toString().trim().replace(/\s+/g, '');
  // Accept: 09XXXXXXXX (10 digits), +2519XXXXXXXX, 2519XXXXXXXX
  const local = s.startsWith('+251') ? '0' + s.slice(4) : s.startsWith('251') ? '0' + s.slice(3) : s;
  if (!/^09\d{8}$/.test(local)) return 'Phone must start with 09 and be 10 digits (e.g. 0911234567)';
  return null;
}
async function auditLog(actor, action, target, detail) {
  try { await db.run('INSERT INTO audit_log (actor,action,target,detail) VALUES ($1,$2,$3,$4)', [actor, action, target||null, detail||null]); } catch {}
}

// GET /api/members
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'admin') {
      const page  = Math.max(1, parseInt(req.query.page)  || 1);
      const limit = Math.min(200, parseInt(req.query.limit) || 100);
      const offset = (page - 1) * limit;
      const search = req.query.search ? `%${req.query.search}%` : null;
      let sql = 'SELECT * FROM members';
      const params = [];
      if (search) {
        sql += ' WHERE (name ILIKE $1 OR id ILIKE $1 OR phone ILIKE $1)';
        params.push(search);
      }
      sql += ` ORDER BY created_at ASC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
      params.push(limit, offset);
      const countSql = search
        ? 'SELECT COUNT(*) as c FROM members WHERE (name ILIKE $1 OR id ILIKE $1 OR phone ILIKE $1)'
        : 'SELECT COUNT(*) as c FROM members';
      const [rows, total] = await Promise.all([
        db.all(sql, params),
        db.one(countSql, search ? [search] : []),
      ]);
      // If no pagination params given, return plain array for backward compat
      if (!req.query.page && !req.query.limit) return res.json(rows);
      return res.json({ data: rows, total: Number(total.c), page, limit, pages: Math.ceil(Number(total.c)/limit) });
    }
    const m = await db.one('SELECT * FROM members WHERE id=$1', [req.user.id]);
    if (!m) return res.status(404).json({ error: 'Member not found' });
    res.json(m);
  } catch(e) { next(e); }
});

// POST /api/members
router.post('/', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const {
      first_name, middle_name = '', last_name = '',
      phone, email, monthly_saving, join_date, password,
      account_type = 'Regular', saving_interest_pct = 0,
      share_amount = 1000, share_qty = 1, registration_fee = 300,
      share_paid = 0, reg_fee_paid = 0,
      date_of_birth, age, gender, address,
    } = req.body;

    if (!first_name?.trim()) return res.status(400).json({ error: 'First name is required' });
    if (!middle_name?.trim()) return res.status(400).json({ error: 'Middle name is required' });
    if (!last_name?.trim())  return res.status(400).json({ error: 'Last name is required' });
    if (!phone?.trim())      return res.status(400).json({ error: 'Phone number is required' });
    const phoneErr = validateEthiopianPhone(phone);
    if (phoneErr) return res.status(400).json({ error: phoneErr });
    if (!monthly_saving)     return res.status(400).json({ error: 'Monthly saving amount is required' });
    if (!join_date)          return res.status(400).json({ error: 'Join date is required' });
    if (!date_of_birth)      return res.status(400).json({ error: 'Date of birth is required' });
    if (!address?.trim())    return res.status(400).json({ error: 'Address / Kebele is required' });
    if (!password?.trim())   return res.status(400).json({ error: 'Password is required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    if (!['Regular','Interest','Childrens'].includes(account_type))
      return res.status(400).json({ error: 'Invalid account type' });

    const normalizedPhone = normalizePhone(phone);
    const existing = await db.one('SELECT id FROM members WHERE phone=$1', [normalizedPhone]);
    if (existing) return res.status(409).json({ error: 'Phone number already registered' });

    const countRow = await db.one("SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 4) AS INTEGER)),0) as m FROM members WHERE id LIKE 'WZ-%'");
    const id    = 'WZ-' + String(Number(countRow.m) + 1).padStart(3, '0');
    const name  = buildName(first_name.trim(), middle_name.trim(), last_name.trim());
    const totalShareAmount = Number(share_amount) * Number(share_qty);

    await db.run(
      `INSERT INTO members (id,first_name,middle_name,last_name,name,phone,email,join_date,
       account_type,monthly_saving,saving_interest_pct,share_amount,share_qty,
       registration_fee,share_paid,reg_fee_paid,date_of_birth,age,gender,address,status,password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'active',$21)`,
      [id, first_name.trim(), middle_name.trim(), last_name.trim(), name,
       normalizedPhone, email?.trim() || '', join_date, account_type,
       Number(monthly_saving), Number(saving_interest_pct),
       totalShareAmount, Number(share_qty), Number(registration_fee),
       share_paid ? 1 : 0, reg_fee_paid ? 1 : 0,
       date_of_birth || null, age ? Number(age) : null, gender || null, address || null,
       bcrypt.hashSync(password, 10)]
    );

    // Auto-record first month saving from registration payment
    const joinMonth = join_date.substring(0, 7); // YYYY-MM
    const svId = 'SV-' + id + '-REG';
    await db.run(
      'INSERT INTO savings (id,member_id,month,amount,paid_date,status,penalty) VALUES ($1,$2,$3,$4,$5,$6,0)',
      [svId, id, joinMonth, Number(monthly_saving), join_date, 'paid']
    );

    await auditLog('admin', 'REGISTER_MEMBER', id, name);
    res.status(201).json({ id, name, message: 'Member registered successfully' });
  } catch(e) { next(e); }
});

// PATCH /api/members/:id
router.patch('/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const m = await db.one('SELECT * FROM members WHERE id=$1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Member not found' });
    const { first_name, middle_name, last_name, phone, email, monthly_saving,
            account_type, saving_interest_pct, share_amount, share_qty, registration_fee,
            share_paid, reg_fee_paid } = req.body;
    const newFirst  = first_name?.trim()  || m.first_name;
    const newMiddle = middle_name?.trim() ?? m.middle_name;
    const newLast   = last_name?.trim()   ?? m.last_name;
    const newName   = buildName(newFirst, newMiddle, newLast);
    const newPhone  = phone ? normalizePhone(phone) : m.phone;
    const newShareQty = share_qty !== undefined ? Number(share_qty) : m.share_qty;
    const newShareAmt = share_amount !== undefined ? Number(share_amount) * newShareQty : m.share_amount;
    await db.run(
      `UPDATE members SET first_name=$1,middle_name=$2,last_name=$3,name=$4,phone=$5,email=$6,
       monthly_saving=$7,account_type=$8,saving_interest_pct=$9,share_amount=$10,share_qty=$11,
       registration_fee=$12,share_paid=$13,reg_fee_paid=$14 WHERE id=$15`,
      [newFirst, newMiddle, newLast, newName, newPhone,
       email?.trim() ?? m.email,
       monthly_saving ? Number(monthly_saving) : m.monthly_saving,
       account_type || m.account_type,
       saving_interest_pct !== undefined ? Number(saving_interest_pct) : m.saving_interest_pct,
       newShareAmt, newShareQty,
       registration_fee !== undefined ? Number(registration_fee) : m.registration_fee,
       share_paid !== undefined ? (share_paid ? 1 : 0) : m.share_paid,
       reg_fee_paid !== undefined ? (reg_fee_paid ? 1 : 0) : m.reg_fee_paid,
       req.params.id]
    );
    res.json({ message: 'Member updated' });
  } catch(e) { next(e); }
});

// PATCH /api/members/:id/status
router.patch('/:id/status', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['active','inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const r = await db.run('UPDATE members SET status=$1 WHERE id=$2', [status, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Member not found' });
    res.json({ message: 'Status updated' });
  } catch(e) { next(e); }
});

// PATCH /api/members/:id/reset-password
router.patch('/:id/reset-password', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const r = await db.run('UPDATE members SET password=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Member not found' });
    res.json({ message: 'Password reset successfully' });
  } catch(e) { next(e); }
});

// GET /api/members/export/csv
router.get('/export/csv', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const members = await db.all('SELECT * FROM members ORDER BY id ASC');
    const header = 'ID,First Name,Middle Name,Last Name,Phone,Email,Account Type,Join Date,Monthly Saving,Share Amount,Share Qty,Reg Fee,Share Paid,Reg Fee Paid,Status\n';
    const rows = members.map(m =>
      `${m.id},"${m.first_name}","${m.middle_name||''}","${m.last_name||''}",${m.phone},"${m.email||''}",${m.account_type},${m.join_date},${m.monthly_saving},${m.share_amount||1000},${m.share_qty||1},${m.registration_fee||300},${m.share_paid?'Yes':'No'},${m.reg_fee_paid?'Yes':'No'},${m.status}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
    res.send(header + rows);
  } catch(e) { next(e); }
});

// GET /api/members/:id/score
router.get('/:id/score', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'member' && req.user.id !== req.params.id) return res.status(403).json({ error: 'Access denied' });
    const savings  = await db.all('SELECT * FROM savings WHERE member_id=$1', [req.params.id]);
    const loans    = await db.all('SELECT * FROM loans WHERE member_id=$1', [req.params.id]);
    const monthsPaid   = savings.filter(s=>['paid','late'].includes(s.status)).length;
    const lateCount    = savings.filter(s=>s.status==='late').length;
    const onTimeCount  = savings.filter(s=>s.status==='paid').length;
    const totalSaved   = savings.filter(s=>['paid','late'].includes(s.status)).reduce((a,s)=>a+Number(s.amount),0);
    const totalPenalty = savings.reduce((a,s)=>a+Number(s.penalty||0),0);
    const completedLoans = loans.filter(l=>l.status==='completed').length;
    const rejectedLoans  = loans.filter(l=>l.status==='rejected').length;
    const consistencyScore = monthsPaid>0 ? Math.round((onTimeCount/monthsPaid)*40) : 0;
    const volumeScore      = Math.min(Math.round((monthsPaid/24)*25),25);
    const penaltyScore     = 20 - Math.min(lateCount*4,20);
    const loanScore        = completedLoans>0 ? Math.min(completedLoans*5,15) : (rejectedLoans>0?5:10);
    const score = consistencyScore+volumeScore+penaltyScore+loanScore;
    res.json({
      member_id: req.params.id, score,
      grade: score>=85?'A':score>=70?'B':score>=55?'C':score>=40?'D':'F',
      risk:  score>=70?'Low':score>=50?'Medium':'High',
      breakdown: {
        consistency:  { score:consistencyScore, max:40, label:'Payment Consistency' },
        volume:       { score:volumeScore,      max:25, label:'Savings Volume' },
        penalty:      { score:penaltyScore,     max:20, label:'Penalty Record' },
        loan_history: { score:loanScore,        max:15, label:'Loan History' },
      },
      stats: { monthsPaid, lateCount, onTimeCount, totalSaved, completedLoans, totalPenalty },
    });
  } catch(e) { next(e); }
});

// GET /api/members/:id/activity
router.get('/:id/activity', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role==='member' && req.user.id!==req.params.id) return res.status(403).json({ error:'Access denied' });
    const savings  = await db.all("SELECT 'saving' as type,id,month,amount,paid_date as date,status,penalty FROM savings WHERE member_id=$1 ORDER BY paid_date DESC LIMIT 10", [req.params.id]);
    const loans    = await db.all("SELECT 'loan' as type,id,amount,request_date as date,status,approve_date FROM loans WHERE member_id=$1 ORDER BY request_date DESC LIMIT 5", [req.params.id]);
    const repays   = await db.all(`SELECT 'repayment' as type,r.id,r.amount,r.paid_date as date,r.status,r.month,r.penalty FROM repayments r JOIN loans l ON r.loan_id=l.id WHERE l.member_id=$1 AND r.paid_date IS NOT NULL ORDER BY r.paid_date DESC LIMIT 10`, [req.params.id]);
    const all = [...savings,...loans,...repays].sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,20);
    res.json(all);
  } catch(e) { next(e); }
});

// GET /api/members/:id/stats
router.get('/:id/stats', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const member = await db.one('SELECT * FROM members WHERE id=$1', [req.params.id]);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const savings    = await db.all('SELECT * FROM savings WHERE member_id=$1 ORDER BY month ASC', [req.params.id]);
    const loans      = await db.all('SELECT * FROM loans WHERE member_id=$1 ORDER BY request_date DESC', [req.params.id]);
    const totalSaved = savings.filter(s=>['paid','late'].includes(s.status)).reduce((a,s)=>a+Number(s.amount),0);
    const totalPenalty = savings.reduce((a,s)=>a+Number(s.penalty||0),0);
    const activeLoan = loans.find(l=>l.status==='active');
    const repayments = activeLoan ? await db.all('SELECT * FROM repayments WHERE loan_id=$1 ORDER BY month ASC', [activeLoan.id]) : [];
    const totalRepaid = repayments.filter(r=>r.status==='paid').reduce((a,r)=>a+Number(r.amount),0);
    res.json({ member, savings, loans, totalSaved, totalPenalty, totalRepaid, eligibility: totalSaved * 3 });
  } catch(e) { next(e); }
});

// POST /api/members/:id/exit
router.post('/:id/exit', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { reason, exit_date, notes } = req.body;
    if (!reason || !exit_date) return res.status(400).json({ error: 'reason and exit_date required' });
    const member = await db.one('SELECT * FROM members WHERE id=$1', [req.params.id]);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.status === 'exited') return res.status(409).json({ error: 'Member already exited' });
    const activeLoan = await db.one("SELECT id FROM loans WHERE member_id=$1 AND status='active'", [req.params.id]);
    if (activeLoan) return res.status(409).json({ error: 'Member has an active loan. Settle the loan before processing exit.' });
    const savRow = await db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE member_id=$1 AND status IN ('paid','late')", [req.params.id]);
    const totalSavings = Number(savRow.t);
    const shareRefund  = Number(member.share_amount) || 1000;
    await db.run("UPDATE members SET status='exited',exit_reason=$1,exit_date=$2,exit_notes=$3 WHERE id=$4",
      [reason, exit_date, notes || null, req.params.id]);
    await auditLog('admin', 'MEMBER_EXIT', req.params.id, `Reason: ${reason}, Date: ${exit_date}`);
    res.json({ message: 'Member exit processed', member_id: req.params.id, name: member.name,
      reason, exit_date, total_savings: totalSavings, share_refund: shareRefund, total_refund: totalSavings + shareRefund });
  } catch(e) { next(e); }
});

// GET /api/members/exits/list
router.get('/exits/list', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const exits = await db.all("SELECT * FROM members WHERE status='exited' ORDER BY exit_date DESC");
    const result = await Promise.all(exits.map(async m => {
      const savRow = await db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE member_id=$1 AND status IN ('paid','late')", [m.id]);
      const loanRow = await db.one("SELECT COUNT(*) as c FROM loans WHERE member_id=$1 AND status='active'", [m.id]);
      return { ...m, total_savings: Number(savRow.t), active_loans: Number(loanRow.c) };
    }));
    res.json(result);
  } catch(e) { next(e); }
});

module.exports = router;
