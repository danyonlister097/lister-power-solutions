const axios = require('axios');
const config = require('../config');
const logger = require('../lib/logger');

async function sendEmail({ to, subject, html }) {
  if (!config.email.resendApiKey) {
    logger.warn('Email not sent (RESEND_API_KEY not configured)', { to, subject });
    return;
  }

  try {
    await axios.post(
      'https://api.resend.com/emails',
      { from: config.email.from, to, subject, html },
      { headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error('Failed to send email', { to, subject, error: detail });
  }
}

function wrapEmailBody(title, bodyHtml) {
  return `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1f26;">
      <h2 style="margin: 0 0 16px;">${title}</h2>
      ${bodyHtml}
      <p style="margin-top: 32px; font-size: 12px; color: #6b7280;">Lister Power Solutions</p>
    </div>
  `;
}

async function sendAdminLoginNotification(user, { time, ip }) {
  const html = wrapEmailBody(
    'New login to your admin account',
    `
      <p>Hi ${user.name},</p>
      <p>Your admin account was just logged into at <strong>${time}</strong>${ip ? ` from IP address <strong>${ip}</strong>` : ''}.</p>
      <p>If this was you, no action is needed.</p>
      <p>If this wasn't you, secure your account immediately by resetting your password:</p>
      <p><a href="${config.email.appUrl}/forgot-password" style="color: #12b8a0;">Reset your password</a></p>
    `
  );
  await sendEmail({ to: user.email, subject: 'New login to your Lister Power Solutions admin account', html });
}

async function sendAccountLockedEmail(user, resetUrl) {
  const html = wrapEmailBody(
    'Account locked',
    `
      <p>Hi ${user.name},</p>
      <p>Your account was locked after 3 failed login attempts.</p>
      <p>Click below to reset your password and unlock your account. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}" style="color: #12b8a0;">Reset password and unlock account</a></p>
      <p>If this wasn't you, you can ignore this email - your account will stay locked until the reset link above is used.</p>
    `
  );
  await sendEmail({ to: user.email, subject: 'Your Lister Power Solutions account has been locked', html });
}

async function sendPasswordResetEmail(user, resetUrl) {
  const html = wrapEmailBody(
    'Reset your password',
    `
      <p>Hi ${user.name},</p>
      <p>Click below to set a new password. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}" style="color: #12b8a0;">Reset your password</a></p>
      <p>If you didn't request this, you can ignore this email.</p>
    `
  );
  await sendEmail({ to: user.email, subject: 'Reset your Lister Power Solutions password', html });
}

module.exports = { sendEmail, sendAdminLoginNotification, sendAccountLockedEmail, sendPasswordResetEmail };
