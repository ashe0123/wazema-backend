/**
 * Comprehensive input validators for all routes
 * Provides validation for members, savings, loans, repayments, and settings
 */

const { isValidMonth, isValidDate, isValidEthiopianPhone, isValidAmount, sanitizeString } = require('./validate');

// ══════════════════════════════════════════════════════════════════════════════
// MEMBER VALIDATORS
// ══════════════════════════════════════════════════════════════════════════════

function validateMemberRegistration(data) {
  const errors = [];
  
  // Member ID validation
  if (!data.id || typeof data.id !== 'string') {
    errors.push('Member ID is required');
  } else if (!/^WZ-\d{3,6}$/.test(data.id.trim())) {
    errors.push('Member ID must be in format WZ-001, WZ-002, etc.');
  }
  
  // Name validation (only letters - English and Amharic)
  const nameRegex = /^[a-zA-Z\s\u1200-\u137F]+$/;
  
  if (!data.name || typeof data.name !== 'string' || data.name.trim().length < 2) {
    errors.push('Name is required (minimum 2 characters)');
  } else if (!nameRegex.test(data.name.trim())) {
    errors.push('Name can only contain letters (English or Amharic characters)');
  } else if (data.name.trim().length > 100) {
    errors.push('Name is too long (maximum 100 characters)');
  }
  
  // First, Middle, Last name validation
  if (data.first_name && !nameRegex.test(data.first_name.trim())) {
    errors.push('First name can only contain letters (no numbers or special characters)');
  }
  if (data.middle_name && !nameRegex.test(data.middle_name.trim())) {
    errors.push('Middle name can only contain letters (no numbers or special characters)');
  }
  if (data.last_name && !nameRegex.test(data.last_name.trim())) {
    errors.push('Last name can only contain letters (no numbers or special characters)');
  }
  
  // Phone validation
  if (!data.phone) {
    errors.push('Phone number is required');
  } else if (!isValidEthiopianPhone(data.phone)) {
    errors.push('Phone must be valid Ethiopian number (e.g., 0911234567, +251911234567)');
  }
  
  // Join date validation
  if (!data.join_date) {
    errors.push('Join date is required');
  } else if (!isValidDate(data.join_date)) {
    errors.push('Join date must be valid date (YYYY-MM-DD)');
  }
  
  // Monthly saving validation
  if (data.monthly_saving === undefined || data.monthly_saving === null || data.monthly_saving === '') {
    errors.push('Monthly saving amount is required');
  } else if (!isValidAmount(data.monthly_saving)) {
    errors.push('Monthly saving must be a positive number (max 100,000,000 ETB)');
  } else if (Number(data.monthly_saving) < 10) {
    errors.push('Monthly saving must be at least 10 ETB');
  }
  
  // Account type validation
  if (!data.account_type || !['standard', 'premium', 'basic'].includes(data.account_type.toLowerCase())) {
    errors.push('Account type must be: standard, premium, or basic');
  }
  
  // Password validation
  if (!data.password || typeof data.password !== 'string') {
    errors.push('Password is required');
  } else if (data.password.length < 4) {
    errors.push('Password must be at least 4 characters');
  } else if (data.password.length > 100) {
    errors.push('Password is too long (maximum 100 characters)');
  }
  
  // Optional: Saving interest percentage validation
  if (data.saving_interest_pct !== undefined && data.saving_interest_pct !== null) {
    const rate = Number(data.saving_interest_pct);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      errors.push('Saving interest percentage must be between 0 and 100');
    }
  }
  
  return errors;
}

function validateMemberUpdate(data) {
  const errors = [];
  
  // Name validation (if provided)
  if (data.name !== undefined) {
    if (typeof data.name !== 'string' || data.name.trim().length < 2) {
      errors.push('Name must be at least 2 characters');
    } else if (data.name.trim().length > 100) {
      errors.push('Name is too long (maximum 100 characters)');
    }
  }
  
  // Phone validation (if provided)
  if (data.phone !== undefined && !isValidEthiopianPhone(data.phone)) {
    errors.push('Phone must be valid Ethiopian number');
  }
  
  // Monthly saving validation (if provided)
  if (data.monthly_saving !== undefined) {
    if (!isValidAmount(data.monthly_saving) || Number(data.monthly_saving) < 10) {
      errors.push('Monthly saving must be at least 10 ETB');
    }
  }
  
  // Status validation (if provided)
  if (data.status !== undefined && !['active', 'inactive', 'suspended'].includes(data.status)) {
    errors.push('Status must be: active, inactive, or suspended');
  }
  
  return errors;
}

// ══════════════════════════════════════════════════════════════════════════════
// SAVINGS VALIDATORS
// ══════════════════════════════════════════════════════════════════════════════

