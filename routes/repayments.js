const express = require('express');
const db      = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();
const PAYMENT_DUE_DAY   = 10;
const LATE_PENALTY_RATE = 0.02;

function validMonth(m) { return /^\d{4}-\d{2}$/.test(m); }

async function getGracePeriod() {
  try { const r = await db.one("SELECT value FROM settings WHERE key='grace_period_days'"); return parseInt(r?.value||'0'); } catch { return 0; }
}
async function getRepayDueDay() {
  try { const r = await db.one("SELECT value FROM settings WHERE key='repayment_due_day'"); return parseInt(r?.value||String(PAYMENT_DUE_DAY)); } catch { return PAYMENT_DUE_DAY; }
}
async function getPenaltyRate() {
  try { const r = await db.one("SELECT value FROM settings WHERE key='late_penalty_rate'"); return parseFloat(r?.value||String(LATE_PENALTY_RATE)); } catch { return LATE_PENALTY_RATE; }
}

async function calcPenalty(amount, paid_date, month) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  // No penalty for future/advance payments
  if (month && month > currentMonth) return 0;
  // For past months (overdue), penalty always applies
  if (month && month < currentMonth) {
    const rate = await getPenaltyRate();
    return parseFloat((amount * rate).toFixed(2));
  }
  // For current month, check if paid after due day + grace
  const dueDay = await getRepayDueDay();
  const grace  = await getGracePeriod();
  const rate   = await getPenaltyRate();
  return new Date(paid_date).getDate() > (dueDay + grace)
    ? parseFloat((amount * rate).toFixed(2)) : 0;
}
async function autoMarkOverdue(loan_id) {
  const today = new Date();
  if (today.getDate() <= PAYMENT_DUE_DAY) return;
  const cm = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
  await db.run("UPDATE repayments SET status='overdue' WHERE loan_id=$1 AND status IN ('due','pending') AND month<$2", [loan_id, cm]);
}
async function advanceQueue(loan_id) {
  const next = await db.one("SELECT * FROM repayments WHERE loan_id=$1 AND status='pending' ORDER BY month ASC LIMIT 1", [loan_id]);
  if (next) await db.run("UPDATE repayments SET status='due' WHERE id=$1", [next.id]);
}
async function checkCompletion(loan_id, penalty, res) {
  const row = await db.one("SELECT COUNT(*) as c FROM repayments WHERE loan_id=$1 AND status NOT IN ('paid','refinanced')", [loan_id]);
  if (Number(row.c) === 0) {
    await db.run("UPDATE loans SET status='completed' WHERE id=$1", [loan_id]);
    return res.json({ message: 'Loan fully repaid! 🎉', completed: true, penalty_applied: penalty });
  }
  return res.json({ message: 'Repayment recorded', completed: false, penalty_applied: penalty });
}

// GET /api/repayments
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'member') {
      return res.json(await db.all(
        `SELECT r.*,l.amount as loan_amount,l.id as loan_id FROM repayments r JOIN loans l ON r.loan_id=l.id WHERE l.member_id=$1 ORDER BY r.month ASC`,
        [req.user.id]
      ));
    }
    const month = req.query.month || new Date().toISOString().slice(0,7);
    if (!validMonth(month)) return res.status(400).json({ error: 'Invalid month format' });
    res.json(await db.all(
      `SELECT r.*,l.member_id,l.id as loan_id,m.name as member_name FROM repayments r JOIN loans l ON r.loan_id=l.id JOIN members m ON l.member_id=m.id WHERE l.status='active' AND r.month=$1 ORDER BY m.name ASC`,
      [month]
    ));
  } catch(e) { next(e); }
});

// GET /api/repayments/overdue
router.get('/overdue', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const cm = new Date().toISOString().slice(0,7);
    const rows = await db.all(
      `SELECT r.*,l.member_id,l.id as loan_id,m.name as member_name,m.phone as member_phone FROM repayments r JOIN loans l ON r.loan_id=l.id JOIN members m ON l.member_id=m.id WHERE l.status='active' AND r.status NOT IN ('paid','pending_review') AND r.month<$1 ORDER BY r.month ASC,m.name ASC`,
      [cm]
    );
    res.json({ overdue: rows, count: rows.length, total_overdue: rows.reduce((a,r)=>a+Number(r.amount),0) });
  } catch(e) { next(e); }
});

