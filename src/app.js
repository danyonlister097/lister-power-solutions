const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSessionStore = require('connect-pg-simple')(session);
const config = require('./config');
const logger = require('./lib/logger');
const { pool } = require('./db');
const { loadUser, requirePermission, attachCsrf } = require('./middleware/auth');
const { homeRoute } = require('./lib/homeRoute');
const { formatAuDate } = require('./lib/dates');
const { formatMoney } = require('./lib/money');
const { asyncHandler } = require('./lib/asyncHandler');
const { generateWeeklyTimesheets } = require('./lib/timesheetGen');
const { getUnreadSupplierEmails, getEmailAttachments, markAsRead } = require('./lib/graph');
const { parseCnwInvoice } = require('./lib/cnwParser');

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
  res.locals.homeUrl = homeRoute(req.user);
  next();
});

// Vercel Cron hits this on a schedule (see vercel.json) - it's a machine
// call, not a browser session, so it's checked against CRON_SECRET instead
// of going through login/permissions. Vercel sends the secret as a bearer
// token automatically once CRON_SECRET is set in the project's env vars.
app.get(
  '/api/cron/generate-timesheets',
  asyncHandler(async (req, res) => {
    if (config.app.cronSecret && req.headers.authorization !== `Bearer ${config.app.cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await generateWeeklyTimesheets();
    logger.info('Weekly timesheets generated', result);
    res.json({ ok: true, ...result });
  })
);

app.get(
  '/api/cron/process-invoices',
  asyncHandler(async (req, res) => {
    if (config.app.cronSecret && req.headers.authorization !== `Bearer ${config.app.cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!config.graph.tenantId || !config.graph.clientId || !config.graph.clientSecret || !config.graph.mailbox) {
      return res.json({ ok: true, skipped: 'Graph API not configured' });
    }

    const results = { processed: 0, skipped: 0, errors: [] };

    let emails;
    try {
      emails = await getUnreadSupplierEmails();
    } catch (err) {
      logger.error('Invoice cron: failed to fetch emails', { error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }

    for (const email of emails) {
      try {
        const attachments = await getEmailAttachments(email.id);
        const pdfAttachment = attachments.find(
          (a) => a.contentType === 'application/pdf' || (a.name || '').toLowerCase().endsWith('.pdf')
        );

        if (!pdfAttachment || !pdfAttachment.contentBytes) {
          await markAsRead(email.id);
          results.skipped++;
          continue;
        }

        const pdfBuffer = Buffer.from(pdfAttachment.contentBytes, 'base64');
        const { invoiceNumber, lineItems } = await parseCnwInvoice(pdfBuffer);

        if (!invoiceNumber) {
          logger.warn('Invoice cron: could not extract invoice number', { subject: email.subject });
          await markAsRead(email.id);
          results.skipped++;
          continue;
        }

        // Skip if already imported
        const existing = await db
          .prepare(`SELECT id FROM invoice_imports WHERE invoice_number = ? AND supplier = 'CNW'`)
          .get(invoiceNumber);
        if (existing) {
          await markAsRead(email.id);
          results.skipped++;
          continue;
        }

        let matched = 0;
        let unmatched = 0;

        for (const line of lineItems) {
          if (line.supplied <= 0) continue;

          const item = await db
            .prepare(`SELECT id FROM inventory_items WHERE supplier_code = ?`)
            .get(line.productCode);

          if (item) {
            await db
              .prepare(`UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + ?, unit_cost = ?, updated_at = now_utc_text() WHERE id = ?`)
              .run(line.supplied, line.unitCost, item.id);
            matched++;
          } else {
            unmatched++;
            logger.info('Invoice cron: unmatched product code', { code: line.productCode, description: line.description });
          }
        }

        await db
          .prepare(
            `INSERT INTO invoice_imports (invoice_number, supplier, email_message_id, lines_total, lines_matched, lines_unmatched)
             VALUES (?, 'CNW', ?, ?, ?, ?)`
          )
          .run(invoiceNumber, email.id, lineItems.length, matched, unmatched);

        await markAsRead(email.id);
        results.processed++;
        logger.info('Invoice cron: processed CNW invoice', { invoiceNumber, matched, unmatched });
      } catch (err) {
        logger.error('Invoice cron: error processing email', { subject: email.subject, error: err.message });
        results.errors.push(err.message);
      }
    }

    res.json({ ok: true, ...results });
  })
);

app.use('/', require('./routes/auth'));

app.get('/', (req, res) => res.redirect(homeRoute(req.user)));

// Each mount is gated by the matching employee-permission checkbox rather
// than a hardcoded role - admins always pass (see loadUser); everyone else
// needs the key in req.user.permissions. An unauthenticated request has no
// req.user, so requirePermission's own !req.user check sends it to /login
// before the permission check ever runs.
app.use('/dashboard', requirePermission('dashboard'), require('./routes/dashboard'));
app.use('/customers', requirePermission('customers'), require('./routes/customers'));
app.use('/jobs', requirePermission('jobs'), require('./routes/jobs'));
app.use('/users', requirePermission('employees'), require('./routes/users'));
app.use('/timeclock', requirePermission('timeclock'), require('./routes/timeclock'));
app.use('/leave', requirePermission('leave'), require('./routes/leave'));
app.use('/tasks', requirePermission('tasks'), require('./routes/tasks'));
app.use('/chat/folders', requirePermission('chat'), require('./routes/photoFolders'));
app.use('/chat', requirePermission('chat'), require('./routes/chat'));
app.use('/forms', requirePermission('forms'), require('./routes/forms'));
app.use('/inventory', requirePermission('inventory'), require('./routes/inventory'));
app.use('/assets', requirePermission('assets'), require('./routes/businessAssets'));
app.use('/tools', requirePermission('tools'), require('./routes/tools'));
app.use('/quotes', requirePermission('quotes'), require('./routes/quotes'));
app.use('/invoices', requirePermission('invoices'), require('./routes/invoices'));
app.use('/feedback', requirePermission('feedback'), require('./routes/feedback'));

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).render('error', { message: 'Something went wrong.' });
});

module.exports = app;
