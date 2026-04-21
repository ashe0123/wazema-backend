/**
 * SMS Service - Unified interface for sending SMS notifications
 * Supports: Africa's Talking, Twilio, Generic HTTP Gateway
 */

const SMS_PROVIDER = process.env.SMS_PROVIDER || 'none'; // 'africastalking', 'twilio', 'http', 'none'
const SMS_ENABLED  = process.env.SMS_ENABLED === 'true' || process.env.SMS_ENABLED === '1';

// ── Africa's Talking Configuration ────────────────────────────────────────────
let africastalking = null;
if (SMS_PROVIDER === 'africastalking' && SMS_ENABLED) {
  try {
    const AT = require('africastalking');
    africastalking = AT({
      apiKey: process.env.AFRICASTALKING_API_KEY,
      username: process.env.AFRICASTALKING_USERNAME,
    }).SMS;
    console.log('📱 SMS Service: Africa\'s Talking initialized');
  } catch (e) {
    console.warn('⚠️  Africa\'s Talking not available:', e.message);
  }
}

// ── Twilio Configuration ──────────────────────────────────────────────────────
let twilioClient = null;
if (SMS_PROVIDER === 'twilio' && SMS_ENABLED) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log('📱 SMS Service: Twilio initialized');
  } catch (e) {
    console.warn('⚠️  Twilio not available:', e.message);
  }
}

// ── Generic HTTP Gateway Configuration ────────────────────────────────────────
const HTTP_GATEWAY_URL = process.env.SMS_HTTP_GATEWAY_URL;
const HTTP_GATEWAY_KEY = process.env.SMS_HTTP_GATEWAY_KEY;

// ── Helper: Normalize Ethiopian phone numbers ─────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  // Remove spaces, dashes, parentheses
  let clean = phone.replace(/[\s\-\(\)]/g, '');
  // Convert to international format
  if (clean.startsWith('0')) {
    clean = '+251' + clean.substring(1);
  } else if (clean.startsWith('251')) {
    clean = '+' + clean;
  } else if (!clean.startsWith('+')) {
    clean = '+251' + clean;
  }
  return clean;
}

// ── Main Send Function ────────────────────────────────────────────────────────
async function sendSMS(to, message) {
  if (!SMS_ENABLED) {
    console.log('[SMS] Disabled - would send to', to, ':', message.substring(0, 50) + '...');
    return { success: true, provider: 'disabled', message: 'SMS disabled in config' };
  }

  const phone = normalizePhone(to);
  if (!phone) {
    throw new Error('Invalid phone number');
  }

  try {
    switch (SMS_PROVIDER) {
      case 'africastalking':
        return await sendViaAfricasTalking(phone, message);
      
      case 'twilio':
        return await sendViaTwilio(phone, message);
      
      case 'http':
        return await sendViaHTTP(phone, message);
      
      default:
        console.log('[SMS] No provider configured - would send to', phone, ':', message.substring(0, 50) + '...');
        return { success: true, provider: 'none', message: 'No SMS provider configured' };
    }
  } catch (error) {
    console.error('[SMS] Send failed:', error.message);
    throw error;
  }
}

// ── Africa's Talking Implementation ───────────────────────────────────────────
async function sendViaAfricasTalking(to, message) {
  if (!africastalking) {
    throw new Error('Africa\'s Talking not initialized');
  }

  const result = await africastalking.send({
    to: [to],
    message: message,
    from: process.env.AFRICASTALKING_SENDER_ID || null,
  });

  console.log('[SMS] Africa\'s Talking response:', result);
  
  if (result.SMSMessageData.Recipients[0].status === 'Success') {
    return {
      success: true,
      provider: 'africastalking',
      messageId: result.SMSMessageData.Recipients[0].messageId,
      cost: result.SMSMessageData.Recipients[0].cost,
    };
  } else {
    throw new Error(result.SMSMessageData.Recipients[0].status);
  }
}