// GET /api/repayments/summary
router.get('/summary', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const [d, r, o, oc, pr, p] = await Promise.all([
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM loans WHERE status IN ('active','completed')"),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM repayments WHERE status='paid'"),
      db.one("SELECT COALESCE(SUM(amount),0) as t FROM repayments WHERE status='overdue'"),
      db.one("SELECT COUNT(*) as c FROM repayments WHERE status='overdue'"),
      db.one("SELECT COUNT(*) as c FROM repayments WHERE status='pending_review'"),
      db.one("SELECT COALESCE(SUM(penalty),0) as t FROM repayments"),
    ]);
    res.json({ totalDisbursed: Number(d.t), totalRepaid: Number(r.t), totalOverdue: Number(o.t),
      overdueCount: Number(oc.c), pendingReview: Number(pr.c), totalPenalties: Number(p.t),
      outstanding: Number(d.t) - Number(r.t) });
  } catch(e) { next(e); }
});

// GET /api/repayments/export/csv
router.get('/export/csv', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT r.*,l.member_id,l.id as loan_id,m.name as member_name FROM repayments r JOIN loans l ON r.loan_id=l.id JOIN members m ON l.member_id=m.id ORDER BY r.month DESC, m.name ASC`
    );
    const header = 'ID,Loan ID,Member ID,Member Name,Month,Amount,Status,Paid Date,Penalty\n';
    const csv = rows.map(r =>
      `${r.id},${r.loan_id},${r.member_id},"${r.member_name}",${r.month},${r.amount},${r.status},${r.paid_date||''},${r.penalty||0}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="repayments.csv"');
    res.send(header + csv);
  } catch(e) { next(e); }
});

