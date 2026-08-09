const express = require('express');
const axios = require('axios');
const { myob: myobConfig } = require('../config');
const db = require('../db');
const myobClient = require('../lib/myobClient');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { asyncHandler } = require('../lib/asyncHandler');
const { setFlash } = require('../lib/flash');

const router = express.Router();

const AUTH_URL  = 'https://secure.myob.com/oauth2/account/authorize';
const TOKEN_URL = 'https://secure.myob.com/oauth2/v1/authorize/token';

// All MYOB routes are admin-only
router.use(requireRole('admin'));

// ── Settings page ────────────────────────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const stored = await db.prepare('SELECT * FROM myob_tokens ORDER BY id DESC LIMIT 1').get();
    const connected = !!(stored?.refresh_token || myobConfig.refreshToken);
    const lastSync = stored?.updated_at || null;
    const companyFileUri = stored?.company_file_uri || null;

    res.render('myob/index', {
      title: 'MYOB Integration',
      connected,
      lastSync,
      companyFileUri,
      clientConfigured: !!(myobConfig.clientId && myobConfig.clientSecret),
    });
  })
);

// ── OAuth connect ─────────────────────────────────────────────────────────────

router.get('/connect', (req, res) => {
  if (!myobConfig.clientId || !myobConfig.clientSecret) {
    setFlash(req, 'error', 'MYOB_CLIENT_ID and MYOB_CLIENT_SECRET must be set in environment variables before connecting.');
    return res.redirect('/myob');
  }

  const params = new URLSearchParams({
    client_id:    myobConfig.clientId,
    redirect_uri: myobConfig.redirectUri,
    response_type: 'code',
    scope:        'offline_access',
  });

  res.redirect(`${AUTH_URL}?${params}`);
});

// ── OAuth callback ────────────────────────────────────────────────────────────

router.get('/callback', asyncHandler(async (req, res) => {
  const { code } = req.query;
  if (!code) {
    setFlash(req, 'error', 'MYOB authorisation was cancelled or failed.');
    return res.redirect('/myob');
  }

  const params = new URLSearchParams({
    client_id:     myobConfig.clientId,
    client_secret: myobConfig.clientSecret,
    code,
    redirect_uri:  myobConfig.redirectUri,
    grant_type:    'authorization_code',
    scope:         'offline_access',
  });

  const { data } = await axios.post(TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  // Upsert — only ever keep one token row
  const existing = await db.prepare('SELECT id FROM myob_tokens LIMIT 1').get();
  if (existing) {
    await db
      .prepare('UPDATE myob_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, company_file_uri = NULL, company_file_id = NULL, updated_at = now_utc_text() WHERE id = ?')
      .run(data.access_token, data.refresh_token, expiresAt, existing.id);
  } else {
    await db
      .prepare('INSERT INTO myob_tokens (access_token, refresh_token, expires_at) VALUES (?, ?, ?)')
      .run(data.access_token, data.refresh_token, expiresAt);
  }

  // Reset in-memory token cache so the client re-reads from DB
  myobClient._accessToken    = null;
  myobClient._tokenExpiresAt = 0;

  setFlash(req, 'success', 'MYOB connected successfully.');
  res.redirect('/myob');
}));

// ── Disconnect ────────────────────────────────────────────────────────────────

router.post('/disconnect', verifyCsrf, asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM myob_tokens').run();
  myobClient._accessToken    = null;
  myobClient._tokenExpiresAt = 0;
  setFlash(req, 'success', 'MYOB disconnected.');
  res.redirect('/myob');
}));

// ── Sync contacts ─────────────────────────────────────────────────────────────

router.post('/sync-contacts', verifyCsrf, asyncHandler(async (req, res) => {
  const customers = await myobClient.listCustomers();
  let created = 0, updated = 0, skipped = 0;

  for (const mc of customers) {
    const { action } = await myobClient.syncCustomerToLocal(mc);
    if (action === 'created') created++;
    else if (action === 'updated') updated++;
    else skipped++;
  }

  setFlash(req, 'success', `Contacts synced — ${created} added, ${updated} linked, ${skipped} skipped.`);
  res.redirect('/myob');
}));

// ── Push invoice to MYOB ──────────────────────────────────────────────────────

router.post('/push-invoice/:id', verifyCsrf, asyncHandler(async (req, res) => {
  const invoice = await db
    .prepare(
      `SELECT i.*, j.title AS job_title, j.customer_id,
              c.name AS customer_name, c.email AS customer_email,
              c.phone AS customer_phone, c.address_street, c.address_city,
              c.address_state, c.address_postcode, c.address_country,
              c.contact_name, c.myob_customer_uid, c.id AS cust_id
       FROM invoices i
       JOIN jobs j ON j.id = i.job_id
       JOIN customers c ON c.id = j.customer_id
       WHERE i.id = ?`
    )
    .get(req.params.id);

  if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });
  if (invoice.myob_invoice_uid) {
    setFlash(req, 'error', 'This invoice has already been pushed to MYOB.');
    return res.redirect(`/invoices/${invoice.id}`);
  }

  const items = await db
    .prepare('SELECT description, quantity, unit_price FROM invoice_items WHERE invoice_id = ? ORDER BY id')
    .all(invoice.id);

  const sendEmail = req.body.send_email === '1';

  const customer = {
    id:               invoice.cust_id,
    name:             invoice.customer_name,
    email:            invoice.customer_email,
    phone:            invoice.customer_phone,
    address_street:   invoice.address_street,
    address_city:     invoice.address_city,
    address_state:    invoice.address_state,
    address_postcode: invoice.address_postcode,
    address_country:  invoice.address_country,
    contact_name:     invoice.contact_name,
    myob_customer_uid: invoice.myob_customer_uid,
  };

  const myobUid = await myobClient.pushInvoice({ invoice, customer, items, sendEmail });

  await db
    .prepare('UPDATE invoices SET myob_invoice_uid = ?, myob_emailed_at = ?, updated_at = now_utc_text() WHERE id = ?')
    .run(myobUid, sendEmail ? new Date().toISOString() : null, invoice.id);

  const msg = sendEmail
    ? 'Invoice pushed to MYOB and email sent to customer.'
    : 'Invoice pushed to MYOB.';
  setFlash(req, 'success', msg);
  res.redirect(`/invoices/${invoice.id}`);
}));

module.exports = router;
