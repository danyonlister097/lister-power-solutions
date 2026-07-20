const crypto = require('crypto');
const db = require('../db');

function loadUser(req, res, next) {
  if (req.session.userId) {
    const user = db
      .prepare('SELECT id, name, email, role, active FROM users WHERE id = ?')
      .get(req.session.userId);
    if (user && user.active) {
      req.user = user;
    } else {
      req.session.destroy(() => {});
    }
  }
  res.locals.currentUser = req.user || null;
  next();
}

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

module.exports = { loadUser, requireAuth, requireRole, attachCsrf, verifyCsrf };
