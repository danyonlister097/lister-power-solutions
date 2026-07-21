const express = require('express');
const db = require('../db');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

const CATEGORIES = ['labour', 'material', 'subcontractor', 'travel', 'other'];

async function totalFor(invoiceId) {
  const row = await db
    .prepare('SELECT COALESCE(SUM(quantity * unit_price), 0) AS total FROM invoice_items WHERE invoice_id = ?')
    .get(invoiceId);
  return row.total;
}

// 'overdue' is a display state, not something set by hand - a sent invoice
// past its due date reads as overdue everywhere without a separate action
// or background job to keep it in sync.
function effectiveStatus(invoice) {
  if (invoice.status === 'sent' && invoice.due_date && invoice.due_date < new Date().toISOString().slice(0, 10)) {
    return 'overdue';
  }
  return invoice.status;
}

async function nextInvoiceNumber() {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM invoices').get();
  return `INV-${String(row.n + 1).padStart(4, '0')}`;
}

// Gated at the mount point in app.js by the "invoices" permission instead
// of a hardcoded role.

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status || '';
    const sql = `
      SELECT invoices.*, jobs.title AS job_title, customers.name AS customer_name,
        COALESCE((SELECT SUM(quantity * unit_price) FROM invoice_items WHERE invoice_items.invoice_id = invoices.id), 0) AS total
      FROM invoices
      JOIN jobs ON jobs.id = invoices.job_id
      JOIN customers ON customers.id = jobs.customer_id
      ORDER BY invoices.created_at DESC
    `;
    let invoices = (await db.prepare(sql).all()).map((inv) => ({ ...inv, effective_status: effectiveStatus(inv) }));
    if (status) invoices = invoices.filter((inv) => inv.effective_status === status);

    const jobs = await db
      .prepare(
        `SELECT jobs.id, jobs.title, customers.name AS customer_name
         FROM jobs JOIN customers ON customers.id = jobs.customer_id
         ORDER BY jobs.updated_at DESC LIMIT 200`
      )
      .all();

    res.render('invoices/index', { title: 'Invoices', invoices, status, jobs });
  })
);

router.post(
  '/',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.body.job_id);
    if (!job) {
      setFlash(req, 'error', 'Please choose a job to invoice.');
      return res.redirect('/invoices');
    }

    const today = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await db
      .prepare('INSERT INTO invoices (job_id, invoice_number, issue_date, due_date, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .run(job.id, await nextInvoiceNumber(), today, dueDate, req.user.id);

    const costItems = await db.prepare('SELECT * FROM job_cost_items WHERE job_id = ? ORDER BY created_at ASC').all(job.id);
    const insertItem = db.prepare('INSERT INTO invoice_items (invoice_id, category, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)');
    for (const i of costItems) {
      await insertItem.run(result.lastInsertRowid, i.category, i.description, i.quantity, i.unit_cost);
    }

    setFlash(req, 'success', `Invoice created${costItems.length ? ' - job cost items copied across as a starting point.' : '.'}`);
    res.redirect(`/invoices/${result.lastInsertRowid}`);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const invoice = await db
      .prepare(
        `SELECT invoices.*, jobs.title AS job_title, customers.name AS customer_name, customers.email AS customer_email
         FROM invoices
         JOIN jobs ON jobs.id = invoices.job_id
         JOIN customers ON customers.id = jobs.customer_id
         WHERE invoices.id = ?`
      )
      .get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });

    const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoice.id);

    res.render('invoices/show', {
      title: invoice.invoice_number,
      invoice,
      effectiveStatus: effectiveStatus(invoice),
      items,
      total: await totalFor(invoice.id),
      CATEGORIES,
    });
  })
);

router.post(
  '/:id',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });

    await db
      .prepare("UPDATE invoices SET issue_date = ?, due_date = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
      .run(req.body.issue_date || invoice.issue_date, req.body.due_date || null, req.body.notes || null, invoice.id);

    setFlash(req, 'success', 'Invoice updated.');
    res.redirect(`/invoices/${invoice.id}`);
  })
);

