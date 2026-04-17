const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('FATAL: JWT_SECRET not set');
  process.exit(1);
}
const _JWT_SECRET = JWT_SECRET || 'wazema_dev_secret_NOT_FOR_PRODUCTION_32chars';

// ── Token blacklist (revoked JTIs) ────────────────────────────────────────
const revokedTokens = new Map(); // jti → expiry ms
setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of revokedTokens) {
    if (exp < now) revokedTokens.delete(jti);
  }
}, 30 * 60 * 1000);

function revokeToken(token) {
  try {
    const decoded = jwt.decode(token);
    if (decoded?.jti && decoded?.exp) {
      revokedTokens.set(decoded.jti, decoded.exp * 1000);
    }
  } catch {}
}

function isRevoked(decoded) {
  if (!decoded?.jti) return false;
  return revokedTokens.has(decoded.jti);
}

// ── Brute-force lockout per identifier ───────────────────────────────────
// Tracks failed login attempts: identifier → { count, lockedUntil }
const loginAttempts = new Map();
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttempts) {
    if (val.lockedUntil && val.lockedUntil < now) loginAttempts.delete(key);
  }
}, 5 * 60 * 1000);

function recordFailedLogin(identifier) {
  const key  = (identifier || '').toLowerCase().trim();
  const now  = Date.now();
  const prev = loginAttempts.get(key) || { count: 0, lockedUntil: null };
  const count = prev.count + 1;
  const lockedUntil = count >= MAX_ATTEMPTS ? now + LOCKOUT_MS : prev.lockedUntil;
  loginAttempts.set(key, { count, lockedUntil });
  return { count, locked: count >= MAX_ATTEMPTS, lockedUntil };
}

function clearLoginAttempts(identifier) {
  loginAttempts.delete((identifier || '').toLowerCase().trim());
}

function isLockedOut(identifier) {
  const key  = (identifier || '').toLowerCase().trim();
  const rec  = loginAttempts.get(key);
  if (!rec || !rec.lockedUntil) return false;
  if (rec.lockedUntil < Date.now()) { loginAttempts.delete(key); return false; }
  return true;
}

function minutesUntilUnlock(identifier) {
  const key = (identifier || '').toLowerCase().trim();
  const rec = loginAttempts.get(key);
  if (!rec?.lockedUntil) return 0;
  return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
}

// ── JWT auth middleware ───────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Authentication required' });
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid authorization format' });
  }
  const token = parts[1];
  try {
    const decoded = jwt.verify(token, _JWT_SECRET, { algorithms: ['HS256'] });
    if (isRevoked(decoded)) return res.status(401).json({ error: 'Session has been revoked. Please log in again.' });
    req.user  = decoded;
    req.token = token;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
}

// ── Role guards ───────────────────────────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  next();
}

function memberOnly(req, res, next) {
  if (req.user?.role !== 'member') {
    return res.status(403).json({ error: 'Member access required' });
  }
  next();
}

// ── Per-user rate limiting ────────────────────────────────────────────────
const userRequestMap = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, ts] of userRequestMap) {
    const filtered = ts.filter(t => t > cutoff);
    if (filtered.length === 0) userRequestMap.delete(k);
    else userRequestMap.set(k, filtered);
  }
}, 60000);

function perUserRateLimit(maxRequests = 60, windowMs = 60000) {
  return (req, res, next) => {
    const userId = req.user?.id || req.ip;
    const now    = Date.now();
    const window = now - windowMs;
    const ts     = (userRequestMap.get(userId) || []).filter(t => t > window);
    if (ts.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    ts.push(now);
    userRequestMap.set(userId, ts);
    next();
  };
}

module.exports = {
  authMiddleware,
  adminOnly,
  memberOnly,
  JWT_SECRET: _JWT_SECRET,
  revokeToken,
  isLockedOut,
  recordFailedLogin,
  clearLoginAttempts,
  minutesUntilUnlock,
  perUserRateLimit,
};
