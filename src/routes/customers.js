const express = require('express');
const db = require('../db');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

// Gated at the mount point in app.js by the "customers" permission instead
// of a hardcoded role.

async function getCustomerOr404(req, res) {
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) {
    res.status(404).render('error', { message: 'Customer not found.' });
    return null;
  }
  return customer;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    const customers = q
      ? await db.prepare('SELECT * FROM customers WHERE active = 1 AND name ILIKE ? ORDER BY name').all(`%${q}%`)
      : await db.prepare('SELECT * FROM customers WHERE active = 1 ORDER BY name').all();

    res.render('customers/list', { title: 'Customers', customers, q });
  })
);

router.get('/new', (req, res) => {
  res.render('customers/form', { title: 'New Customer', customer: {}, error: null });
});

router.post(
  '/',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.name || !b.name.trim()) {
      return res.status(400).render('customers/form', {
        title: 'New Customer',
        customer: b,
        error: 'Customer name is required.',
      });
    }

    const result = await db
      .prepare(
        `INSERT INTO customers
          (name, contact_name, phone, email, address_street, address_city, address_state, address_postcode, notes)
         VALUES (@name, @contact_name, @phone, @email, @address_street, @address_city, @address_state, @address_postcode, @notes)
         RETURNING id`
      )
      .run({
        name: b.name.trim(),
        contact_name: b.contact_name || null,
        phone: b.phone || null,
        email: b.email || null,
        address_street: b.address_street || null,
        address_city: b.address_city || null,
        address_state: b.address_state || null,
        address_postcode: b.address_postcode || null,
        notes: b.notes || null,
      });

    setFlash(req, 'success', `Customer "${b.name.trim()}" created.`);
    res.redirect(`/customers/${result.lastInsertRowid}`);
  })
);

const ASSET_TYPES = ['Split System', 'Ducted Unit', 'Solar Inverter', 'Smoke Alarm', 'Switchboard', 'Hot Water System', 'Other'];

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const customer = await getCustomerOr404(req, res);
    if (!customer) return;
    const jobs = await db
      .prepare('SELECT * FROM jobs WHERE customer_id = ? ORDER BY COALESCE(scheduled_start, created_at) DESC')
      .all(customer.id);
    const assets = await db
      .prepare(
        `SELECT customer_assets.*,
           (SELECT COUNT(*) FROM job_assets WHERE job_assets.asset_id = customer_assets.id) AS service_count
         FROM customer_assets WHERE customer_id = ? ORDER BY type, name`
      )
      .all(customer.id);
    res.render('customers/show', { title: customer.name, customer, jobs, assets, assetTypes: ASSET_TYPES });
  })
);

router.post(
  '/:id/assets',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const customer = await getCustomerOr404(req, res);
    if (!customer) return;

    const type = ASSET_TYPES.includes(req.body.type) ? req.body.type : 'Other';
    const name = (req.body.name || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Asset name/label is required.');
      return res.redirect(`/customers/${customer.id}`);
    }

    await db
      .prepare(
        `INSERT INTO customer_assets (customer_id, type, name, make, model, serial_number, install_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        customer.id,
        type,
        name,
        req.body.make || null,
        req.body.model || null,
        req.body.serial_number || null,
        req.body.install_date || null,
        req.body.notes || null,
        req.user.id
      );

    setFlash(req, 'success', `"${name}" added.`);
    res.redirect(`/customers/${customer.id}`);
  })
);

router.get(
  '/:id/assets/:assetId',
  asyncHandler(async (req, res) => {
    const customer = await getCustomerOr404(req, res);
    if (!customer) return;

    const asset = await db.prepare('SELECT * FROM customer_assets WHERE id = ? AND customer_id = ?').get(req.params.assetId, customer.id);
    if (!asset) return res.status(404).render('error', { message: 'Asset not found.' });

    const history = await db
      .prepare(
        `SELECT jobs.* FROM job_assets
         JOIN jobs ON jobs.id = job_assets.job_id
         WHERE job_assets.asset_id = ?
         ORDER BY COALESCE(jobs.scheduled_start, jobs.created_at) DESC`
      )
      .all(asset.id);

    res.render('customers/asset', { title: asset.name, customer, asset, history, assetTypes: ASSET_TYPES, error: null });
  })
);

router.post(
  '/:id/assets/:assetId',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const customer = await getCustomerOr404(req, res);
    if (!customer) return;

    const asset = await db.prepare('SELECT * FROM customer_assets WHERE id = ? AND customer_id = ?').get(req.params.assetId, customer.id);
    if (!asset) return res.status(404).render('error', { message: 'Asset not found.' });

    const name = (req.body.name || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Asset name/label is required.');
      return res.redirect(`/customers/${customer.id}/assets/${asset.id}`);
    }

    await db
      .prepare(
        `UPDATE customer_assets SET type = ?, name = ?, make = ?, model = ?, serial_number = ?, install_date = ?, notes = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(
        ASSET_TYPES.includes(req.body.type) ? req.body.type : 'Other',
        name,
        req.body.make || null,
        req.body.model || null,
        req.body.serial_number || null,
        req.body.install_date || null,
        req.body.notes || null,
        asset.id
      );

    setFlash(req, 'success', 'Asset updated.');
    res.redirect(`/customers/${customer.id}/assets/${asset.id}`);
  })
);

router.post(
  '/:id/assets/:assetId/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const customer = await getCustomerOr404(req, res);
    if (!customer) return;

    const asset = await db.prepare('SELECT * FROM customer_assets WHERE id = ? AND customer_id = ?').get(req.params.assetId, customer.id);
    if (!asset) return res.status(404).render('error', { message: 'Asset not found.' });

    await db.prepare('DELETE FROM job_assets WHERE asset_id = ?').run(asset.id);
    await db.prepare('DELETE FROM customer_assets WHERE id = ?').run(asset.id);

    setFlash(req, 'success', `"${asset.name}" removed.`);
    res.redirect(`/customers/${customer.id}`);
  })
);

router.get(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    const customer = await getCustomerOr404(req, res);
    if (!customer) return;
    res.render('customers/form', { title: `Edit ${customer.name}`, customer, error: null });
  })
);

router.post(
  '/:id',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const customer = await getCustomerOr404(req, res);
    if (!customer) return;

    const b = req.body;
    if (!b.name || !b.name.trim()) {
      return res.status(400).render('customers/form', {
        title: `Edit ${customer.name}`,
        customer: { ...customer, ...b },
        error: 'Customer name is required.',
      });
    }

    await db
      .prepare(
        `UPDATE customers SET
           name = @name, contact_name = @contact_name, phone = @phone, email = @email,
           address_street = @address_street, address_city = @address_city,
           address_state = @address_state, address_postcode = @address_postcode,
           notes = @notes, updated_at = datetime('now')
         WHERE id = @id`
      )
      .run({
        id: customer.id,
        name: b.name.trim(),
        contact_name: b.contact_name || null,
        phone: b.phone || null,
        email: b.email || null,
        address_street: b.address_street || null,
        address_city: b.address_city || null,
        address_state: b.address_state || null,
        address_postcode: b.address_postcode || null,
        notes: b.notes || null,
      });

    setFlash(req, 'success', 'Customer updated.');
    res.redirect(`/customers/${customer.id}`);
  })
);

router.post(
  '/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const customer = await getCustomerOr404(req, res);
    if (!customer) return;
    await db.prepare("UPDATE customers SET active = 0, updated_at = datetime('now') WHERE id = ?").run(customer.id);
    setFlash(req, 'success', `Customer "${customer.name}" removed.`);
    res.redirect('/customers');
  })
);

module.exports = router;
