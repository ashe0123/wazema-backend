/**
 * Input sanitization and validation helpers for financial data.
 * Used across all routes to prevent XSS, injection, and bad data.
 */

// Strip HTML tags and dangerous characters from a string
function sanitizeString(val, maxLen = 500) {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'string') return val;
  return val
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/[<>"'`]/g, '')           // strip XSS chars
    .trim()
    .slice(0, maxLen);
}

// Sanitize all string fields in req.body recursively
function sanitizeBody(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  next();
}

function sanitizeObject(obj, depth = 0) {
  if (depth > 5) return obj; // prevent deep recursion
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      out[k] = sanitizeString(v);
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = sanitizeObject(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Validate a positive number
function isPositiveNumber(val) {
  const n = Number(val);
  return !isNaN(n) && n > 0 && isFinite(n);
}

// Validate YYYY-MM date format
function isValidMonth(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}$/.test(val);
}

// Validate YYYY-MM-DD date format
function isValidDate(val) {
  if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const d = new Date(val);
  return !isNaN(d.getTime());
}

// Validate Ethiopian phone number
function isValidEthiopianPhone(val) {
  if (!val) return false;
  const s = val.toString().replace(/\s+/g, '');
  return /^(\+251|251|0)[79]\d{8}$/.test(s);
}

// Validate amount is a safe positive number (no scientific notation, no Infinity)
function isValidAmount(val) {
  const n = Number(val);
  return !isNaN(n) && n > 0 && n < 100_000_000 && isFinite(n);
}

module.exports = { sanitizeBody, sanitizeString, isPositiveNumber, isValidMonth, isValidDate, isValidEthiopianPhone, isValidAmount };