// ── Twilio Implementation ─────────────────────────────────────────────────────
async function sendViaTwilio(to, message) {
  if (!twilioClient) {
    throw new Error('Twilio not initialized');
  }

  const result = await twilioClient.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: to,
  });

  console.log('[SMS] Twilio response:', result.sid);
  
  return {
    success: true,
    provider: 'twilio',
    messageId: result.sid,
    status: result.status,
  };
}

// ── Generic HTTP Gateway Implementation ───────────────────────────────────────
async function sendViaHTTP(to, message) {
  if (!HTTP_GATEWAY_URL) {
    throw new Error('HTTP Gateway URL not configured');
  }

  const response = await fetch(HTTP_GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': HTTP_GATEWAY_KEY ? `Bearer ${HTTP_GATEWAY_KEY}` : undefined,
    },
    body: JSON.stringify({
      to: to,
      message: message,
      from: process.env.SMS_SENDER_ID || 'WAZEMA',
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP Gateway error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  console.log('[SMS] HTTP Gateway response:', result);
  
  return {
    success: true,
    provider: 'http',
    response: result,
  };
}

// ── Bulk Send Function ────────────────────────────────────────────────────────
async function sendBulkSMS(recipients) {
  const results = [];
  
  for (const { phone, message, context } of recipients) {
    try {
      const result = await sendSMS(phone, message);
      results.push({ phone, success: true, result, context });
    } catch (error) {
      results.push({ phone, success: false, error: error.message, context });
    }
    
    // Rate limiting: wait 100ms between messages
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

// ── Template Functions ────────────────────────────────────────────────────────

function savingsDueReminder(memberName, amount, dueDay, orgName) {
  return `Hello ${memberName}, this is a reminder from ${orgName}. Your monthly savings of ETB ${amount} is due on day ${dueDay}. Please pay on time to avoid penalties. Thank you!`;
}

function savingsOverdueAlert(memberName, amount, orgName, orgPhone) {
  return `Hello ${memberName}, your savings payment of ETB ${amount} is now OVERDUE. Please pay immediately to avoid additional penalties. Contact: ${orgPhone}. - ${orgName}`;
}

function loanApprovedNotification(memberName, amount, orgName) {
  return `Congratulations ${memberName}! Your loan application for ETB ${amount} has been APPROVED. Visit our office to complete disbursement. - ${orgName}`;
}

function loanRejectedNotification(memberName, reason, orgName) {
  return `Hello ${memberName}, your loan application has been reviewed. Status: Not approved at this time. Reason: ${reason}. Contact us for more information. - ${orgName}`;
}

function repaymentDueReminder(memberName, amount, dueDate, orgName) {
  return `Hello ${memberName}, your loan repayment of ETB ${amount} is due on ${dueDate}. Please pay on time to maintain your good standing. - ${orgName}`;
}

function repaymentOverdueAlert(memberName, amount, penalty, orgName, orgPhone) {
  return `URGENT: ${memberName}, your loan repayment of ETB ${amount} is OVERDUE. Penalty: ETB ${penalty}. Pay immediately. Contact: ${orgPhone}. - ${orgName}`;
}

function passwordResetToken(memberName, token, orgName) {
  return `Hello ${memberName}, your password reset code is: ${token}. This code expires in 30 minutes. Do not share this code. - ${orgName}`;
}

function paymentConfirmed(memberName, amount, month, orgName) {
  return `Hello ${memberName}, your payment of ETB ${amount} for ${month} has been confirmed. Thank you for your timely payment! - ${orgName}`;
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
  sendSMS,
  sendBulkSMS,
  normalizePhone,
  isEnabled: SMS_ENABLED,
  provider: SMS_PROVIDER,
  
  // Templates
  templates: {
    savingsDueReminder,
    savingsOverdueAlert,
    loanApprovedNotification,
    loanRejectedNotification,
    repaymentDueReminder,
    repaymentOverdueAlert,
    passwordResetToken,
    paymentConfirmed,
  },
};