function validateSavingPayment(data) {
  const errors = [];
  
  // Month validation
  if (!data.month) {
    errors.push('Month is required');
  } else if (!isValidMonth(data.month)) {
    errors.push('Month must be in format YYYY-MM (e.g., 2026-07)');
  }
  
  // Amount validation
  if (data.amount === undefined || data.amount === null || data.amount === '') {
    errors.push('Amount is required');
  } else if (!isValidAmount(data.amount)) {
    errors.push('Amount must be a positive number (max 100,000,000 ETB)');
  } else if (Number(data.amount) < 1) {
    errors.push('Amount must be at least 1 ETB');
  }
  
  // Paid date validation
  if (!data.paid_date) {
    errors.push('Paid date is required');
  } else if (!isValidDate(data.paid_date)) {
    errors.push('Paid date must be valid date (YYYY-MM-DD)');
  }
  
  // Bank details validation (if provided)
  if (data.bank_name && typeof data.bank_name === 'string') {
    if (data.bank_name.trim().length > 100) {
      errors.push('Bank name is too long (maximum 100 characters)');
    }
  }
  
  if (data.account_number && typeof data.account_number === 'string') {
    if (data.account_number.trim().length > 50) {
      errors.push('Account number is too long (maximum 50 characters)');
    }
  }
  
  // Penalty validation (if provided)
  if (data.penalty !== undefined && data.penalty !== null) {
    const pen = Number(data.penalty);
    if (isNaN(pen) || pen < 0 || pen > 100000) {
      errors.push('Penalty must be between 0 and 100,000 ETB');
    }
  }
  
  return errors;
}

// ══════════════════════════════════════════════════════════════════════════════
// LOAN VALIDATORS
// ══════════════════════════════════════════════════════════════════════════════

function validateLoanApplication(data) {
  const errors = [];
  
  // Amount validation
  if (data.amount === undefined || data.amount === null || data.amount === '') {
    errors.push('Loan amount is required');
  } else if (!isValidAmount(data.amount)) {
    errors.push('Loan amount must be a positive number (max 100,000,000 ETB)');
  } else if (Number(data.amount) < 100) {
    errors.push('Loan amount must be at least 100 ETB');
  }
  
  // Interest rate validation
  if (data.interest_rate === undefined || data.interest_rate === null || data.interest_rate === '') {
    errors.push('Interest rate is required');
  } else {
    const rate = Number(data.interest_rate);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      errors.push('Interest rate must be between 0 and 100%');
    }
  }
  
  // Duration validation
  if (data.duration_months === undefined || data.duration_months === null || data.duration_months === '') {
    errors.push('Loan duration is required');
  } else {
    const dur = Number(data.duration_months);
    if (isNaN(dur) || !Number.isInteger(dur) || dur < 1 || dur > 360) {
      errors.push('Duration must be between 1 and 360 months');
    }
  }
  
  // Purpose validation
  if (!data.purpose || typeof data.purpose !== 'string') {
    errors.push('Loan purpose is required');
  } else if (data.purpose.trim().length < 10) {
    errors.push('Loan purpose must be at least 10 characters');
  } else if (data.purpose.trim().length > 500) {
    errors.push('Loan purpose is too long (maximum 500 characters)');
  }
  
  // Apply date validation (if provided)
  if (data.apply_date && !isValidDate(data.apply_date)) {
    errors.push('Apply date must be valid date (YYYY-MM-DD)');
  }
  
  return errors;
}

function validateLoanApproval(data) {
  const errors = [];
  
  // Status validation
  if (!data.status || !['approved', 'rejected'].includes(data.status)) {
    errors.push('Status must be either approved or rejected');
  }
  
  // Approval date validation
  if (data.approve_date && !isValidDate(data.approve_date)) {
    errors.push('Approval date must be valid date (YYYY-MM-DD)');
  }
  
  // First payment month validation
  if (data.first_payment_month && !isValidMonth(data.first_payment_month)) {
    errors.push('First payment month must be in format YYYY-MM');
  }
  
  return errors;
}

// ══════════════════════════════════════════════════════════════════════════════
// REPAYMENT VALIDATORS
// ══════════════════════════════════════════════════════════════════════════════

function validateRepayment(data) {
  const errors = [];
  
  // Amount validation
  if (data.amount === undefined || data.amount === null || data.amount === '') {
    errors.push('Repayment amount is required');
  } else if (!isValidAmount(data.amount)) {
    errors.push('Amount must be a positive number (max 100,000,000 ETB)');
  } else if (Number(data.amount) < 1) {
    errors.push('Amount must be at least 1 ETB');
  }
  
  // Paid date validation
  if (!data.paid_date) {
    errors.push('Paid date is required');
  } else if (!isValidDate(data.paid_date)) {
    errors.push('Paid date must be valid date (YYYY-MM-DD)');
  }
  
  // Bank details validation (if provided)
  if (data.bank_name && typeof data.bank_name === 'string' && data.bank_name.trim().length > 100) {
    errors.push('Bank name is too long (maximum 100 characters)');
  }
  
  if (data.account_number && typeof data.account_number === 'string' && data.account_number.trim().length > 50) {
    errors.push('Account number is too long (maximum 50 characters)');
  }
  
  return errors;
}

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS VALIDATORS
// ══════════════════════════════════════════════════════════════════════════════

