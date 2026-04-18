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

// In-memory map for password reset tokens (production: use DB table)
const resetTokens = new Map();

// ── Normalize Ethiopian phone numbers ─────────────────────────────────────
// Accepts: 09XXXXXXXX (10 digits starting with 09)
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  // Must be exactly 10 digits starting with 09
  if (/^09\d{8}$/.test(digits)) return digits;
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
      const admin = await db.one(
        'SELECT * FROM admins WHERE username=$1',
        [id]
      );

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
    // Try by member ID first, then by phone (normalized)
    const normalizedPhone = normalizePhone(id);
    let member = null;

    // Try exact ID match
    member = await db.one(
      "SELECT * FROM members WHERE id=$1",
      [id]
    );

    // If not found by ID, try phone
    if (!member && normalizedPhone) {
      member = await db.one(
        "SELECT * FROM members WHERE phone=$1",
        [normalizedPhone]
      );
    }

    // Also try raw phone if normalization failed (e.g. user typed with spaces)
    if (!member) {
      member = await db.one(
        "SELECT * FROM members WHERE phone=$1",
        [id]
      );
    }

    if (!member || !bcrypt.compareSync(password, member.password)) {
      recordFailedLogin(id);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Block inactive/exited members
    if (member.status && member.status !== 'active') {
      return res.status(403).json({
        error: 'Your account is not active. Please contact the administrator.',
      });
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
  } catch {
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

    let user;
    if (role === 'admin') {
      user = await db.one('SELECT * FROM admins WHERE id=$1', [id]);
    } else {
      user = await db.one('SELECT * FROM members WHERE id=$1', [id]);
    }

    if (!user || !bcrypt.compareSync(current_password, user.password)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashed = bcrypt.hashSync(new_password, 12);

    if (role === 'admin') {
      await db.run('UPDATE admins SET password=$1 WHERE id=$2', [hashed, id]);
    } else {
      await db.run('UPDATE members SET password=$1 WHERE id=$2', [hashed, id]);
    }

    // Revoke current token — user must log in again
    revokeToken(req.token);

    res.json({ message: 'Password changed successfully. Please log in again.' });
  } catch (err) {
    console.error('CHANGE PASSWORD ERROR:', err.message);
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

// ── FORGOT PASSWORD (admin-only reset flow) ────────────────────────────────
// In production, send this token via SMS/email. Here we return it for admin use.
router.post('/forgot-password', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: 'Identifier required' });

    const id = identifier.trim();
    const normalizedPhone = normalizePhone(id);

    let member = await db.one('SELECT id, phone FROM members WHERE id=$1', [id]);
    if (!member && normalizedPhone) {
      member = await db.one('SELECT id, phone FROM members WHERE phone=$1', [normalizedPhone]);
    }

    // Always return same response to prevent user enumeration
    if (!member) {
      return res.json({ message: 'If the account exists, a reset token has been generated. Contact your administrator.' });
    }

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 30 * 60 * 1000; // 30 minutes
    resetTokens.set(token, { memberId: member.id, expires });

    // In production: send via SMS/email. For now, admin delivers it manually.
    console.log(`[RESET TOKEN] Member ${member.id}: ${token} (expires in 30 min)`);

    res.json({ message: 'Reset token generated. Contact your administrator to receive it.' });
  } catch (err) {
    console.error('FORGOT PASSWORD ERROR:', err.message);
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

// ── RESET PASSWORD ─────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const record = resetTokens.get(token);
    if (!record || record.expires < Date.now()) {
      resetTokens.delete(token);
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hashed = bcrypt.hashSync(new_password, 12);
    await db.run('UPDATE members SET password=$1 WHERE id=$2', [hashed, record.memberId]);

    resetTokens.delete(token);

    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error('RESET PASSWORD ERROR:', err.message);
    res.status(500).json({ error: 'An internal error occurred.' });
  }
});

module.exports = router;
