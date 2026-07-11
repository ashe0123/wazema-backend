/**
 * Financial Security & Data Protection Layer
 * Implements encryption, data masking, and sensitive data protection
 */
require('dotenv').config();
const crypto = require('crypto');

// ── Configuration ─────────────────────────────────────────────────────────────
const ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY;
const ALGORITHM = 'aes-256-gcm';

// Validate encryption key on load
if (ENCRYPTION_KEY && ENCRYPTION_KEY.length < 32) {
  console.error('⚠️  DATA_ENCRYPTION_KEY must be at least 32 characters');
  process.exit(1);
}

// ── Encrypt Sensitive Data ────────────────────────────────────────────────────
function encrypt(plaintext) {
  if (!ENCRYPTION_KEY) {
    throw new Error('DATA_ENCRYPTION_KEY not configured');
  }

  if (!plaintext) return null;

  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plaintext.toString(), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('Encryption error:', error.message);
    throw new Error('Failed to encrypt data');
  }
}

// ── Decrypt Sensitive Data ────────────────────────────────────────────────────
function decrypt(ciphertext) {
  if (!ENCRYPTION_KEY) {
    throw new Error('DATA_ENCRYPTION_KEY not configured');
  }

  if (!ciphertext) return null;

  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const [ivHex, authTagHex, encrypted] = parts;
    
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    throw new Error('Failed to decrypt data');
  }
}

// ── Mask Sensitive Data for Logs ──────────────────────────────────────────────
function maskPhone(phone) {
  if (!phone) return '';
  // +251911234567 → +251***4567
  if (phone.length > 7) {
    return phone.slice(0, -7) + '***' + phone.slice(-4);
  }
  return '***' + phone.slice(-4);
}

function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  // user@example.com → u***@example.com
  return local.charAt(0) + '***@' + domain;
}

function maskBankAccount(account) {
  if (!account) return '';
  // 1234567890123 → ***0123
  if (account.length > 4) {
    return '***' + account.slice(-4);
  }
  return '***';
}

function maskName(name) {
  if (!name) return '';
  const parts = name.split(' ');
  if (parts.length === 1) {
    return name.charAt(0) + '***';
  }
  // Abebe Girma → A*** G***
  return parts.map(p => p.charAt(0) + '***').join(' ');
}

// ── Hash Sensitive Data (One-way) ─────────────────────────────────────────────
function hashData(data) {
  return crypto.createHash('sha256').update(data.toString()).digest('hex');
}