function validateBankAccount(data) {
  const errors = [];
  
  // Bank name validation
  if (!data.bank_name || typeof data.bank_name !== 'string') {
    errors.push('Bank name is required');
  } else if (data.bank_name.trim().length < 3) {
    errors.push('Bank name must be at least 3 characters');
  } else if (data.bank_name.trim().length > 100) {
    errors.push('Bank name is too long (maximum 100 characters)');
  }
  
  // Account number validation
  if (!data.account_number || typeof data.account_number !== 'string') {
    errors.push('Account number is required');
  } else if (data.account_number.trim().length < 5) {
    errors.push('Account number must be at least 5 characters');
  } else if (data.account_number.trim().length > 50) {
    errors.push('Account number is too long (maximum 50 characters)');
  }
  
  // Account holder validation
  if (!data.account_holder || typeof data.account_holder !== 'string') {
    errors.push('Account holder name is required');
  } else if (data.account_holder.trim().length < 2) {
    errors.push('Account holder name must be at least 2 characters');
  } else if (data.account_holder.trim().length > 100) {
    errors.push('Account holder name is too long (maximum 100 characters)');
  }
  
  // Status validation (if provided)
  if (data.status !== undefined && !['active', 'inactive'].includes(data.status)) {
    errors.push('Status must be either active or inactive');
  }
  
  return errors;
}

function validateAnnouncement(data) {
  const errors = [];
  
  // Title validation
  if (!data.title || typeof data.title !== 'string') {
    errors.push('Title is required');
  } else if (data.title.trim().length < 3) {
    errors.push('Title must be at least 3 characters');
  } else if (data.title.trim().length > 200) {
    errors.push('Title is too long (maximum 200 characters)');
  }
  
  // Body validation
  if (!data.body || typeof data.body !== 'string') {
    errors.push('Message body is required');
  } else if (data.body.trim().length < 10) {
    errors.push('Message must be at least 10 characters');
  } else if (data.body.trim().length > 2000) {
    errors.push('Message is too long (maximum 2000 characters)');
  }
  
  // Priority validation (if provided)
  if (data.priority !== undefined && !['normal', 'important', 'urgent'].includes(data.priority)) {
    errors.push('Priority must be: normal, important, or urgent');
  }
  
  return errors;
}

function validatePasswordChange(data) {
  const errors = [];
  
  // Current password validation
  if (!data.current_password || typeof data.current_password !== 'string') {
    errors.push('Current password is required');
  }
  
  // New password validation
  if (!data.new_password || typeof data.new_password !== 'string') {
    errors.push('New password is required');
  } else if (data.new_password.length < 6) {
    errors.push('New password must be at least 6 characters');
  } else if (data.new_password.length > 100) {
    errors.push('New password is too long (maximum 100 characters)');
  } else if (data.new_password === data.current_password) {
    errors.push('New password must be different from current password');
  }
  
  return errors;
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

// Validate pagination parameters
function validatePagination(query) {
  const errors = [];
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || 50;
  
  if (page < 1) errors.push('Page must be at least 1');
  if (page > 10000) errors.push('Page number too large (maximum 10000)');
  if (limit < 1) errors.push('Limit must be at least 1');
  if (limit > 500) errors.push('Limit too large (maximum 500 records per page)');
  
  return { errors, page, limit };
}

// Validate ID format (for member_id, loan_id, etc.)
function validateId(id, prefix = '') {
  if (!id || typeof id !== 'string') return false;
  if (prefix && !id.startsWith(prefix)) return false;
  return id.trim().length > 0 && id.trim().length <= 50;
}

// Validate name (only letters - English and Amharic)
function validateName(name) {
  if (!name || typeof name !== 'string') return false;
  const nameRegex = /^[a-zA-Z\s\u1200-\u137F]+$/;
  return nameRegex.test(name.trim()) && name.trim().length >= 2 && name.trim().length <= 100;
}

// Validate age
function validateAge(age) {
  const num = Number(age);
  return !isNaN(num) && num >= 0 && num <= 150 && Number.isInteger(num);
}

// Validate email
function validateEmail(email) {
  if (!email) return true; // Email is optional
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Member validators
  validateMemberRegistration,
  validateMemberUpdate,
  
  // Savings validators
  validateSavingPayment,
  
  // Loan validators
  validateLoanApplication,
  validateLoanApproval,
  
  // Repayment validators
  validateRepayment,
  
  // Settings validators
  validateBankAccount,
  validateAnnouncement,
  validatePasswordChange,
  
  // Helper validators
  validatePagination,
  validateId,
  validateName,
  validateAge,
  validateEmail,
};
