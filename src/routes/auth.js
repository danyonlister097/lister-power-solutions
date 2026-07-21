const express = require('express');
const db = require('../db');
const passwords = require('../lib/passwords');
const logger = require('../lib/logger');
const { homeRoute } = require('../lib/homeRoute');
const { loadPermissions } = require('../middleware/auth');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeRoute(req.user));
  res.render('login', { error: null });
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());

    if (!user || !user.active || !passwords.verify(password || '', user.password_hash)) {
      return res.status(401).render('login', { error: 'Invalid email or password.' });
    }

    // Fetched before regenerate() so homeRoute(user) below always has it -
    // regenerate's callback isn't awaited by express-session, so anything
    // async has to happen before it, not inside it.
    user.permissions = await loadPermissions(user);

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

module.exports = router;