// ── Generate Secure Random Token ──────────────────────────────────────────────
function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// ── Generate Transaction ID ───────────────────────────────────────────────────
function generateTransactionId(prefix = 'TXN') {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

// ── Validate Data Integrity (HMAC) ────────────────────────────────────────────
function signData(data) {
  if (!ENCRYPTION_KEY) {
    throw new Error('DATA_ENCRYPTION_KEY not configured');
  }
  const hmac = crypto.createHmac('sha256', ENCRYPTION_KEY);
  hmac.update(JSON.stringify(data));
  return hmac.digest('hex');
}

function verifyDataSignature(data, signature) {
  const expectedSignature = signData(data);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// ── Sanitize Financial Data ───────────────────────────────────────────────────
function sanitizeAmount(amount) {
  // Remove non-numeric characters except decimal point
  const sanitized = amount.toString().replace(/[^0-9.]/g, '');
  const parsed = parseFloat(sanitized);
  
  if (isNaN(parsed)) {
    throw new Error('Invalid amount format');
  }
  
  // Round to 2 decimal places for financial precision
  return Math.round(parsed * 100) / 100;
}

function validateAmount(amount) {
  const sanitized = sanitizeAmount(amount);
  
  if (sanitized < 0) {
    throw new Error('Amount cannot be negative');
  }
  
  if (sanitized > 999999999.99) {
    throw new Error('Amount exceeds maximum limit');
  }
  
  return sanitized;
}

// ── Audit Trail Helper ────────────────────────────────────────────────────────
function createAuditEntry(actor, action, target, details = {}, sensitiveFields = []) {
  // Mask sensitive fields in details
  const maskedDetails = { ...details };
  
  for (const field of sensitiveFields) {
    if (maskedDetails[field]) {
      if (field.includes('phone')) {
        maskedDetails[field] = maskPhone(maskedDetails[field]);
      } else if (field.includes('email')) {
        maskedDetails[field] = maskEmail(maskedDetails[field]);
      } else if (field.includes('account')) {
        maskedDetails[field] = maskBankAccount(maskedDetails[field]);
      } else {
        maskedDetails[field] = '***';
      }
    }
  }
  
  return {
    actor,
    action,
    target,
    detail: JSON.stringify(maskedDetails),
    timestamp: new Date().toISOString(),
    ip: null, // Should be set by caller
  };
}

// ── PCI-DSS Compliant Card Masking ────────────────────────────────────────────
function maskCardNumber(cardNumber) {
  if (!cardNumber) return '';
  // 1234567890123456 → ************3456
  const cleaned = cardNumber.replace(/\s+/g, '');
  if (cleaned.length < 4) return '****';
  return '*'.repeat(12) + cleaned.slice(-4);
}

// ── Secure Comparison (Timing-Safe) ───────────────────────────────────────────
function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  
  if (a.length !== b.length) {
    return false;
  }
  
  return crypto.timingSafeEqual(
    Buffer.from(a),
    Buffer.from(b)
  );
}

// ── Input Validation for Financial Data ──────────────────────────────────────
function validateFinancialInput(data) {
  const errors = [];
  
  // Validate amount fields
  const amountFields = ['amount', 'monthly_saving', 'share_amount', 'registration_fee'];
  for (const field of amountFields) {
    if (data[field] !== undefined && data[field] !== null) {
      try {
        data[field] = validateAmount(data[field]);
      } catch (error) {
        errors.push(`${field}: ${error.message}`);
      }
    }
  }
  
  // Validate phone numbers
  if (data.phone) {
    const phoneRegex = /^\+?[0-9]{10,15}$/;
    const cleanPhone = data.phone.replace(/[\s\-\(\)]/g, '');
    if (!phoneRegex.test(cleanPhone)) {
      errors.push('Invalid phone number format');
    }
  }
  
  // Validate email
  if (data.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      errors.push('Invalid email format');
    }
  }
  
  // Validate dates
  const dateFields = ['join_date', 'date_of_birth', 'exit_date'];
  for (const field of dateFields) {
    if (data[field]) {
      const date = new Date(data[field]);
      if (isNaN(date.getTime())) {
        errors.push(`${field}: Invalid date format`);
      }
    }
  }
  
  if (errors.length > 0) {
    throw new Error('Validation failed: ' + errors.join(', '));
  }
  
  return data;
}

// ── Check for Suspicious Activity ─────────────────────────────────────────────
const suspiciousActivityLog = new Map();

function checkSuspiciousActivity(userId, action, amount = 0) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  
  if (!suspiciousActivityLog.has(key)) {
    suspiciousActivityLog.set(key, []);
  }
  
  const activities = suspiciousActivityLog.get(key);
  
  // Clean old entries
  const recent = activities.filter(a => now - a.timestamp < windowMs);
  suspiciousActivityLog.set(key, recent);
  
  // Add current activity
  recent.push({ timestamp: now, amount });
  
  // Check for suspicious patterns
  const flags = [];
  
  // Pattern 1: Too many actions in short time
  if (recent.length > 10) {
    flags.push('HIGH_FREQUENCY');
  }
  
  // Pattern 2: Large amount (adjust threshold as needed)
  if (amount > 1000000) {
    flags.push('LARGE_AMOUNT');
  }
  
  // Pattern 3: Rapid amount changes
  if (recent.length > 3) {
    const amounts = recent.map(a => a.amount);
    const variance = Math.max(...amounts) - Math.min(...amounts);
    if (variance > 500000) {
      flags.push('AMOUNT_VARIANCE');
    }
  }
  
  return {
    suspicious: flags.length > 0,
    flags,
    count: recent.length,
  };
}

// ── Clean Suspicious Activity Log (Memory Management) ─────────────────────────
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour
  
  for (const [key, activities] of suspiciousActivityLog.entries()) {
    const recent = activities.filter(a => now - a.timestamp < maxAge);
    if (recent.length === 0) {
      suspiciousActivityLog.delete(key);
    } else {
      suspiciousActivityLog.set(key, recent);
    }
  }
}, 10 * 60 * 1000); // Clean every 10 minutes

// ── Export Functions ──────────────────────────────────────────────────────────
module.exports = {
  // Encryption
  encrypt,
  decrypt,
  
  // Masking
  maskPhone,
  maskEmail,
  maskBankAccount,
  maskName,
  maskCardNumber,
  
  // Hashing
  hashData,
  
  // Token Generation
  generateSecureToken,
  generateTransactionId,
  
  // Data Integrity
  signData,
  verifyDataSignature,
  
  // Financial Validation
  sanitizeAmount,
  validateAmount,
  validateFinancialInput,
  
  // Audit
  createAuditEntry,
  
  // Security
  secureCompare,
  checkSuspiciousActivity,
};
