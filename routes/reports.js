const express = require('express');
const db      = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/reports/financial-summary ────────────────────────────────────────
// Comprehensive financial overview for a given period
router.get('/financial-summary', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { start_month, end_month } = req.query;
    const startMonth = start_month || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 7); // Jan of current year
    const endMonth   = end_month || new Date().toISOString().slice(0, 7); // Current month

    // Total savings collected
    const savingsData = await db.one(`
      SELECT 
        COALESCE(SUM(amount), 0) as total_collected,
        COALESCE(SUM(penalty), 0) as total_penalties,
        COUNT(*) as payment_count,
        COUNT(DISTINCT member_id) as unique_payers
      FROM savings
      WHERE month >= $1 AND month <= $2
      AND status IN ('paid', 'late')
    `, [startMonth, endMonth]);

    // Loan disbursements
    const loanData = await db.one(`
      SELECT 
        COALESCE(SUM(amount), 0) as total_disbursed,
        COUNT(*) as loan_count
      FROM loans
      WHERE status IN ('active', 'completed')
      AND approve_date >= $1 || '-01' AND approve_date <= $2 || '-31'
    `, [startMonth, endMonth]);

    // Loan repayments collected
    const repaymentData = await db.one(`
      SELECT 
        COALESCE(SUM(amount), 0) as total_collected,
        COALESCE(SUM(penalty), 0) as total_penalties,
        COUNT(*) as payment_count
      FROM repayments
      WHERE month >= $1 AND month <= $2
      AND status = 'paid'
    `, [startMonth, endMonth]);

    // Active loans outstanding
    const outstandingLoans = await db.one(`
      SELECT 
        COALESCE(SUM(l.amount), 0) as total_principal,
        COUNT(*) as active_loan_count,
        COALESCE(SUM(r.amount), 0) as total_outstanding
      FROM loans l
      LEFT JOIN repayments r ON l.id = r.loan_id AND r.status IN ('due', 'overdue', 'pending')
      WHERE l.status = 'active'
    `);

    // Member statistics
    const memberStats = await db.one(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') as active_members,
        COUNT(*) FILTER (WHERE status = 'inactive') as inactive_members,
        COUNT(*) FILTER (WHERE status = 'exited') as exited_members,
        COALESCE(SUM(share_amount), 0) as total_share_capital,
        COALESCE(SUM(registration_fee), 0) as total_reg_fees
      FROM members
    `);

    // Calculate net position
    const totalInflows = 
      parseFloat(savingsData.total_collected) + 
      parseFloat(savingsData.total_penalties) +
      parseFloat(repaymentData.total_collected) +
      parseFloat(repaymentData.total_penalties) +
      parseFloat(memberStats.total_share_capital) +
      parseFloat(memberStats.total_reg_fees);

    const totalOutflows = parseFloat(loanData.total_disbursed);
    const netPosition = totalInflows - totalOutflows;

    res.json({
      period: { start: startMonth, end: endMonth },
      savings: {
        total_collected: parseFloat(savingsData.total_collected),
        total_penalties: parseFloat(savingsData.total_penalties),
        payment_count: savingsData.payment_count,
        unique_payers: savingsData.unique_payers,
      },
      loans: {
        total_disbursed: parseFloat(loanData.total_disbursed),
        loan_count: loanData.loan_count,
        active_loans: outstandingLoans.active_loan_count,
        total_outstanding: parseFloat(outstandingLoans.total_outstanding),
      },
      repayments: {
        total_collected: parseFloat(repaymentData.total_collected),
        total_penalties: parseFloat(repaymentData.total_penalties),
        payment_count: repaymentData.payment_count,
      },
      members: {
        active: memberStats.active_members,
        inactive: memberStats.inactive_members,
        exited: memberStats.exited_members,
        total_share_capital: parseFloat(memberStats.total_share_capital),
        total_reg_fees: parseFloat(memberStats.total_reg_fees),
      },
      financial_position: {
        total_inflows: totalInflows,
        total_outflows: totalOutflows,
        net_position: netPosition,
      },
    });
  } catch(e) { next(e); }
});

// ── GET /api/reports/loan-portfolio ───────────────────────────────────────────
// Loan portfolio analysis with risk metrics
router.get('/loan-portfolio', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    // Portfolio overview
    const portfolio = await db.one(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0) as active_principal,
        COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) as completed_principal
      FROM loans
    `);

    // Repayment performance
    const repaymentPerf = await db.one(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'paid') as paid_count,
        COUNT(*) FILTER (WHERE status = 'overdue') as overdue_count,
        COUNT(*) FILTER (WHERE status = 'due') as due_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) as paid_amount,
        COALESCE(SUM(amount) FILTER (WHERE status = 'overdue'), 0) as overdue_amount,
        COALESCE(SUM(penalty), 0) as total_penalties
      FROM repayments
    `);

    // Calculate portfolio at risk (PAR) - loans with overdue payments
    const parLoans = await db.all(`
      SELECT DISTINCT l.id, l.amount, l.member_id
      FROM loans l
      JOIN repayments r ON l.id = r.loan_id
      WHERE l.status = 'active' AND r.status = 'overdue'
    `);
    const parAmount = parLoans.reduce((sum, loan) => sum + parseFloat(loan.amount), 0);
    const parRatio = portfolio.active_principal > 0 
      ? (parAmount / parseFloat(portfolio.active_principal) * 100).toFixed(2)
      : 0;

    // Collection rate
    const totalDue = parseFloat(repaymentPerf.paid_amount) + parseFloat(repaymentPerf.overdue_amount);
    const collectionRate = totalDue > 0 
      ? (parseFloat(repaymentPerf.paid_amount) / totalDue * 100).toFixed(2)
      : 100;

    // Average loan size
    const avgLoanSize = portfolio.active_count > 0
      ? (parseFloat(portfolio.active_principal) / portfolio.active_count).toFixed(2)
      : 0;

    res.json({
      portfolio_overview: {
        pending: portfolio.pending_count,
        active: portfolio.active_count,
        completed: portfolio.completed_count,
        rejected: portfolio.rejected_count,
        active_principal: parseFloat(portfolio.active_principal),
        completed_principal: parseFloat(portfolio.completed_principal),
        average_loan_size: parseFloat(avgLoanSize),
      },
      repayment_performance: {
        paid_count: repaymentPerf.paid_count,
        overdue_count: repaymentPerf.overdue_count,
        due_count: repaymentPerf.due_count,
        paid_amount: parseFloat(repaymentPerf.paid_amount),
        overdue_amount: parseFloat(repaymentPerf.overdue_amount),
        total_penalties: parseFloat(repaymentPerf.total_penalties),
        collection_rate: parseFloat(collectionRate),
      },
      risk_metrics: {
        portfolio_at_risk_amount: parAmount,
        portfolio_at_risk_ratio: parseFloat(parRatio),
        loans_at_risk_count: parLoans.length,
        risk_level: parRatio > 10 ? 'high' : parRatio > 5 ? 'medium' : 'low',
      },
    });
  } catch(e) { next(e); }
});

// ── GET /api/reports/member-analytics ─────────────────────────────────────────
// Member growth and engagement analytics
router.get('/member-analytics', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { months = 12 } = req.query;
    
    // Member growth trend (last N months)
    const growthTrend = await db.all(`
      SELECT 
        to_char(date_trunc('month', join_date::date), 'YYYY-MM') as month,
        COUNT(*) as new_members
      FROM members
      WHERE join_date >= date_trunc('month', CURRENT_DATE) - interval '${parseInt(months)} months'
      GROUP BY month
      ORDER BY month ASC
    `);

    // Account type distribution
    const accountTypes = await db.all(`
      SELECT 
        account_type,
        COUNT(*) as count,
        COALESCE(SUM(monthly_saving), 0) as total_monthly_commitment
      FROM members
      WHERE status = 'active'
      GROUP BY account_type
    `);

    // Savings participation rate (members who paid this month)
    const currentMonth = new Date().toISOString().slice(0, 7);
    const participation = await db.one(`
      SELECT 
        COUNT(DISTINCT m.id) as total_active,
        COUNT(DISTINCT s.member_id) as paid_this_month
      FROM members m
      LEFT JOIN savings s ON m.id = s.member_id AND s.month = $1 AND s.status IN ('paid', 'late')
      WHERE m.status = 'active'
    `, [currentMonth]);

    const participationRate = participation.total_active > 0
      ? (participation.paid_this_month / participation.total_active * 100).toFixed(2)
      : 0;

    // Member retention (active vs exited)
    const retention = await db.one(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'exited') as exited,
        COUNT(*) as total
      FROM members
    `);

    const retentionRate = retention.total > 0
      ? ((retention.active / retention.total) * 100).toFixed(2)
      : 100;

    // Top savers (highest total savings)
    const topSavers = await db.all(`
      SELECT 
        m.id,
        m.name,
        COALESCE(SUM(s.amount), 0) as total_saved,
        COUNT(s.id) as payment_count
      FROM members m
      LEFT JOIN savings s ON m.id = s.member_id AND s.status IN ('paid', 'late')
      WHERE m.status = 'active'
      GROUP BY m.id, m.name
      ORDER BY total_saved DESC
      LIMIT 10
    `);

    res.json({
      growth_trend: growthTrend.map(g => ({
        month: g.month,
        new_members: g.new_members,
      })),
      account_distribution: accountTypes.map(a => ({
        type: a.account_type,
        count: a.count,
        total_monthly_commitment: parseFloat(a.total_monthly_commitment),
      })),
      engagement: {
        total_active_members: participation.total_active,
        paid_this_month: participation.paid_this_month,
        participation_rate: parseFloat(participationRate),
      },
      retention: {
        active_members: retention.active,
        exited_members: retention.exited,
        retention_rate: parseFloat(retentionRate),
      },
      top_savers: topSavers.map(s => ({
        id: s.id,
        name: s.name,
        total_saved: parseFloat(s.total_saved),
        payment_count: s.payment_count,
      })),
    });
  } catch(e) { next(e); }
});

