const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db');

const {
  JWT_SECRET,
  authMiddleware,
  revokeToken,
  isLockedOut,
  recordFailedLogin,
  clearLoginAttempts,
  minutesUntilUnlock,
} = require('../middleware/auth');

const router = express.Router();

// In-memory reset token store (production: use DB table)
// key = token string, value = { memberId, expires }
const resetTokens = new Map();

// ── Normalize Ethiopian phone numbers ─────────────────────────────────────
// Accepts: 09XXXXXXXX or +2519XXXXXXXX or 2519XXXXXXXX
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  // +251 or 251 prefix → convert to 09...
  if (/^2519\d{8}$/.test(digits)) return '0' + digits.slice(3);
  if (/^09\d{8}$/.test(digits))   return digits;
  return null;
}

// ── LOGIN ──────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { identifier, password, role } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const id = identifier.trim();

    // Brute-force lockout check
    if (isLockedOut(id)) {
      const mins = minutesUntilUnlock(id);
      return res.status(429).json({
        error: `Account temporarily locked due to too many failed attempts. Try again in ${mins} minute(s).`,
      });
    }

    // ── ADMIN LOGIN ──────────────────────────────────────────────────────
    if (role === 'admin') {
      let admin = null;
      try {
        const r = await db.query('SELECT * FROM admins WHERE username=$1', [id]);
        admin = r.rows?.[0] || null;
      } catch (err) {
        console.error('Admin query error:', err.message);
      }

      if (!admin || !bcrypt.compareSync(password, admin.password)) {
        recordFailedLogin(id);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      clearLoginAttempts(id);

      const jti   = crypto.randomUUID();
      const token = jwt.sign(
        { id: admin.id, role: 'admin', jti },
        JWT_SECRET,
        { expiresIn: '8h', algorithm: 'HS256' }
      );

      return res.json({ token, role: 'admin' });
    }

    // ── MEMBER LOGIN ─────────────────────────────────────────────────────
    const normalizedPhone = normalizePhone(id);
    let member = null;

    // 1. Try exact member ID match
    try {
      const r = await db.query('SELECT * FROM members WHERE id=$1', [id]);
      member = r.rows?.[0] || null;
    } catch (err) { console.error('Member ID query error:', err.message); }

    // 2. Try normalized phone
    if (!member && normalizedPhone) {
      try {
        const r = await db.query('SELECT * FROM members WHERE phone=$1', [normalizedPhone]);
        member = r.rows?.[0] || null;
      } catch (err) { console.error('Member phone query error:', err.message); }
    }

    // 3. Try raw phone as fallback
    if (!member && id !== normalizedPhone) {
      try {
        const r = await db.query('SELECT * FROM members WHERE phone=$1', [id]);
        member = r.rows?.[0] || null;
      } catch (err) { console.error('Member raw phone query error:', err.message); }
    }

    // Check status BEFORE password (don't waste bcrypt on inactive accounts)
    if (member && member.status && member.status !== 'active') {
      return res.status(403).json({
        error: 'Your account is not active. Please contact the administrator.',
      });
    }

    if (!member || !bcrypt.compareSync(password, member.password)) {
      recordFailedLogin(id);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    clearLoginAttempts(id);

    const jti   = crypto.randomUUID();
    const token = jwt.sign(
      { id: member.id, role: 'member', jti },
      JWT_SECRET,
      { expiresIn: '8h', algorithm: 'HS256' }
    );

    res.json({ token, role: 'member' });

  } catch (err) {
    console.error('LOGIN ERROR:', err.message);
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

// ── LOGOUT (revoke token) ──────────────────────────────────────────────────
router.post('/logout', authMiddleware, (req, res) => {
  try {
    revokeToken(req.token);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err.message);
    res.json({ message: 'Logged out' });
  }
});

// ── CHANGE PASSWORD ────────────────────────────────────────────────────────
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both current and new password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const { id, role } = req.user;

    let user = null;
    try {
      const table = role === 'admin' ? 'admins' : 'members';
      const r = await db.query(`SELECT * FROM ${table} WHERE id=$1`, [id]);
      user = r.rows?.[0] || null;
    } catch (err) { console.error('Change password query error:', err.message); }

    if (!user || !bcrypt.compareSync(current_password, user.password)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashed = bcrypt.hashSync(new_password, 12);
    const table  = role === 'admin' ? 'admins' : 'members';
    await db.run(`UPDATE ${table} SET password=$1 WHERE id=$2`, [hashed, id]);

    // Revoke current token — user must log in again
    revokeToken(req.token);

    res.json({ message: 'Password changed successfully. Please log in again.' });
  } catch (err) {
    console.error('CHANGE PASSWORD ERROR:', err.message);
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

// ── FORGOT PASSWORD ────────────────────────────────────────────────────────
// Frontend sends: { member_id, phone }
// Verifies member exists AND phone matches, then returns reset_token directly
// (admin delivers it to the member in person / via phone call)
router.post('/forgot-password', async (req, res) => {
  try {
    const { member_id, phone } = req.body;

    if (!member_id || !phone) {
      return res.status(400).json({ error: 'Member ID and phone number are required' });
    }

    const id             = member_id.trim().toUpperCase();
    const normalizedPhone = normalizePhone(phone.trim());

    if (!normalizedPhone) {
      return res.status(400).json({ error: 'Invalid phone number format. Use 09XXXXXXXX.' });
    }

    // Look up member by ID
    let member = null;
    try {
      const r = await db.query('SELECT id, phone FROM members WHERE id=$1', [id]);
      member = r.rows?.[0] || null;
    } catch (err) { console.error('Forgot password query error:', err.message); }

    // Verify phone matches — prevents token generation for wrong person
    const memberPhone = member ? normalizePhone(member.phone) : null;
    if (!member || memberPhone !== normalizedPhone) {
      // Same response either way — prevents user enumeration
      return res.json({ message: 'If the details match our records, a reset token has been generated. Contact your administrator.' });
    }

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 30 * 60 * 1000; // 30 minutes
    resetTokens.set(token, { memberId: member.id, expires });

    console.log(`[RESET TOKEN] Member ${member.id}: ${token} (expires in 30 min)`);

    // Return token directly so admin can relay it to the member
    res.json({
      reset_token: token,
      message: 'Reset token generated. Your administrator will provide it to you.',
    });
  } catch (err) {
    console.error('FORGOT PASSWORD ERROR:', err.message);
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

// ── RESET PASSWORD ─────────────────────────────────────────────────────────
// Frontend sends: { reset_token, new_password }
router.post('/reset-password', async (req, res) => {
  try {
    const { reset_token, new_password } = req.body;

    if (!reset_token || !new_password) {
      return res.status(400).json({ error: 'Reset token and new password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const record = resetTokens.get(reset_token);
    if (!record || record.expires < Date.now()) {
      resetTokens.delete(reset_token);
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hashed = bcrypt.hashSync(new_password, 12);
    await db.run('UPDATE members SET password=$1 WHERE id=$2', [hashed, record.memberId]);

    resetTokens.delete(reset_token);

    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error('RESET PASSWORD ERROR:', err.message);
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

module.exports = router;
