const crypto = require('crypto');
const db = require('../db');
const { asyncHandler } = require('../lib/asyncHandler');
const { PERMISSION_KEYS } = require('../lib/permissions');

// Admins always have full access - the checkboxes on the employee form only
// ever constrain trade/apprentice, so there's nothing to look up for an
// admin and no way for one to lock themselves out.
async function loadPermissions(user) {
  if (user.role === 'admin') return PERMISSION_KEYS;
  const rows = await db.prepare('SELECT permission_key FROM user_permissions WHERE user_id = ?').all(user.id);
  return rows.map((r) => r.permission_key);
}

const loadUser = asyncHandler(async (req, res, next) => {
  if (req.session.userId) {
    const user = await db
      .prepare('SELECT id, name, email, role, active FROM users WHERE id = ?')
      .get(req.session.userId);
    if (user && user.active) {
      req.user = user;
      user.permissions = await loadPermissions(user);
    } else {
      req.session.destroy(() => {});
    }
  }
  res.locals.currentUser = req.user || null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }
    next();
  };
}

// Gates a whole page/section by the employee-permission checkboxes instead
// of a hardcoded role. Admins pass unconditionally (see loadUser above);
// anyone else needs the key in their req.user.permissions.
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!req.user.permissions.includes(key)) {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }
    next();
  };
}

function issueCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function attachCsrf(req, res, next) {
  res.locals.csrfToken = issueCsrfToken(req);
  next();
}

function verifyCsrf(req, res, next) {
  const token = req.body && req.body._csrf;
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).render('error', { message: 'Invalid or expired form submission. Please try again.' });
  }
  next();
}

module.exports = { loadUser, loadPermissions, requireAuth, requireRole, requirePermission, attachCsrf, verifyCsrf };