// ── GET /api/reports/cash-flow ────────────────────────────────────────────────
// Monthly cash flow analysis
router.get('/cash-flow', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { months = 6 } = req.query;
    
    // Generate list of months
    const monthList = [];
    const now = new Date();
    for (let i = parseInt(months) - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthList.push(d.toISOString().slice(0, 7));
    }

    const cashFlow = [];
    
    for (const month of monthList) {
      // Inflows
      const savings = await db.one(`
        SELECT COALESCE(SUM(amount + COALESCE(penalty, 0)), 0) as total
        FROM savings
        WHERE month = $1 AND status IN ('paid', 'late')
      `, [month]);

      const repayments = await db.one(`
        SELECT COALESCE(SUM(amount + COALESCE(penalty, 0)), 0) as total
        FROM repayments
        WHERE month = $1 AND status = 'paid'
      `, [month]);

      const newMembers = await db.one(`
        SELECT 
          COALESCE(SUM(share_amount + registration_fee), 0) as total,
          COUNT(*) as count
        FROM members
        WHERE to_char(join_date::date, 'YYYY-MM') = $1
      `, [month]);

      // Outflows (loan disbursements)
      const disbursements = await db.one(`
        SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
        FROM loans
        WHERE to_char(approve_date::date, 'YYYY-MM') = $1
        AND status IN ('active', 'completed')
      `, [month]);

      const totalInflow = 
        parseFloat(savings.total) + 
        parseFloat(repayments.total) + 
        parseFloat(newMembers.total);
      
      const totalOutflow = parseFloat(disbursements.total);
      const netCashFlow = totalInflow - totalOutflow;

      cashFlow.push({
        month,
        inflows: {
          savings: parseFloat(savings.total),
          repayments: parseFloat(repayments.total),
          new_members: parseFloat(newMembers.total),
          total: totalInflow,
        },
        outflows: {
          loan_disbursements: totalOutflow,
          disbursement_count: disbursements.count,
          total: totalOutflow,
        },
        net_cash_flow: netCashFlow,
      });
    }

    // Calculate cumulative cash flow
    let cumulative = 0;
    cashFlow.forEach(cf => {
      cumulative += cf.net_cash_flow;
      cf.cumulative_cash_flow = cumulative;
    });

    res.json({
      period_months: parseInt(months),
      cash_flow_data: cashFlow,
      summary: {
        total_inflows: cashFlow.reduce((sum, cf) => sum + cf.inflows.total, 0),
        total_outflows: cashFlow.reduce((sum, cf) => sum + cf.outflows.total, 0),
        net_position: cashFlow.reduce((sum, cf) => sum + cf.net_cash_flow, 0),
      },
    });
  } catch(e) { next(e); }
});