// GET /api/repayments/schedule/:loan_id
router.get('/schedule/:loan_id', authMiddleware, async (req, res, next) => {
  try {
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [req.params.loan_id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (req.user.role==='member' && loan.member_id!==req.user.id) return res.status(403).json({ error: 'Access denied' });
    await autoMarkOverdue(req.params.loan_id);
    const reps = await db.all('SELECT * FROM repayments WHERE loan_id=$1 ORDER BY month ASC', [req.params.loan_id]);
    const cm   = new Date().toISOString().slice(0,7);
    const enriched = reps.map(r => ({
      ...r,
      due_date:        `${r.month}-${String(PAYMENT_DUE_DAY).padStart(2,'0')}`,
      is_overdue:      r.status==='overdue' || (r.status!=='paid' && r.month<cm),
      can_pay:         !['paid','pending_review'].includes(r.status),
      penalty_if_late: parseFloat((Number(r.amount)*LATE_PENALTY_RATE).toFixed(2)),
    }));
    const totalPaid    = reps.filter(r=>r.status==='paid').reduce((a,r)=>a+Number(r.amount),0);
    const totalPenalty = reps.reduce((a,r)=>a+Number(r.penalty||0),0);
    const remaining    = reps.filter(r=>r.status!=='paid').reduce((a,r)=>a+Number(r.amount),0);
    res.json({ loan, repayments: enriched, summary: { totalPaid, totalPenalty, remaining,
      progress: reps.length ? Math.round(reps.filter(r=>r.status==='paid').length/reps.length*100) : 0 } });
  } catch(e) { next(e); }
});

// POST /api/repayments/record
router.post('/record', authMiddleware, async (req, res, next) => {
  try {
    const { loan_id, month, paid_date, penalty: manualPenalty, bank_name, account_number } = req.body;
    if (!loan_id || !month || !paid_date) return res.status(400).json({ error: 'loan_id, month, and paid_date required' });
    if (!validMonth(month)) return res.status(400).json({ error: 'Invalid month format' });
    // Validate bank info for member submissions
    if (req.user.role === 'member') {
      if (!bank_name?.trim()) return res.status(400).json({ error: 'Bank name is required' });
      if (!account_number?.trim()) return res.status(400).json({ error: 'Account number is required' });
    }
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [loan_id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status !== 'active') return res.status(400).json({ error: 'Loan is not active' });
    if (req.user.role==='member' && loan.member_id!==req.user.id) return res.status(403).json({ error: 'Access denied' });
    const rep = await db.one('SELECT * FROM repayments WHERE loan_id=$1 AND month=$2', [loan_id, month]);
    if (!rep) return res.status(404).json({ error: 'No repayment scheduled for that month' });
    if (rep.status === 'paid') return res.status(409).json({ error: 'Already paid' });
    if (rep.status === 'pending_review') return res.status(409).json({ error: 'Already submitted for review' });
    const autoPenalty   = await calcPenalty(Number(rep.amount), paid_date, month);
    const isFutureMonth = month > new Date().toISOString().slice(0, 7);
    // Enforce minimum: amount + penalty for overdue/late months
    if (req.user.role === 'member' && req.body.paid_amount !== undefined) {
      const paidAmt = Number(req.body.paid_amount);
      const minRequired = Number(rep.amount) + autoPenalty;
      if (paidAmt < minRequired) {
        return res.status(400).json({
          error: `Minimum payment is ETB ${minRequired.toFixed(2)} (ETB ${rep.amount} installment${autoPenalty > 0 ? ` + ETB ${autoPenalty} penalty` : ''})`,
          min_required: minRequired, penalty: autoPenalty
        });
      }
    }
    if (req.user.role === 'member') {
      await db.run("UPDATE repayments SET status='pending_review',paid_date=$1,penalty=$2,bank_name=$3,account_number=$4 WHERE loan_id=$5 AND month=$6",
        [paid_date, autoPenalty, bank_name?.trim()||null, account_number?.trim()||null, loan_id, month]);
      return res.json({ message: isFutureMonth ? 'Advance payment submitted for review' : 'Repayment submitted for review',
        completed: false, penalty_applied: autoPenalty, is_advance: isFutureMonth });
    }
    const finalPenalty = manualPenalty !== undefined ? Number(manualPenalty) : autoPenalty;
    await db.run("UPDATE repayments SET status='paid',paid_date=$1,penalty=$2,bank_name=$3,account_number=$4 WHERE loan_id=$5 AND month=$6",
      [paid_date, finalPenalty, bank_name?.trim()||null, account_number?.trim()||null, loan_id, month]);
    await advanceQueue(loan_id);
    return checkCompletion(loan_id, finalPenalty, res);
  } catch(e) { next(e); }
});

// POST /api/repayments/settle
router.post('/settle', authMiddleware, async (req, res, next) => {
  try {
    const { loan_id, paid_date, penalty } = req.body;
    if (!loan_id || !paid_date) return res.status(400).json({ error: 'loan_id and paid_date required' });
    const loan = await db.one('SELECT * FROM loans WHERE id=$1', [loan_id]);
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status !== 'active') return res.status(400).json({ error: 'Loan is not active' });
    if (req.user.role==='member' && loan.member_id!==req.user.id) return res.status(403).json({ error: 'Access denied' });
    const unpaid = await db.all("SELECT * FROM repayments WHERE loan_id=$1 AND status NOT IN ('paid') ORDER BY month ASC", [loan_id]);
    if (!unpaid.length) return res.status(409).json({ error: 'No unpaid repayments' });
    const totalAmount = unpaid.reduce((a,r)=>a+Number(r.amount),0);
    if (req.user.role === 'member') {
      for (const r of unpaid) await db.run("UPDATE repayments SET status='pending_review',paid_date=$1 WHERE id=$2", [paid_date, r.id]);
      return res.json({ message: 'Early settlement submitted for review', months_settled: unpaid.length, total_amount: totalAmount });
    }
    const settlePenalty = Number(penalty)||0;
    for (const r of unpaid) await db.run("UPDATE repayments SET status='paid',paid_date=$1,penalty=$2 WHERE id=$3", [paid_date, settlePenalty/unpaid.length, r.id]);
    await db.run("UPDATE loans SET status='completed' WHERE id=$1", [loan_id]);
    res.json({ message: 'Loan fully settled!', completed: true, months_settled: unpaid.length, total_amount: totalAmount });
  } catch(e) { next(e); }
});

