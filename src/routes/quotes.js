const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');

const router = express.Router();

const CATEGORIES = ['labour', 'material', 'subcontractor', 'travel', 'other'];

function totalFor(quoteId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(quantity * unit_price), 0) AS total FROM quote_items WHERE quote_id = ?')
    .get(quoteId);
  return row.total;
}

function nextQuoteNumber() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM quotes').get();
  return `QT-${String(row.n + 1).padStart(4, '0')}`;
}

router.use(requireRole('admin'));

router.get('/', (req, res) => {
  const status = req.query.status || '';
  let sql = `
    SELECT quotes.*, customers.name AS customer_name,
      COALESCE((SELECT SUM(quantity * unit_price) FROM quote_items WHERE quote_items.quote_id = quotes.id), 0) AS total
    FROM quotes
    JOIN customers ON customers.id = quotes.customer_id
    WHERE 1 = 1
  `;
  const params = [];
  if (status) {
    sql += ' AND quotes.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY quotes.created_at DESC';

  const quotes = db.prepare(sql).all(...params);
  const customers = db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();
  res.render('quotes/index', { title: 'Quotes', quotes, status, customers });
});

router.post('/', verifyCsrf, (req, res) => {
  const b = req.body;
  if (!b.customer_id || !b.title || !b.title.trim()) {
    setFlash(req, 'error', 'Customer and title are required.');
    return res.redirect('/quotes');
  }

  const result = db
    .prepare('INSERT INTO quotes (quote_number, customer_id, title, notes, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(nextQuoteNumber(), b.customer_id, b.title.trim(), b.notes || null, req.user.id);

  setFlash(req, 'success', 'Quote created. Add line items below.');
  res.redirect(`/quotes/${result.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const quote = db
    .prepare(
      `SELECT quotes.*, customers.name AS customer_name, customers.email AS customer_email,
         jobs.title AS job_title
       FROM quotes
       JOIN customers ON customers.id = quotes.customer_id
       LEFT JOIN jobs ON jobs.id = quotes.job_id
       WHERE quotes.id = ?`
    )
    .get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });

  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id').all(quote.id);

  res.render('quotes/show', { title: quote.quote_number, quote, items, total: totalFor(quote.id), CATEGORIES, error: null });
});

router.post('/:id', verifyCsrf, (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });

  const title = (req.body.title || '').trim();
  if (!title) {
    setFlash(req, 'error', 'Title is required.');
    return res.redirect(`/quotes/${quote.id}`);
  }

  db.prepare("UPDATE quotes SET title = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(
    title,
    req.body.notes || null,
    quote.id
  );

  setFlash(req, 'success', 'Quote updated.');
  res.redirect(`/quotes/${quote.id}`);
});

router.post('/:id/items', verifyCsrf, (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });
  if (quote.status !== 'draft' && quote.status !== 'sent') {
    setFlash(req, 'error', 'This quote has already been decided and can no longer be changed.');
    return res.redirect(`/quotes/${quote.id}`);
  }

  const description = (req.body.description || '').trim();
  const quantity = Number.parseFloat(req.body.quantity);
  const unitPrice = Number.parseFloat(req.body.unit_price);

  if (!description || !Number.isFinite(quantity) || !Number.isFinite(unitPrice)) {
    setFlash(req, 'error', 'Please fill in the item description, quantity and unit price.');
    return res.redirect(`/quotes/${quote.id}`);
  }

  db.prepare(
    'INSERT INTO quote_items (quote_id, category, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)'
  ).run(quote.id, CATEGORIES.includes(req.body.category) ? req.body.category : 'other', description, quantity, unitPrice);

  setFlash(req, 'success', 'Item added.');
  res.redirect(`/quotes/${quote.id}`);
});

router.post('/:id/items/:itemId/delete', verifyCsrf, (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });
  if (quote.status !== 'draft' && quote.status !== 'sent') {
    setFlash(req, 'error', 'This quote has already been decided and can no longer be changed.');
    return res.redirect(`/quotes/${quote.id}`);
  }

  const item = db.prepare('SELECT * FROM quote_items WHERE id = ? AND quote_id = ?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).render('error', { message: 'Item not found.' });

  db.prepare('DELETE FROM quote_items WHERE id = ?').run(item.id);
  setFlash(req, 'success', 'Item removed.');
  res.redirect(`/quotes/${req.params.id}`);
});

router.post('/:id/send', verifyCsrf, (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });
  if (quote.status !== 'draft') {
    setFlash(req, 'error', 'Only a draft quote can be marked as sent.');
    return res.redirect(`/quotes/${quote.id}`);
  }

  db.prepare("UPDATE quotes SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(
    quote.id
  );
  setFlash(req, 'success', 'Quote marked as sent.');
  res.redirect(`/quotes/${quote.id}`);
});

// Accepting a quote creates the job it was for, carrying the quote's total
// across as the job's quoted amount so Job Costing's profit figure lines up
// with what was actually quoted to the customer.
router.post('/:id/accept', verifyCsrf, (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });
  if (quote.status !== 'draft' && quote.status !== 'sent') {
    setFlash(req, 'error', 'This quote has already been decided.');
    return res.redirect(`/quotes/${quote.id}`);
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  const total = totalFor(quote.id);

  const result = db
    .prepare(
      `INSERT INTO jobs
        (customer_id, title, description, status, notes, quote_id,
         site_address_street, site_address_city, site_address_state, site_address_postcode, created_by)
       VALUES (?, ?, NULL, 'unscheduled', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      quote.customer_id,
      quote.title,
      quote.notes || null,
      quote.id,
      customer.address_street || null,
      customer.address_city || null,
      customer.address_state || null,
      customer.address_postcode || null,
      req.user.id
    );

  db.prepare('INSERT INTO job_costs (job_id, quoted_amount) VALUES (?, ?)').run(result.lastInsertRowid, total);

  db.prepare(
    "UPDATE quotes SET status = 'accepted', job_id = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(result.lastInsertRowid, quote.id);

  setFlash(req, 'success', `Quote accepted - job "${quote.title}" created.`);
  res.redirect(`/jobs/${result.lastInsertRowid}`);
});

router.post('/:id/decline', verifyCsrf, (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });
  if (quote.status !== 'draft' && quote.status !== 'sent') {
    setFlash(req, 'error', 'This quote has already been decided.');
    return res.redirect(`/quotes/${quote.id}`);
  }

  db.prepare("UPDATE quotes SET status = 'declined', decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(
    quote.id
  );
  setFlash(req, 'success', 'Quote marked as declined.');
  res.redirect(`/quotes/${quote.id}`);
});

router.post('/:id/delete', verifyCsrf, (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });
  if (quote.status !== 'draft') {
    setFlash(req, 'error', 'Only a draft quote can be deleted.');
    return res.redirect(`/quotes/${quote.id}`);
  }

  db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(quote.id);
  db.prepare('DELETE FROM quotes WHERE id = ?').run(quote.id);
  setFlash(req, 'success', 'Quote deleted.');
  res.redirect('/quotes');
});

router.get('/:id/print', (req, res) => {
  const quote = db
    .prepare(
      `SELECT quotes.*, customers.name AS customer_name, customers.email AS customer_email,
         customers.phone AS customer_phone,
         customers.address_street, customers.address_city, customers.address_state, customers.address_postcode
       FROM quotes JOIN customers ON customers.id = quotes.customer_id
       WHERE quotes.id = ?`
    )
    .get(req.params.id);
  if (!quote) return res.status(404).render('error', { message: 'Quote not found.' });

  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id').all(quote.id);

  const total = totalFor(quote.id);
  res.render('quotes/print', { title: `Quote - ${quote.title}`, quote, items, total, subtotal: total / 1.1, gst: total - total / 1.1 });
});

module.exports = router;
