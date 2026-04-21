const express = require('express');
const db      = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Helper to get organization settings
async function getOrgSettings() {
  const settings = await db.all('SELECT key, value FROM settings');
  const map = {};
  settings.forEach(s => { map[s.key] = s.value; });
  return {
    org_name: map.org_name || 'Wazema SCBC',
    org_phone: map.org_phone || '+251911000000',
    org_email: map.org_email || 'admin@wazema-scbc.org',
    org_address: map.org_address || 'Addis Ababa, Ethiopia',
    currency: map.currency || 'ETB',
  };
}

// GET /api/receipts/saving/:id — Generate HTML receipt for a saving payment
router.get('/saving/:id', authMiddleware, async (req, res, next) => {
  try {
    const saving = await db.one(
      `SELECT s.*, m.name as member_name, m.id as member_id, m.phone as member_phone, m.account_type 
       FROM savings s 
       JOIN members m ON s.member_id = m.id 
       WHERE s.id = $1`,
      [req.params.id]
    );

    if (!saving) {
      return res.status(404).json({ error: 'Saving record not found' });
    }

    // Check access: members can only view their own receipts
    if (req.user.role === 'member' && saving.member_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Only generate receipts for confirmed payments
    if (!['paid', 'late'].includes(saving.status)) {
      return res.status(400).json({ error: 'Receipt only available for confirmed payments' });
    }

    const org = await getOrgSettings();
    const receiptDate = new Date().toISOString().split('T')[0];
    const monthLabel = saving.month.split('-').map((p, i) => {
      if (i === 0) return p;
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return months[parseInt(p) - 1];
    }).join(' ');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Savings Receipt — ${saving.id}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
      color: #1a1a2e; 
      padding: 2rem; 
      max-width: 800px; 
      margin: 0 auto;
      background: #f5f7fa;
    }
    .receipt {
      background: white;
      border: 2px solid #1a6bff;
      border-radius: 12px;
      padding: 2rem;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      border-bottom: 3px double #1a6bff;
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
      position: relative;
    }
    .org-name {
      font-size: 1.8rem;
      font-weight: 900;
      color: #1a1a2e;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }
    .org-sub {
      font-size: 0.9rem;
      color: #666;
      margin-bottom: 0.25rem;
    }
    .receipt-title {
      font-size: 1.4rem;
      font-weight: 800;
      color: #1a6bff;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 1.5rem 0 0.5rem;
    }
    .receipt-id {
      font-size: 0.85rem;
      color: #888;
      font-family: 'Courier New', monospace;
    }
    .stamp {
      position: absolute;
      top: -10px;
      right: 0;
      border: 3px solid #1a6bff;
      border-radius: 50%;
      width: 90px;
      height: 90px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 0.7rem;
      color: #1a6bff;
      text-align: center;
      line-height: 1.2;
      background: white;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin: 1.5rem 0;
      background: #f8faff;
      border: 1px solid #dde;
      border-radius: 8px;
      padding: 1.5rem;
    }
    .info-row {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .info-label {
      font-size: 0.75rem;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }
    .info-value {
      font-size: 1rem;
      font-weight: 700;
      color: #1a1a2e;
    }
    .amount-box {
      background: linear-gradient(135deg, #1a6bff 0%, #0d4fb8 100%);
      color: white;
      padding: 1.5rem;
      border-radius: 8px;
      text-align: center;
      margin: 1.5rem 0;
    }
    .amount-label {
      font-size: 0.85rem;
      opacity: 0.9;
      margin-bottom: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .amount-value {
      font-size: 2.5rem;
      font-weight: 900;
      letter-spacing: -0.02em;
    }
    .status-badge {
      display: inline-block;
      padding: 0.4rem 1rem;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .status-paid {
      background: #d1fae5;
      color: #065f46;
    }
    .status-late {
      background: #fef3c7;
      color: #92400e;
    }
    .footer {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid #dde;
      text-align: center;
      font-size: 0.8rem;
      color: #888;
    }
    .signature-line {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 2px solid #1a1a2e;
      width: 250px;
      text-align: center;
      font-size: 0.85rem;
      color: #666;
    }
    .print-btn {
      display: block;
      margin: 2rem auto 0;
      padding: 0.75rem 2rem;
      background: #1a6bff;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(26,107,255,0.3);
    }
    .print-btn:hover {
      background: #0d4fb8;
    }
    @media print {
      body { background: white; padding: 0; }
      .receipt { border: none; box-shadow: none; }
      .print-btn { display: none; }
    }
  </style>
</head>
<body>
  <div class="receipt">
    <div class="header">
      <div class="org-name">${org.org_name}</div>
      <div class="org-sub">${org.org_address}</div>
      <div class="org-sub">${org.org_phone} | ${org.org_email}</div>
      <div class="stamp">OFFICIAL<br/>RECEIPT</div>
    </div>

    <div class="receipt-title">💰 Savings Payment Receipt</div>
    <div class="receipt-id">Receipt No: ${saving.id}</div>

    <div class="info-grid">
      <div class="info-row">
        <div class="info-label">Member Name</div>
        <div class="info-value">${saving.member_name}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Member ID</div>
        <div class="info-value">${saving.member_id}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Account Type</div>
        <div class="info-value">${saving.account_type || 'Regular'}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Phone</div>
        <div class="info-value">${saving.member_phone}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Payment Month</div>
        <div class="info-value">${monthLabel}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Payment Date</div>
        <div class="info-value">${saving.paid_date || '—'}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Status</div>
        <div class="info-value">
          <span class="status-badge status-${saving.status}">${saving.status === 'paid' ? '✓ PAID' : '⚠ LATE'}</span>
        </div>
      </div>
      <div class="info-row">
        <div class="info-label">Receipt Date</div>
        <div class="info-value">${receiptDate}</div>
      </div>
    </div>

    <div class="amount-box">
      <div class="amount-label">Amount Paid</div>
      <div class="amount-value">${org.currency} ${Number(saving.amount).toFixed(2)}</div>
      ${saving.penalty > 0 ? `<div style="font-size: 0.9rem; margin-top: 0.5rem; opacity: 0.9;">Includes ${org.currency} ${Number(saving.penalty).toFixed(2)} late penalty</div>` : ''}
    </div>

    ${saving.bank_name ? `
    <div style="background: #f8faff; border: 1px solid #dde; border-radius: 8px; padding: 1rem; margin: 1rem 0;">
      <div style="font-size: 0.75rem; color: #666; text-transform: uppercase; margin-bottom: 0.5rem;">Payment Details</div>
      <div style="font-weight: 600;">Bank: ${saving.bank_name}</div>
      <div style="font-size: 0.85rem; color: #666; font-family: monospace;">${saving.account_number || ''}</div>
    </div>
    ` : ''}

    <div class="footer">
      <p style="margin-bottom: 0.5rem;">This is an official receipt issued by ${org.org_name}</p>
      <p>For inquiries, contact: ${org.org_phone} | ${org.org_email}</p>
      <p style="margin-top: 1rem; font-size: 0.75rem; color: #aaa;">Generated on ${receiptDate}</p>
    </div>

    <div style="display: flex; justify-content: space-between; margin-top: 3rem;">
      <div class="signature-line">
        Received By<br/><strong>${org.org_name}</strong>
      </div>
      <div class="signature-line">
        Member Signature<br/><strong>${saving.member_name}</strong>
      </div>
    </div>
  </div>

  <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch(e) { next(e); }
});

// GET /api/receipts/repayment/:id — Generate HTML receipt for a repayment
router.get('/repayment/:id', authMiddleware, async (req, res, next) => {
  try {
    const repayment = await db.one(
      `SELECT r.*, l.id as loan_id, l.amount as loan_amount, l.member_id, 
              m.name as member_name, m.phone as member_phone, m.account_type
       FROM repayments r
       JOIN loans l ON r.loan_id = l.id
       JOIN members m ON l.member_id = m.id
       WHERE r.id = $1`,
      [req.params.id]
    );

    if (!repayment) {
      return res.status(404).json({ error: 'Repayment record not found' });
    }

    // Check access
    if (req.user.role === 'member' && repayment.member_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Only generate receipts for paid repayments
    if (repayment.status !== 'paid') {
      return res.status(400).json({ error: 'Receipt only available for paid repayments' });
    }

    const org = await getOrgSettings();
    const receiptDate = new Date().toISOString().split('T')[0];
    const monthLabel = repayment.month.split('-').map((p, i) => {
      if (i === 0) return p;
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return months[parseInt(p) - 1];
    }).join(' ');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Repayment Receipt — ${repayment.id}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
      color: #1a1a2e; 
      padding: 2rem; 
      max-width: 800px; 
      margin: 0 auto;
      background: #f5f7fa;
    }
    .receipt {
      background: white;
      border: 2px solid #10b981;
      border-radius: 12px;
      padding: 2rem;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      border-bottom: 3px double #10b981;
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
      position: relative;
    }
    .org-name {
      font-size: 1.8rem;
      font-weight: 900;
      color: #1a1a2e;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }
    .org-sub {
      font-size: 0.9rem;
      color: #666;
      margin-bottom: 0.25rem;
    }
    .receipt-title {
      font-size: 1.4rem;
      font-weight: 800;
      color: #10b981;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 1.5rem 0 0.5rem;
    }
    .receipt-id {
      font-size: 0.85rem;
      color: #888;
      font-family: 'Courier New', monospace;
    }
    .stamp {
      position: absolute;
      top: -10px;
      right: 0;
      border: 3px solid #10b981;
      border-radius: 50%;
      width: 90px;
      height: 90px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 0.7rem;
      color: #10b981;
      text-align: center;
      line-height: 1.2;
      background: white;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin: 1.5rem 0;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 8px;
      padding: 1.5rem;
    }
    .info-row {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .info-label {
      font-size: 0.75rem;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }
    .info-value {
      font-size: 1rem;
      font-weight: 700;
      color: #1a1a2e;
    }
    .amount-box {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      padding: 1.5rem;
      border-radius: 8px;
      text-align: center;
      margin: 1.5rem 0;
    }
    .amount-label {
      font-size: 0.85rem;
      opacity: 0.9;
      margin-bottom: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .amount-value {
      font-size: 2.5rem;
      font-weight: 900;
      letter-spacing: -0.02em;
    }
    .footer {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid #dde;
      text-align: center;
      font-size: 0.8rem;
      color: #888;
    }
    .signature-line {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 2px solid #1a1a2e;
      width: 250px;
      text-align: center;
      font-size: 0.85rem;
      color: #666;
    }
    .print-btn {
      display: block;
      margin: 2rem auto 0;
      padding: 0.75rem 2rem;
      background: #10b981;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(16,185,129,0.3);
    }
    .print-btn:hover {
      background: #059669;
    }
    @media print {
      body { background: white; padding: 0; }
      .receipt { border: none; box-shadow: none; }
      .print-btn { display: none; }
    }
  </style>
</head>
<body>
  <div class="receipt">
    <div class="header">
      <div class="org-name">${org.org_name}</div>
      <div class="org-sub">${org.org_address}</div>
      <div class="org-sub">${org.org_phone} | ${org.org_email}</div>
      <div class="stamp">OFFICIAL<br/>RECEIPT</div>
    </div>

    <div class="receipt-title">🏦 Loan Repayment Receipt</div>
    <div class="receipt-id">Receipt No: ${repayment.id}</div>

    <div class="info-grid">
      <div class="info-row">
        <div class="info-label">Member Name</div>
        <div class="info-value">${repayment.member_name}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Member ID</div>
        <div class="info-value">${repayment.member_id}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Loan ID</div>
        <div class="info-value">${repayment.loan_id}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Phone</div>
        <div class="info-value">${repayment.member_phone}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Repayment Month</div>
        <div class="info-value">${monthLabel}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Payment Date</div>
        <div class="info-value">${repayment.paid_date || '—'}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Loan Amount</div>
        <div class="info-value">${org.currency} ${Number(repayment.loan_amount).toFixed(2)}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Receipt Date</div>
        <div class="info-value">${receiptDate}</div>
      </div>
    </div>

    <div class="amount-box">
      <div class="amount-label">Installment Paid</div>
      <div class="amount-value">${org.currency} ${Number(repayment.amount).toFixed(2)}</div>
      ${repayment.penalty > 0 ? `<div style="font-size: 0.9rem; margin-top: 0.5rem; opacity: 0.9;">Includes ${org.currency} ${Number(repayment.penalty).toFixed(2)} late penalty</div>` : ''}
    </div>

    ${repayment.bank_name ? `
    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 1rem; margin: 1rem 0;">
      <div style="font-size: 0.75rem; color: #666; text-transform: uppercase; margin-bottom: 0.5rem;">Payment Details</div>
      <div style="font-weight: 600;">Bank: ${repayment.bank_name}</div>
      <div style="font-size: 0.85rem; color: #666; font-family: monospace;">${repayment.account_number || ''}</div>
    </div>
    ` : ''}

    <div class="footer">
      <p style="margin-bottom: 0.5rem;">This is an official receipt issued by ${org.org_name}</p>
      <p>For inquiries, contact: ${org.org_phone} | ${org.org_email}</p>
      <p style="margin-top: 1rem; font-size: 0.75rem; color: #aaa;">Generated on ${receiptDate}</p>
    </div>

    <div style="display: flex; justify-content: space-between; margin-top: 3rem;">
      <div class="signature-line">
        Received By<br/><strong>${org.org_name}</strong>
      </div>
      <div class="signature-line">
        Member Signature<br/><strong>${repayment.member_name}</strong>
      </div>
    </div>
  </div>

  <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch(e) { next(e); }
});

module.exports = router;