// GET /api/repayments/:id — full detail for admin review
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const row = await db.one(
      `SELECT r.*,l.member_id,l.amount as loan_amount,l.id as loan_id,m.name as member_name,m.phone as member_phone
       FROM repayments r JOIN loans l ON r.loan_id=l.id JOIN members m ON l.member_id=m.id WHERE r.id=$1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Repayment not found' });
    if (req.user.role === 'member' && row.member_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json(row);
  } catch(e) { next(e); }
});

// PATCH /api/repayments/:id/confirm
router.patch('/:id/confirm', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const rep = await db.one('SELECT r.*,l.member_id,l.id as loan_id FROM repayments r JOIN loans l ON r.loan_id=l.id WHERE r.id=$1', [req.params.id]);
    if (!rep) return res.status(404).json({ error: 'Repayment not found' });
    if (rep.status !== 'pending_review') return res.status(400).json({ error: 'Not in pending_review status' });
    const finalPenalty = req.body.penalty !== undefined ? Number(req.body.penalty) : Number(rep.penalty);
    await db.run("UPDATE repayments SET status='paid',penalty=$1 WHERE id=$2", [finalPenalty, rep.id]);
    await advanceQueue(rep.loan_id);
    return checkCompletion(rep.loan_id, finalPenalty, res);
  } catch(e) { next(e); }
});

// POST /api/repayments/bulk-confirm — bulk approve multiple repayments
router.post('/bulk-confirm', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    if (ids.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });
    }
    
    const results = [];
    const processedLoans = new Set();
    
    for (const id of ids) {
      try {
        const rep = await db.one('SELECT r.*,l.id as loan_id FROM repayments r JOIN loans l ON r.loan_id=l.id WHERE r.id=$1', [id]);
        if (!rep) {
          results.push({ id, status: 'not_found' });
          continue;
        }
        if (rep.status !== 'pending_review') {
          results.push({ id, status: 'already_processed', current_status: rep.status });
          continue;
        }
        
        await db.run("UPDATE repayments SET status='paid' WHERE id=$1", [id]);
        processedLoans.add(rep.loan_id);
        results.push({ id, status: 'confirmed', loan_id: rep.loan_id });
      } catch (err) {
        results.push({ id, status: 'error', error: err.message });
      }
    }
    
    // Advance queue and check completion for all affected loans
    for (const loanId of processedLoans) {
      try {
        await advanceQueue(loanId);
        // Check if loan is now complete
        const unpaid = await db.all("SELECT id FROM repayments WHERE loan_id=$1 AND status NOT IN ('paid','refinanced')", [loanId]);
        if (unpaid.length === 0) {
          await db.run("UPDATE loans SET status='completed' WHERE id=$1", [loanId]);
        }
      } catch (err) {
        console.error(`Error processing loan ${loanId}:`, err.message);
      }
    }
    
    const confirmed = results.filter(r => r.status === 'confirmed').length;
    res.json({ 
      message: `Confirmed ${confirmed} of ${ids.length} repayment(s)`, 
      confirmed,
      total: ids.length,
      loans_affected: processedLoans.size,
      results 
    });
  } catch(e) { next(e); }
});

// PATCH /api/repayments/:id/waive-penalty
router.patch('/:id/waive-penalty', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const row = await db.one('SELECT * FROM repayments WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Repayment not found' });
    await db.run('UPDATE repayments SET penalty=0 WHERE id=$1', [req.params.id]);
    res.json({ message: 'Penalty waived successfully' });
  } catch(e) { next(e); }
});

module.exports = router;