// ── GET /api/reports/comparative ──────────────────────────────────────────────
// Month-over-month and year-over-year comparisons
router.get('/comparative', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const lastMonth = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
    const lastYearMonth = new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString().slice(0, 7);

    async function getMonthMetrics(month) {
      const savings = await db.one(`
        SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
        FROM savings WHERE month = $1 AND status IN ('paid', 'late')
      `, [month]);

      const repayments = await db.one(`
        SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
        FROM repayments WHERE month = $1 AND status = 'paid'
      `, [month]);

      const loans = await db.one(`
        SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
        FROM loans WHERE to_char(approve_date::date, 'YYYY-MM') = $1
      `, [month]);

      return {
        savings_collected: parseFloat(savings.total),
        savings_count: savings.count,
        repayments_collected: parseFloat(repayments.total),
        repayments_count: repayments.count,
        loans_disbursed: parseFloat(loans.total),
        loans_count: loans.count,
      };
    }

    const current = await getMonthMetrics(currentMonth);
    const previous = await getMonthMetrics(lastMonth);
    const yearAgo = await getMonthMetrics(lastYearMonth);

    function calculateChange(current, previous) {
      if (previous === 0) return current > 0 ? 100 : 0;
      return ((current - previous) / previous * 100).toFixed(2);
    }

    res.json({
      current_month: {
        month: currentMonth,
        metrics: current,
      },
      month_over_month: {
        previous_month: lastMonth,
        previous_metrics: previous,
        changes: {
          savings_collected: parseFloat(calculateChange(current.savings_collected, previous.savings_collected)),
          savings_count: parseFloat(calculateChange(current.savings_count, previous.savings_count)),
          repayments_collected: parseFloat(calculateChange(current.repayments_collected, previous.repayments_collected)),
          loans_disbursed: parseFloat(calculateChange(current.loans_disbursed, previous.loans_disbursed)),
        },
      },
      year_over_year: {
        year_ago_month: lastYearMonth,
        year_ago_metrics: yearAgo,
        changes: {
          savings_collected: parseFloat(calculateChange(current.savings_collected, yearAgo.savings_collected)),
          savings_count: parseFloat(calculateChange(current.savings_count, yearAgo.savings_count)),
          repayments_collected: parseFloat(calculateChange(current.repayments_collected, yearAgo.repayments_collected)),
          loans_disbursed: parseFloat(calculateChange(current.loans_disbursed, yearAgo.loans_disbursed)),
        },
      },
    });
  } catch(e) { next(e); }
});

module.exports = router;