router.post(
  '/:id/items',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });
    if (invoice.status !== 'draft' && invoice.status !== 'sent') {
      setFlash(req, 'error', 'Paid or cancelled invoices can no longer be changed.');
      return res.redirect(`/invoices/${invoice.id}`);
    }

    const description = (req.body.description || '').trim();
    const quantity = Number.parseFloat(req.body.quantity);
    const unitPrice = Number.parseFloat(req.body.unit_price);

    if (!description || !Number.isFinite(quantity) || !Number.isFinite(unitPrice)) {
      setFlash(req, 'error', 'Please fill in the item description, quantity and unit price.');
      return res.redirect(`/invoices/${invoice.id}`);
    }

    await db
      .prepare('INSERT INTO invoice_items (invoice_id, category, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)')
      .run(invoice.id, CATEGORIES.includes(req.body.category) ? req.body.category : 'other', description, quantity, unitPrice);

    setFlash(req, 'success', 'Item added.');
    res.redirect(`/invoices/${invoice.id}`);
  })
);

router.post(
  '/:id/items/:itemId/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });
    if (invoice.status !== 'draft' && invoice.status !== 'sent') {
      setFlash(req, 'error', 'Paid or cancelled invoices can no longer be changed.');
      return res.redirect(`/invoices/${invoice.id}`);
    }

    const item = await db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?').get(req.params.itemId, req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Item not found.' });

    await db.prepare('DELETE FROM invoice_items WHERE id = ?').run(item.id);
    setFlash(req, 'success', 'Item removed.');
    res.redirect(`/invoices/${req.params.id}`);
  })
);

router.post(
  '/:id/send',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });
    if (invoice.status !== 'draft') {
      setFlash(req, 'error', 'Only a draft invoice can be marked as sent.');
      return res.redirect(`/invoices/${invoice.id}`);
    }

    await db.prepare("UPDATE invoices SET status = 'sent', updated_at = datetime('now') WHERE id = ?").run(invoice.id);
    setFlash(req, 'success', 'Invoice marked as sent.');
    res.redirect(`/invoices/${invoice.id}`);
  })
);

router.post(
  '/:id/paid',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });
    if (invoice.status !== 'sent') {
      setFlash(req, 'error', 'Only a sent (or overdue) invoice can be marked as paid.');
      return res.redirect(`/invoices/${invoice.id}`);
    }

    await db
      .prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(invoice.id);
    setFlash(req, 'success', 'Invoice marked as paid.');
    res.redirect(`/invoices/${invoice.id}`);
  })
);

router.post(
  '/:id/cancel',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });
    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      setFlash(req, 'error', 'This invoice cannot be cancelled.');
      return res.redirect(`/invoices/${invoice.id}`);
    }

    await db.prepare("UPDATE invoices SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(invoice.id);
    setFlash(req, 'success', 'Invoice cancelled.');
    res.redirect(`/invoices/${invoice.id}`);
  })
);

router.post(
  '/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });
    if (invoice.status !== 'draft') {
      setFlash(req, 'error', 'Only a draft invoice can be deleted.');
      return res.redirect(`/invoices/${invoice.id}`);
    }

    await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoice.id);
    await db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id);
    setFlash(req, 'success', 'Invoice deleted.');
    res.redirect('/invoices');
  })
);

router.get(
  '/:id/print',
  asyncHandler(async (req, res) => {
    const invoice = await db
      .prepare(
        `SELECT invoices.*, jobs.title AS job_title, customers.name AS customer_name, customers.email AS customer_email,
           customers.phone AS customer_phone,
           customers.address_street, customers.address_city, customers.address_state, customers.address_postcode
         FROM invoices
         JOIN jobs ON jobs.id = invoices.job_id
         JOIN customers ON customers.id = jobs.customer_id
         WHERE invoices.id = ?`
      )
      .get(req.params.id);
    if (!invoice) return res.status(404).render('error', { message: 'Invoice not found.' });

    const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoice.id);
    const total = await totalFor(invoice.id);

    res.render('invoices/print', {
      title: `Invoice ${invoice.invoice_number}`,
      invoice,
      items,
      total,
      subtotal: total / 1.1,
      gst: total - total / 1.1,
    });
  })
);

module.exports = router;
