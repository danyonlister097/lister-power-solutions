const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const passwords = require('../lib/passwords');
const logger = require('../lib/logger');
const { homeRoute } = require('../lib/homeRoute');
const { loadPermissions, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');
const { sendAdminLoginNotification, sendAccountLockedEmail, sendPasswordResetEmail } = require('../lib/email');
const config = require('../config');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 3;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function brisbaneNowLabel() {
  return new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' });
}

// Matches now_utc_text()'s 'YYYY-MM-DD HH24:MI:SS' shape (see schema.sql) -
// every other TEXT timestamp column in this app is compared as a plain
// string, so this has to be the same shape or ordering breaks silently.
function toUtcText(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function createResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = toUtcText(new Date(Date.now() + RESET_TOKEN_TTL_MS));
  await db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, userId);
  return token;
}

function resetUrlFor(token) {
  return `${config.email.appUrl}/reset-password/${token}`;
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeRoute(req.user));
  res.render('login', { error: null });
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());

    if (!user || !user.active) {
      return res.status(401).render('login', { error: 'Invalid email or password.' });
    }

    if (user.locked_at) {
      return res.status(401).render('login', {
        error: 'This account is locked after too many failed login attempts. Check your email for a link to reset your password and unlock it.',
      });
    }

    if (!passwords.verify(password || '', user.password_hash)) {
      const attempts = Number(user.failed_login_attempts) + 1;

      if (attempts >= MAX_FAILED_ATTEMPTS) {
        await db.prepare("UPDATE users SET failed_login_attempts = ?, locked_at = datetime('now') WHERE id = ?").run(attempts, user.id);
        const token = await createResetToken(user.id);
        await sendAccountLockedEmail(user, resetUrlFor(token));
        return res.status(401).render('login', {
          error: 'This account has been locked after 3 failed login attempts. Check your email for a link to reset your password and unlock it.',
        });
      }

      await db.prepare('UPDATE users SET failed_login_attempts = ? WHERE id = ?').run(attempts, user.id);
      return res.status(401).render('login', { error: 'Invalid email or password.' });
    }

    await db.prepare('UPDATE users SET failed_login_attempts = 0 WHERE id = ?').run(user.id);

    // Fetched before regenerate() so homeRoute(user) below always has it -
    // regenerate's callback isn't awaited by express-session, so anything
    // async has to happen before it, not inside it.
    user.permissions = await loadPermissions(user);

    if (user.role === 'admin') {
      sendAdminLoginNotification(user, { time: brisbaneNowLabel(), ip: req.ip }).catch((err) =>
        logger.error('Admin login notification failed', { error: err.message })
      );
    }

    req.session.regenerate((err) => {
      if (err) {
        logger.error('Session regenerate failed', { error: err.message });
        return res.status(500).render('login', { error: 'Something went wrong. Try again.' });
      }
      req.session.userId = user.id;
      logger.info(`User logged in: ${user.email}`);
      res.redirect(homeRoute(user));
    });
  })
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

router.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect(homeRoute(req.user));
  res.render('forgot-password', { sent: false });
});

router.post(
  '/forgot-password',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const user = await db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);

    // Same "we've sent a link" response whether or not the account exists,
    // so this form can't be used to check which emails have accounts.
    if (user) {
      const token = await createResetToken(user.id);
      await sendPasswordResetEmail(user, resetUrlFor(token));
    }

    res.render('forgot-password', { sent: true });
  })
);

router.get(
  '/reset-password/:token',
  asyncHandler(async (req, res) => {
    const user = await db
      .prepare("SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > datetime('now')")
      .get(req.params.token);

    if (!user) {
      return res.render('reset-password', { valid: false, error: null, token: req.params.token });
    }
    res.render('reset-password', { valid: true, error: null, token: req.params.token });
  })
);

router.post(
  '/reset-password/:token',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const user = await db
      .prepare("SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > datetime('now')")
      .get(req.params.token);

    if (!user) {
      return res.render('reset-password', { valid: false, error: null, token: req.params.token });
    }

    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.render('reset-password', { valid: true, error: 'Password must be at least 8 characters.', token: req.params.token });
    }

    await db
      .prepare(
        `UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_at = NULL,
           reset_token = NULL, reset_token_expires = NULL WHERE id = ?`
      )
      .run(passwords.hash(password), user.id);

    setFlash(req, 'success', 'Password updated. You can now log in.');
    res.redirect('/login');
  })
);

module.exports = router;
