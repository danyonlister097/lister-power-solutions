const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteSessionStore = require('./lib/sqliteSessionStore');
const config = require('./config');
const logger = require('./lib/logger');
const { loadUser, requireAuth, attachCsrf } = require('./middleware/auth');
const { homeRoute } = require('./lib/homeRoute');
const { formatAuDate } = require('./lib/dates');
const { formatMoney } = require('./lib/money');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: new SqliteSessionStore(),
    secret: config.app.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
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
