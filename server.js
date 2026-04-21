require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const crypto    = require('crypto');

const app   = express();
const PORT  = process.env.PORT || 3002;
const isDev = process.env.NODE_ENV !== 'production';

// ── TRUST PROXY (required for Render/Railway/any reverse proxy) ───────────
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);

// ── ENFORCE STRONG JWT SECRET ─────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  if (!isDev) {
    console.error('FATAL: JWT_SECRET must be set and at least 32 characters in production.');
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET is weak or missing. Set a strong secret before deploying.');
}

// ── SECURITY HEADERS ──────────────────────────────────────────────────────
// ⚠️  Issue 4 fix: remove 'unsafe-inline' from scriptSrc in production.
// Next.js frontend handles its own CSP — this is API-only, no inline scripts needed.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   isDev
        ? ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']
        : ["'self'"],                          // no unsafe-inline in production
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: isDev ? [] : [],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permissionsPolicy: {
    features: {
      camera:      ['self'],
      microphone:  [],
      geolocation: [],
    },
  },
}));

// ── CORS ──────────────────────────────────────────────────────────────────
// ⚠️  Issue 2 fix: if CORS_ORIGIN is missing in production, block all
// cross-origin requests instead of falling back to wildcard true.
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : (isDev ? true : []); // dev: allow all; prod without CORS_ORIGIN: block all

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID'],
  credentials: false,
  maxAge: 86400,
}));

// ── REQUEST ID (for audit trail) ──────────────────────────────────────────
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ── SHARED KEY GENERATOR (safe for Render / reverse proxies) ─────────────
// Extracts the real client IP from X-Forwarded-For without crashing.
// Used by ALL rate limiters so behaviour is consistent.
function rateLimitKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ── GLOBAL RATE LIMITING ──────────────────────────────────────────────────
// ⚠️  Issue 1 fix: global limiter skips /api/auth so the tighter authLimiter
// below is the ONLY limiter that counts login attempts — no double-counting.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 2000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => req.path === '/api/health' || req.path.startsWith('/api/auth'),
  keyGenerator: rateLimitKey,
}));

// ── BODY PARSING (strict limits) ──────────────────────────────────────────
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// ── INPUT SANITIZATION (strip XSS from all string fields) ────────────────
const { sanitizeBody } = require('./middleware/validate');
app.use(sanitizeBody);

// ── LOGGING (never log Authorization headers or passwords) ────────────────
morgan.token('id', (req) => req.id);
const logFormat = isDev
  ? ':method :url :status :response-time ms - :id'
  : ':remote-addr - :method :url :status :response-time ms - :id';
app.use(morgan(logFormat, {
  skip: (req) => req.path === '/api/health',
}));

// ── HTTPS REDIRECT (production) ───────────────────────────────────────────
if (!isDev) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

// ── UPLOADS (auth-gated, no directory listing) ────────────────────────────
app.use('/uploads', (req, res, next) => {
  // Require auth token to view uploaded files
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required to view files' });
  }
  next();
}, express.static(path.join(__dirname, 'uploads'), {
  dotfiles: 'deny',
  index: false,
  setHeaders: (res, filePath) => {
    const ext  = path.extname(filePath).toLowerCase();
    const mime = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png',  '.webp': 'image/webp',
      '.pdf': 'application/pdf',
    };
    if (!mime[ext]) { res.status(403).end(); return; }
    res.setHeader('Content-Type', mime[ext]);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// ── API ROUTES ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 500 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
  keyGenerator: rateLimitKey,
});

const sensitiveOpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isDev ? 500 : 30,
  message: { error: 'Too many sensitive operations. Please wait.' },
  keyGenerator: rateLimitKey,
});

app.use('/api/auth',       authLimiter,           require('./routes/auth'));
app.use('/api/members',                           require('./routes/members'));
app.use('/api/savings',                           require('./routes/savings'));
app.use('/api/loans',                             require('./routes/loans'));
app.use('/api/repayments',                        require('./routes/repayments'));
app.use('/api/uploads',    sensitiveOpLimiter,    require('./routes/uploads'));
app.use('/api/settings',                          require('./routes/settings'));
app.use('/api/receipts',                          require('./routes/receipts'));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── BLOCK UNKNOWN API PATHS ───────────────────────────────────────────────
app.use('/api/*', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// ── ROOT ──────────────────────────────────────────────────────────────────
// Frontend is served by Next.js (frontend-next/) — this is API-only
app.get('/', (_req, res) => res.json({
  name: 'Wazema SCBC API',
  version: '2.0.0',
  status: 'running',
  docs: 'See README.md for API documentation',
}));

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  const requestId = req.id || 'unknown';
  // Never leak stack traces or internal details in production
  if (!isDev) {
    console.error(`[ERROR] ${requestId} ${err.message}`);
    return res.status(err.status || 500).json({ error: 'An internal error occurred.', request_id: requestId });
  }
  console.error(`[ERROR] ${requestId}`, err);
  res.status(err.status || 500).json({ error: err.message, request_id: requestId });
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down gracefully');
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  if (!isDev) process.exit(1);
});

app.listen(PORT, async () => {
  console.log(`\n  ✅ WAZEMA API running at http://localhost:${PORT}`);
  console.log(`  📡 API:      http://localhost:${PORT}/api`);
  console.log(`  🌐 Frontend: http://localhost:3000 (Next.js — run: cd frontend-next && npm run dev)`);
  console.log(`  🔒 Mode:     ${isDev ? 'development' : 'PRODUCTION'}\n`);

  // Warn if bank account numbers are still placeholders
  try {
    const db = require('./db');
    const banks = await db.all("SELECT bank_name, account_number FROM payment_banks WHERE is_active=1");
    const placeholders = banks.filter(b => /^[0-9]+0{5,}$/.test(b.account_number));
    if (placeholders.length > 0) {
      console.warn('  ⚠️  IMPORTANT: The following bank accounts have PLACEHOLDER numbers:');
      placeholders.forEach(b => console.warn(`     → ${b.bank_name}: ${b.account_number}`));
      console.warn('     Go to Admin → Settings → 🏦 Banks to update with real account numbers.\n');
    }
  } catch {}
});
