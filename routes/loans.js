const express = require('express');
const db      = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { isValidAmount, isValidDate } = require('../middleware/validate');

const router = express.Router();
const INTEREST_RATE    = 0.05;
const REPAYMENT_MONTHS = 12;
const PAYMENT_DUE_DAY  = 10;
const LOAN_MULTIPLIER  = 3;

const crypto = require('crypto');
function genId(p) { return p + '-' + crypto.randomBytes(5).toString('hex').toUpperCase(); }
function monthOffset(base, n) {
  const [y, m] = base.split('-').map(Number);
  const d = new Date(y, m-1+n, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
async function totalSaved(memberId) {
  const r = await db.one("SELECT COALESCE(SUM(amount),0) as t FROM savings WHERE member_id=$1 AND status IN ('paid','late')", [memberId]);
  return Number(r.t);
}
async function withRepayments(loans) {
  return Promise.all(loans.map(async l => ({
    ...l,
    repayments: await db.all('SELECT * FROM repayments WHERE loan_id=$1 ORDER BY month ASC', [l.id])
  })));
}
async function auditLog(actor, action, target, detail) {
  try { await db.run('INSERT INTO audit_log (actor,action,target,detail) VALUES ($1,$2,$3,$4)', [actor, action, target||null, detail||null]); } catch {}
}

// GET /api/loans
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'member') {
      const loans = await db.all('SELECT * FROM loans WHERE member_id=$1 ORDER BY request_date DESC', [req.user.id]);
      return res.json(await withRepayments(loans));
    }
    const { status } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(500, parseInt(req.query.limit) || 200);
    const offset = (page - 1) * limit;
    let sql = 'SELECT l.*,m.name as member_name,m.phone as member_phone FROM loans l JOIN members m ON l.member_id=m.id';
    const p = [];
    if (status) { sql += ' WHERE l.status=$1'; p.push(status); }
    sql += ` ORDER BY l.request_date DESC LIMIT $${p.length+1} OFFSET $${p.length+2}`;
    p.push(limit, offset);
    const rows = await withRepayments(await db.all(sql, p));
    if (!req.query.page && !req.query.limit) return res.json(rows);
    const countSql = status
      ? 'SELECT COUNT(*) as c FROM loans WHERE status=$1'
      : 'SELECT COUNT(*) as c FROM loans';
    const total = await db.one(countSql, status ? [status] : []);
    res.json({ data: rows, total: Number(total.c), page, limit, pages: Math.ceil(Number(total.c)/limit) });
  } catch(e) { next(e); }
});

// GET /api/loans/queue
router.get('/queue', authMiddleware, async (req, res, next) => {
  try {
    const queue = await db.all(
      "SELECT l.*,m.name as member_name,m.phone as member_phone,m.monthly_saving FROM loans l JOIN members m ON l.member_id=m.id WHERE l.status='pending' ORDER BY l.queue_position ASC,l.request_date ASC"
    );
    const result = await Promise.all(queue.map(async l => ({
      ...l, total_saved: await totalSaved(l.member_id), eligibility: (await totalSaved(l.member_id)) * LOAN_MULTIPLIER
    })));
    res.json(result);
  } catch(e) { next(e); }
});

// GET /api/loans/export/csv
router.get('/export/csv', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const loans = await db.all(`SELECT l.*,m.name as member_name,m.phone as member_phone FROM loans l JOIN members m ON l.member_id=m.id ORDER BY l.request_date DESC`);
    const header = 'ID,Member ID,Member Name,Amount,Request Date,Approve Date,Status,3rd Party Ref,Disbursement Date,Guarantor\n';
    const csv = loans.map(l =>
      `${l.id},${l.member_id},"${l.member_name}",${l.amount},${l.request_date},${l.approve_date||''},${l.status},"${l.third_party_ref||''}",${l.disbursement_date||''},"${l.guarantor_name||''}"`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="loans.csv"');
    res.send(header + csv);
  } catch(e) { next(e); }
});

