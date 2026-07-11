/**
 * Data Integrity & Financial Reconciliation System
 * Validates financial data consistency, detects discrepancies, and ensures accuracy
 */
const db = require('./db');
const security = require('./security');

// ── Validate Financial Balances ──────────────────────────────────────────────
async function validateMemberBalances() {
  console.log('🔍 Validating member financial balances...');
  
  const issues = [];

  try {
    // Get all active members
    const members = await db.all("SELECT id, name, monthly_saving FROM members WHERE status = 'active'");

    for (const member of members) {
      // Calculate total confirmed savings
      const savingsResult = await db.one(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM savings
        WHERE member_id = ? AND status IN ('paid', 'late')
      `, [member.id]);

      const totalSavings = Number(savingsResult.total || 0);

      // Calculate total loans
      const loansResult = await db.one(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM loans
        WHERE member_id = ? AND status IN ('active', 'completed')
      `, [member.id]);

      const totalLoans = Number(loansResult.total || 0);

      // Calculate total repayments
      const repaymentsResult = await db.one(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM repayments
        WHERE loan_id IN (SELECT id FROM loans WHERE member_id = ?)
        AND status = 'paid'
      `, [member.id]);

      const totalRepayments = Number(repaymentsResult.total || 0);

      // Validate loan eligibility
      const eligibility = totalSavings * 3; // Default multiplier
      const activeLoans = await db.all(`
        SELECT id, amount FROM loans
        WHERE member_id = ? AND status = 'active'
      `, [member.id]);

      for (const loan of activeLoans) {
        if (loan.amount > eligibility) {
          issues.push({
            type: 'LOAN_EXCEEDS_ELIGIBILITY',
            severity: 'HIGH',
            member_id: member.id,
            member_name: member.name,
            loan_id: loan.id,
            loan_amount: loan.amount,
            eligibility,
            difference: loan.amount - eligibility,
          });
        }
      }

      // Check for negative balances (should never happen)
      if (totalSavings < 0 || totalLoans < 0 || totalRepayments < 0) {
        issues.push({
          type: 'NEGATIVE_BALANCE',
          severity: 'CRITICAL',
          member_id: member.id,
          member_name: member.name,
          total_savings: totalSavings,
          total_loans: totalLoans,
          total_repayments: totalRepayments,
        });
      }

      // Check for repayments exceeding loans
      if (totalRepayments > totalLoans) {
        issues.push({
          type: 'REPAYMENTS_EXCEED_LOANS',
          severity: 'HIGH',
          member_id: member.id,
          member_name: member.name,
          total_loans: totalLoans,
          total_repayments: totalRepayments,
          difference: totalRepayments - totalLoans,
        });
      }
    }

    console.log(`✅ Balance validation complete: ${issues.length} issue(s) found`);
    return { success: true, issues, total_members: members.length };

  } catch (error) {
    console.error('❌ Balance validation failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ── Validate Loan Repayment Schedules ────────────────────────────────────────
async function validateLoanSchedules() {
  console.log('🔍 Validating loan repayment schedules...');
  
  const issues = [];

  try {
    const activeLoans = await db.all("SELECT * FROM loans WHERE status = 'active'");

    for (const loan of activeLoans) {
      // Get all repayments for this loan
      const repayments = await db.all(`
        SELECT * FROM repayments WHERE loan_id = ? ORDER BY month ASC
      `, [loan.id]);

      if (repayments.length === 0) {
        issues.push({
          type: 'LOAN_WITHOUT_SCHEDULE',
          severity: 'HIGH',
          loan_id: loan.id,
          member_id: loan.member_id,
          loan_amount: loan.amount,
        });
        continue;
      }

      // Calculate expected vs actual
      const totalExpected = repayments.reduce((sum, r) => sum + Number(r.amount || 0), 0);
      const totalPaid = repayments
        .filter(r => r.status === 'paid')
        .reduce((sum, r) => sum + Number(r.amount || 0), 0);

      // Check if amounts match loan amount (with interest)
      const loanSettings = await db.one("SELECT value FROM settings WHERE key = 'interest_rate'");
      const interestRate = Number(loanSettings.value || 0.05);
      const expectedTotal = loan.amount * (1 + interestRate);

      if (Math.abs(totalExpected - expectedTotal) > 1) {
        issues.push({
          type: 'SCHEDULE_AMOUNT_MISMATCH',
          severity: 'MEDIUM',
          loan_id: loan.id,
          expected_total: expectedTotal,
          scheduled_total: totalExpected,
          difference: Math.abs(totalExpected - expectedTotal),
        });
      }

      // Check for duplicate months
      const months = repayments.map(r => r.month);
      const uniqueMonths = new Set(months);
      if (months.length !== uniqueMonths.size) {
        issues.push({
          type: 'DUPLICATE_REPAYMENT_MONTHS',
          severity: 'HIGH',
          loan_id: loan.id,
          member_id: loan.member_id,
        });
      }

      // Check for gaps in schedule
      if (repayments.length > 1) {
        for (let i = 1; i < repayments.length; i++) {
          const prevMonth = new Date(repayments[i - 1].month + '-01');
          const currMonth = new Date(repayments[i].month + '-01');
          
          const monthDiff = (currMonth.getFullYear() - prevMonth.getFullYear()) * 12 +
                           (currMonth.getMonth() - prevMonth.getMonth());

          if (monthDiff > 1) {
            issues.push({
              type: 'SCHEDULE_GAP',
              severity: 'LOW',
              loan_id: loan.id,
              gap_after: repayments[i - 1].month,
              gap_before: repayments[i].month,
            });
          }
        }
      }
    }

    console.log(`✅ Schedule validation complete: ${issues.length} issue(s) found`);
    return { success: true, issues, total_loans: activeLoans.length };

  } catch (error) {
    console.error('❌ Schedule validation failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ── Reconcile Financial Totals ────────────────────────────────────────────────
async function reconcileFinancials(month = null) {
  if (!month) {
    const date = new Date();
    month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  console.log(`🔍 Reconciling financials for ${month}...`);

  try {
    // Calculate total inflows
    const savingsInflow = await db.one(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM savings
      WHERE month = ? AND status IN ('paid', 'late')
    `, [month]);

    const repaymentsInflow = await db.one(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM repayments
      WHERE month = ? AND status = 'paid'
    `, [month]);

    // Calculate total outflows (loan disbursements)
    const loansOutflow = await db.one(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM loans
      WHERE strftime('%Y-%m', approve_date) = ? AND status IN ('active', 'completed')
    `, [month]);

    const inflows = Number(savingsInflow.total || 0) + Number(repaymentsInflow.total || 0);
    const outflows = Number(loansOutflow.total || 0);
    const netPosition = inflows - outflows;

    const reconciliation = {
      month,
      inflows: {
        savings: Number(savingsInflow.total || 0),
        repayments: Number(repaymentsInflow.total || 0),
        total: inflows,
      },
      outflows: {
        loans: Number(loansOutflow.total || 0),
        total: outflows,
      },
      net_position: netPosition,
      timestamp: new Date().toISOString(),
    };

    console.log(`✅ Reconciliation complete for ${month}`);
    console.log(`   Inflows: ETB ${inflows.toFixed(2)}`);
    console.log(`   Outflows: ETB ${outflows.toFixed(2)}`);
    console.log(`   Net: ETB ${netPosition.toFixed(2)}`);

    return reconciliation;

  } catch (error) {
    console.error('❌ Reconciliation failed:', error.message);
    throw error;
  }
}

// ── Detect Duplicate Transactions ─────────────────────────────────────────────
async function detectDuplicateTransactions() {
  console.log('🔍 Detecting duplicate transactions...');
  
  const duplicates = [];

  try {
    // Check for duplicate savings
    const duplicateSavings = await db.all(`
      SELECT member_id, month, COUNT(*) as count, GROUP_CONCAT(id) as ids
      FROM savings
      GROUP BY member_id, month
      HAVING count > 1
    `);

    for (const dup of duplicateSavings) {
      duplicates.push({
        type: 'DUPLICATE_SAVINGS',
        member_id: dup.member_id,
        month: dup.month,
        count: dup.count,
        ids: dup.ids,
      });
    }

    // Check for duplicate repayments
    const duplicateRepayments = await db.all(`
      SELECT loan_id, month, COUNT(*) as count, GROUP_CONCAT(id) as ids
      FROM repayments
      GROUP BY loan_id, month
      HAVING count > 1
    `);

    for (const dup of duplicateRepayments) {
      duplicates.push({
        type: 'DUPLICATE_REPAYMENTS',
        loan_id: dup.loan_id,
        month: dup.month,
        count: dup.count,
        ids: dup.ids,
      });
    }

    console.log(`✅ Duplicate detection complete: ${duplicates.length} duplicate(s) found`);
    return { success: true, duplicates };

  } catch (error) {
    console.error('❌ Duplicate detection failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ── Validate Data Consistency ─────────────────────────────────────────────────
async function validateDataConsistency() {
  console.log('🔍 Running comprehensive data consistency checks...');
  
  const results = {};

  // Check 1: Orphaned records
  results.orphanedSavings = await db.all(`
    SELECT s.* FROM savings s
    LEFT JOIN members m ON s.member_id = m.id
    WHERE m.id IS NULL
  `);

  results.orphanedLoans = await db.all(`
    SELECT l.* FROM loans l
    LEFT JOIN members m ON l.member_id = m.id
    WHERE m.id IS NULL
  `);

  results.orphanedRepayments = await db.all(`
    SELECT r.* FROM repayments r
    LEFT JOIN loans l ON r.loan_id = l.id
    WHERE l.id IS NULL
  `);

  // Check 2: Invalid statuses
  results.invalidSavingsStatus = await db.all(`
    SELECT * FROM savings
    WHERE status NOT IN ('paid', 'late', 'pending_review')
  `);

  results.invalidLoanStatus = await db.all(`
    SELECT * FROM loans
    WHERE status NOT IN ('pending', 'active', 'completed', 'rejected')
  `);

  results.invalidRepaymentStatus = await db.all(`
    SELECT * FROM repayments
    WHERE status NOT IN ('pending', 'due', 'paid', 'overdue', 'pending_review', 'refinanced')
  `);

  // Check 3: Invalid amounts (negative or zero)
  results.invalidAmounts = await db.all(`
    SELECT 'savings' as type, id, member_id, amount FROM savings WHERE amount <= 0
    UNION ALL
    SELECT 'loans' as type, id, member_id, amount FROM loans WHERE amount <= 0
    UNION ALL
    SELECT 'repayments' as type, id, loan_id as member_id, amount FROM repayments WHERE amount <= 0
  `);

  // Check 4: Future dates
  const today = new Date().toISOString().split('T')[0];
  results.futureDates = await db.all(`
    SELECT 'savings' as type, id, paid_date as date FROM savings WHERE paid_date > ?
    UNION ALL
    SELECT 'loans' as type, id, approve_date as date FROM loans WHERE approve_date > ?
    UNION ALL
    SELECT 'repayments' as type, id, paid_date as date FROM repayments WHERE paid_date > ?
  `, [today, today, today]);

  // Calculate totals
  const totalIssues = 
    results.orphanedSavings.length +
    results.orphanedLoans.length +
    results.orphanedRepayments.length +
    results.invalidSavingsStatus.length +
    results.invalidLoanStatus.length +
    results.invalidRepaymentStatus.length +
    results.invalidAmounts.length +
    results.futureDates.length;

  console.log(`✅ Consistency check complete: ${totalIssues} issue(s) found`);

  return {
    success: true,
    total_issues: totalIssues,
    details: results,
  };
}

// ── Generate Integrity Report ─────────────────────────────────────────────────
async function generateIntegrityReport() {
  console.log('📊 Generating comprehensive integrity report...');

  const report = {
    timestamp: new Date().toISOString(),
    checks: {},
  };

  try {
    // Run all validations
    report.checks.balances = await validateMemberBalances();
    report.checks.schedules = await validateLoanSchedules();
    report.checks.duplicates = await detectDuplicateTransactions();
    report.checks.consistency = await validateDataConsistency();
    report.checks.reconciliation = await reconcileFinancials();

    // Calculate overall score
    const totalIssues = 
      (report.checks.balances.issues?.length || 0) +
      (report.checks.schedules.issues?.length || 0) +
      (report.checks.duplicates.duplicates?.length || 0) +
      (report.checks.consistency.total_issues || 0);

    report.overall_score = totalIssues === 0 ? 100 : Math.max(0, 100 - (totalIssues * 2));
    report.total_issues = totalIssues;
    report.status = totalIssues === 0 ? 'HEALTHY' : totalIssues < 10 ? 'WARNING' : 'CRITICAL';

    console.log(`✅ Integrity report generated`);
    console.log(`   Overall Score: ${report.overall_score}/100`);
    console.log(`   Status: ${report.status}`);
    console.log(`   Total Issues: ${report.total_issues}`);

    return report;

  } catch (error) {
    console.error('❌ Failed to generate integrity report:', error.message);
    throw error;
  }
}

// ── Schedule Automatic Integrity Checks ───────────────────────────────────────
function scheduleIntegrityChecks() {
  const enabled = process.env.INTEGRITY_CHECKS_ENABLED !== 'false';
  
  if (!enabled) {
    console.log('ℹ️  Automatic integrity checks disabled');
    return;
  }

  console.log('⏰ Scheduling automatic integrity checks (daily at 2 AM)');

  // Run initial check after 5 minutes
  setTimeout(async () => {
    try {
      const report = await generateIntegrityReport();
      if (report.total_issues > 0) {
        console.warn(`⚠️  Integrity check found ${report.total_issues} issues`);
      }
    } catch (error) {
      console.error('Scheduled integrity check failed:', error.message);
    }
  }, 5 * 60 * 1000);

  // Schedule daily checks
  setInterval(async () => {
    const hour = new Date().getHours();
    if (hour === 2) { // 2 AM
      try {
        const report = await generateIntegrityReport();
        if (report.total_issues > 0) {
          console.warn(`⚠️  Daily integrity check found ${report.total_issues} issues`);
          // TODO: Send alert to admin
        }
      } catch (error) {
        console.error('Scheduled integrity check failed:', error.message);
      }
    }
  }, 60 * 60 * 1000); // Check every hour
}

// ── Export Functions ──────────────────────────────────────────────────────────
module.exports = {
  validateMemberBalances,
  validateLoanSchedules,
  reconcileFinancials,
  detectDuplicateTransactions,
  validateDataConsistency,
  generateIntegrityReport,
  scheduleIntegrityChecks,
};
