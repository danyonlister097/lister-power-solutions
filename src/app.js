const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSessionStore = require('connect-pg-simple')(session);
const config = require('./config');
const logger = require('./lib/logger');
const { pool } = require('./db');
const { loadUser, requireAuth, attachCsrf } = require('./middleware/auth');
const { homeRoute } = require('./lib/homeRoute');
const { formatAuDate } = require('./lib/dates');
const { formatMoney } = require('./lib/money');

const app = express();

// Required for secure cookies to work correctly behind Vercel's proxy - it
// terminates TLS in front of the function, so Express only sees the
// X-Forwarded-Proto header, not a directly secure connection.
app.set('trust proxy', 1);

// res.redirect(url) defaults to 302, which is spec-ambiguous about whether
// the follow-up request should keep the original method - real-world HTTP
// clients disagree, and testing this app hit one that replayed a POST's
// body against the redirect target instead of switching to GET: a
// successful "Save employee" edit could come right back around as a second
// POST to the create route with the same data, which is what was landing
// admins back on "New Employee" (sometimes with a stale duplicate-email
// error) instead of the employee list, and is also the likely source of
// the duplicated leave/asset rows. 303 See Other has no such ambiguity -
// every client is required to follow it with GET - so every one of this
// app's ~120 post-action res.redirect(url) call sites gets 303 here
// instead of needing the status passed by hand at each one.
app.use((req, res, next) => {
  const rawRedirect = res.redirect.bind(res);
  res.redirect = (...args) => (args.length === 1 ? rawRedirect(303, args[0]) : rawRedirect(...args));
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: new PgSessionStore({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: config.app.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(loadUser);
app.use(attachCsrf);
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.currentPath = req.path;
  res.locals.formatAuDate = formatAuDate;
  res.locals.formatMoney = formatMoney;
  next();
});

app.use('/', require('./routes/auth'));

app.get('/', (req, res) => res.redirect(homeRoute(req.user)));

app.use('/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/customers', requireAuth, require('./routes/customers'));
app.use('/jobs', requireAuth, require('./routes/jobs'));
app.use('/users', requireAuth, require('./routes/users'));
app.use('/timeclock', requireAuth, require('./routes/timeclock'));
app.use('/leave', requireAuth, require('./routes/leave'));
app.use('/tasks', requireAuth, require('./routes/tasks'));
app.use('/chat/folders', requireAuth, require('./routes/photoFolders'));
app.use('/chat', requireAuth, require('./routes/chat'));
app.use('/forms', requireAuth, require('./routes/forms'));
app.use('/inventory', requireAuth, require('./routes/inventory'));
app.use('/assets', requireAuth, require('./routes/businessAssets'));
app.use('/tools', requireAuth, require('./routes/tools'));
app.use('/quotes', requireAuth, require('./routes/quotes'));
app.use('/invoices', requireAuth, require('./routes/invoices'));

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).render('error', { message: 'Something went wrong.' });
});

module.exports = app;