// GET /api/loans/:id/eligibility
router.get('/:id/eligibility', authMiddleware, async (req, res, next) => {
  try {
    const member = await db.one('SELECT * FROM members WHERE id=$1', [req.params.id]);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const saved = await totalSaved(req.params.id);
    const monthsRow = await db.one("SELECT COUNT(*) as c FROM savings WHERE member_id=$1 AND status IN ('paid','late')", [req.params.id]);
    const monthsPaid = Number(monthsRow.c);
    const activeLoan = await db.one("SELECT id FROM loans WHERE member_id=$1 AND status IN ('active','pending')", [req.params.id]);
    const eligibility = saved * LOAN_MULTIPLIER;
    res.json({ member_id: req.params.id, total_saved: saved, months_paid: monthsPaid, eligibility,
      max_loan: eligibility, has_active_loan: !!activeLoan, can_apply: !activeLoan && monthsPaid >= 1,
      reason: activeLoan ? 'Already has active/pending loan' : monthsPaid < 1 ? 'Minimum 1 month savings required' : 'Eligible' });
  } catch(e) { next(e); }
});

// GET /api/loans/:id
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [req.params.id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (req.user.role==='member' && loan.member_id!==req.user.id) return res.status(403).json({ error: 'Access denied' });
    loan.repayments = await db.all('SELECT * FROM repayments WHERE loan_id=$1 ORDER BY month ASC', [loan.id]);
    res.json(loan);
  } catch(e) { next(e); }
});

// POST /api/loans
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const memberId = req.user.role==='member' ? req.user.id : req.body.member_id;
    if (!memberId) return res.status(400).json({ error: 'member_id required' });
    const { amount, admin_note } = req.body;
    if (!amount || !isValidAmount(amount)) return res.status(400).json({ error: 'Invalid loan amount' });
    const member = await db.one("SELECT * FROM members WHERE id=$1 AND status='active'", [memberId]);
    if (!member) return res.status(404).json({ error: 'Active member not found' });
    const existing = await db.one("SELECT id FROM loans WHERE member_id=$1 AND status IN ('active','pending')", [memberId]);
    if (existing) return res.status(409).json({ error: 'Member already has an active or pending loan' });
    const saved = await totalSaved(memberId);
    if (req.user.role==='member') {
      if (saved < 500) return res.status(400).json({ error: 'Minimum 1 month of savings required' });
      if (Number(amount) > saved*LOAN_MULTIPLIER) return res.status(400).json({ error: `Amount exceeds eligibility of ETB ${(saved*LOAN_MULTIPLIER).toFixed(2)}` });
    }
    const maxRow = await db.one("SELECT COALESCE(MAX(queue_position),0) as m FROM loans WHERE status='pending'");
    const id = genId('LN');
    await db.run("INSERT INTO loans (id,member_id,amount,request_date,status,queue_position,admin_note) VALUES ($1,$2,$3,CURRENT_DATE,'pending',$4,$5)",
      [id, memberId, Number(amount), Number(maxRow.m)+1, admin_note||null]);
    await auditLog(req.user.role==='admin'?'admin':memberId, 'REQUEST_LOAN', id, 'Amount: '+amount);
    res.status(201).json({ id, queue_position: Number(maxRow.m)+1, message: 'Loan request submitted' });
  } catch(e) { next(e); }
});

// POST /api/loans/:id/approve
router.post('/:id/approve', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { third_party_ref, approve_date, repayment_months, interest_rate, guarantor_name, guarantor_phone, third_party_doc_url } = req.body;
    if (!third_party_ref || !approve_date) return res.status(400).json({ error: 'third_party_ref and approve_date required' });
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [req.params.id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status !== 'pending') return res.status(400).json({ error: 'Loan is already ' + loan.status });
    const months  = parseInt(repayment_months) || REPAYMENT_MONTHS;
    const rate    = parseFloat(interest_rate)>=0 ? parseFloat(interest_rate)/100 : INTEREST_RATE;
    const monthly = parseFloat(((Number(loan.amount)*(1+rate))/months).toFixed(2));

    await db.transaction(async (tx) => {
      await tx.run("UPDATE loans SET status='active',approve_date=$1,third_party_ref=$2,third_party_signed=1,queue_position=NULL,guarantor_name=$3,guarantor_phone=$4,third_party_doc_url=$5 WHERE id=$6",
        [approve_date, third_party_ref.trim(), guarantor_name||null, guarantor_phone||null, third_party_doc_url||null, loan.id]);
      const startMonth = monthOffset(approve_date.substring(0,7), 1);
      for (let i = 0; i < months; i++) {
        await tx.run('INSERT INTO repayments (id,loan_id,month,amount,status) VALUES ($1,$2,$3,$4,$5)',
          [genId('RP'), loan.id, monthOffset(startMonth,i), monthly, i===0?'due':'pending']);
      }
      const pending = await tx.all("SELECT id FROM loans WHERE status='pending' ORDER BY queue_position ASC,request_date ASC");
      for (let i = 0; i < pending.length; i++) {
        await tx.run('UPDATE loans SET queue_position=$1 WHERE id=$2', [i+1, pending[i].id]);
      }
    });

    await auditLog('admin','APPROVE_LOAN',loan.id,`Amount:${loan.amount},Monthly:${monthly}`);
    res.json({ message: 'Loan approved', monthly_payment: monthly, months, due_day: PAYMENT_DUE_DAY });
  } catch(e) { next(e); }
});

