const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db');
const {
  JWT_SECRET, authMiddleware, revokeToken,
  isLockedOut, recordFailedLogin, clearLoginAttempts, minutesUntilUnlock,
} = require('../middleware/auth');

const router = express.Router();

// Password reset tokens: token → { memberId, expires, used }
const resetTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of resetTokens) { if (v.expires < now) resetTokens.delete(t); }
}, 10 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────
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
  const local = s.startsWith('+251') ? '0' + s.slice(4) : s.startsWith('251') ? '0' + s.slice(3) : s;
  if (!/^09\d{8}$/.test(local)) return 'Phone must start with 09 and be 10 digits (e.g. 0911234567)';
  return null;
}

function validatePasswordStrength(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required';
  if (pw.length < 6) return 'Password must be at least 6 characters';
  if (pw.length > 128) return 'Password too long';
  return null; // valid
}

// Constant-time string comparison to prevent timing attacks
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still run comparison to avoid timing leak
    crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function auditLog(actor, action, target, detail) {
  try { await db.run('INSERT INTO audit_log (actor,action,target,detail) VALUES ($1,$2,$3,$4)',
    [actor, action, target||null, detail||null]); } catch {}
}

// ── POST /api/auth/login ──────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { identifier, password, role } = req.body;

    // Basic input validation
    if (!identifier || typeof identifier !== 'string') return res.status(400).json({ error: 'Identifier is required' });
    if (!password   || typeof password   !== 'string') return res.status(400).json({ error: 'Password is required' });
    if (identifier.length > 100) return res.status(400).json({ error: 'Invalid identifier' });

    const id = identifier.trim();

    // Check brute-force lockout
    if (isLockedOut(id)) {
      const mins = minutesUntilUnlock(id);
      await auditLog(id, 'LOGIN_BLOCKED', null, 'Brute-force lockout');
      return res.status(429).json({ error: `Account temporarily locked due to too many failed attempts. Try again in ${mins} minute(s).` });
    }

    // ── Admin login ───────────────────────────────────────────────────────
    if (role === 'admin') {
      const admin = await db.one('SELECT * FROM admins WHERE username=$1', [id]);
      if (!admin || !bcrypt.compareSync(password, admin.password)) {
        const result = recordFailedLogin(id);
        await auditLog(id, 'LOGIN_FAILED', null, 'Admin login failed');
        if (result.locked) {
          return res.status(429).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      clearLoginAttempts(id);
      const jti   = crypto.randomUUID();
      const token = jwt.sign(
        { id: admin.id, username: admin.username, role: 'admin', jti },
        JWT_SECRET,
        { expiresIn: '8h', algorithm: 'HS256' }
      );
      await auditLog('admin', 'LOGIN_SUCCESS', String(admin.id), 'Admin login');
      return res.json({ token, role: 'admin', name: 'Administrator' });
    }

    // ── Member login ──────────────────────────────────────────────────────
    const member = await db.one(
      "SELECT * FROM members WHERE (id=$1 OR phone=$2 OR phone=$3) AND status='active'",
      [id, id, normalizePhone(id)]
    );
    if (!member || !bcrypt.compareSync(password, member.password)) {
      const result = recordFailedLogin(id);
      await auditLog(id, 'LOGIN_FAILED', null, 'Member login failed');
      if (result.locked) {
        return res.status(429).json({ error: 'Too many failed attempts. Account locked for 15 minutes.' });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    clearLoginAttempts(id);
    const jti   = crypto.randomUUID();
    const token = jwt.sign(
      { id: member.id, name: member.name, role: 'member', jti },
      JWT_SECRET,
      { expiresIn: '8h', algorithm: 'HS256' }
    );
    await auditLog(member.id, 'LOGIN_SUCCESS', member.id, 'Member login');
    res.json({ token, role: 'member', id: member.id, name: member.name });
  } catch(e) { next(e); }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────
router.post('/logout', authMiddleware, async (req, res) => {
  revokeToken(req.token);
  await auditLog(req.user.id || req.user.username, 'LOGOUT', null, null);
  res.json({ message: 'Logged out successfully' });
});

// ── POST /api/auth/change-password ───────────────────────────────────────
router.post('/change-password', authMiddleware, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });

    const pwError = validatePasswordStrength(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });

    // Prevent reuse of same password
    if (safeCompare(currentPassword, newPassword)) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    const member = await db.one('SELECT * FROM members WHERE id=$1', [req.user.id]);
    if (!member || !bcrypt.compareSync(currentPassword, member.password)) {
      await auditLog(req.user.id, 'CHANGE_PASSWORD_FAILED', req.user.id, 'Wrong current password');
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await db.run('UPDATE members SET password=$1 WHERE id=$2',
      [bcrypt.hashSync(newPassword, 12), req.user.id]);
    revokeToken(req.token);
    await auditLog(req.user.id, 'CHANGE_PASSWORD', req.user.id, 'Password changed');
    res.json({ message: 'Password updated successfully. Please log in again.' });
  } catch(e) { next(e); }
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { member_id, phone } = req.body;
    if (!member_id || !phone) return res.status(400).json({ error: 'member_id and phone are required' });
    if (typeof member_id !== 'string' || member_id.length > 20) return res.status(400).json({ error: 'Invalid member_id' });

    const member = await db.one(
      "SELECT id,name,phone FROM members WHERE id=$1 AND status='active'",
      [member_id.trim().toUpperCase()]
    );
    const normalizedInput = normalizePhone(phone);

    // Always return same response to prevent member enumeration
    const genericResponse = { message: 'If the details match, a reset token has been generated. Contact your admin with the token.' };

    if (!member || (member.phone !== normalizedInput && member.phone !== phone.trim())) {
      return res.json(genericResponse);
    }

    // Invalidate any existing token for this member
    for (const [t, v] of resetTokens) {
      if (v.memberId === member.id) resetTokens.delete(t);
    }

    const token   = crypto.randomBytes(8).toString('hex').toUpperCase(); // 16-char token
    const expires = Date.now() + 30 * 60 * 1000; // 30 minutes
    resetTokens.set(token, { memberId: member.id, expires, used: false });

    await auditLog(member.id, 'PASSWORD_RESET_REQUESTED', member.id, 'Reset token generated');
    res.json({
      message: 'Reset token generated. Share this token with the member.',
      reset_token: token,
      expires_in: '30 minutes',
      member_name: member.name,
    });
  } catch(e) { next(e); }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const { reset_token, new_password } = req.body;
    if (!reset_token || !new_password) return res.status(400).json({ error: 'reset_token and new_password are required' });

    const pwError = validatePasswordStrength(new_password);
    if (pwError) return res.status(400).json({ error: pwError });

    const entry = resetTokens.get(reset_token.trim().toUpperCase());
    if (!entry || entry.expires < Date.now() || entry.used) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Mark as used immediately (single-use)
    entry.used = true;

    await db.run('UPDATE members SET password=$1 WHERE id=$2',
      [bcrypt.hashSync(new_password, 12), entry.memberId]);

    resetTokens.delete(reset_token.trim().toUpperCase());
    await auditLog(entry.memberId, 'PASSWORD_RESET', entry.memberId, 'Password reset via token');
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch(e) { next(e); }
});

module.exports = router;