// POST /api/loans/:id/reject
router.post('/:id/reject', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { rejection_reason } = req.body;
    if (!rejection_reason) return res.status(400).json({ error: 'rejection_reason required' });
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [req.params.id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status !== 'pending') return res.status(400).json({ error: 'Loan is already ' + loan.status });
    await db.run("UPDATE loans SET status='rejected',rejection_reason=$1,queue_position=NULL WHERE id=$2", [rejection_reason.trim(), loan.id]);
    const pending = await db.all("SELECT id FROM loans WHERE status='pending' ORDER BY queue_position ASC,request_date ASC");
    for (let i = 0; i < pending.length; i++) await db.run('UPDATE loans SET queue_position=$1 WHERE id=$2', [i+1, pending[i].id]);
    await auditLog('admin','REJECT_LOAN',loan.id,rejection_reason.trim());
    res.json({ message: 'Loan rejected' });
  } catch(e) { next(e); }
});

// POST /api/loans/:id/disburse
router.post('/:id/disburse', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { disbursement_date } = req.body;
    if (!disbursement_date) return res.status(400).json({ error: 'disbursement_date required' });
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [req.params.id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status !== 'active') return res.status(400).json({ error: 'Loan must be active to disburse' });
    await db.run('UPDATE loans SET disbursement_date=$1 WHERE id=$2', [disbursement_date, loan.id]);
    await auditLog('admin','DISBURSE_LOAN',loan.id,'Disbursed on '+disbursement_date);
    res.json({ message: 'Disbursement recorded', disbursement_date });
  } catch(e) { next(e); }
});

// PATCH /api/loans/:id/guarantor
router.patch('/:id/guarantor', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { guarantor_name, guarantor_phone } = req.body;
    if (!guarantor_name) return res.status(400).json({ error: 'guarantor_name required' });
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [req.params.id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    await db.run('UPDATE loans SET guarantor_name=$1,guarantor_phone=$2 WHERE id=$3', [guarantor_name.trim(), guarantor_phone||null, loan.id]);
    res.json({ message: 'Guarantor updated' });
  } catch(e) { next(e); }
});

// POST /api/loans/:id/refinance  — restructure an active loan
router.post('/:id/refinance', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { new_amount, repayment_months, interest_rate, reason } = req.body;
    if (!new_amount || !repayment_months) return res.status(400).json({ error: 'new_amount and repayment_months required' });
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [req.params.id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status !== 'active') return res.status(400).json({ error: 'Only active loans can be refinanced' });

    const months  = parseInt(repayment_months);
    const rate    = parseFloat(interest_rate) >= 0 ? parseFloat(interest_rate)/100 : INTEREST_RATE;
    const monthly = parseFloat(((Number(new_amount)*(1+rate))/months).toFixed(2));
    const today   = new Date().toISOString().split('T')[0];
    const startMonth = monthOffset(today.substring(0,7), 1);

    await db.transaction(async (tx) => {
      // Mark old unpaid repayments as refinanced
      await tx.run("UPDATE repayments SET status='refinanced' WHERE loan_id=$1 AND status NOT IN ('paid')", [loan.id]);
      // Update loan amount
      await tx.run('UPDATE loans SET amount=$1,admin_note=$2 WHERE id=$3',
        [Number(new_amount), `Refinanced on ${today}. Reason: ${reason||'N/A'}`, loan.id]);
      // Generate new schedule
      for (let i = 0; i < months; i++) {
        await tx.run('INSERT INTO repayments (id,loan_id,month,amount,status) VALUES ($1,$2,$3,$4,$5)',
          [genId('RP'), loan.id, monthOffset(startMonth,i), monthly, i===0?'due':'pending']);
      }
    });

    await auditLog('admin','REFINANCE_LOAN',loan.id,`NewAmount:${new_amount},Months:${months},Reason:${reason||''}`);
    res.json({ message: 'Loan refinanced successfully', new_amount, monthly_payment: monthly, months });
  } catch(e) { next(e); }
});

module.exports = router;
