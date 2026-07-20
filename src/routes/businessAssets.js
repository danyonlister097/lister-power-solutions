const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');

const router = express.Router();

const STATUSES = ['active', 'in_repair', 'retired', 'lost'];

function getCategoryRows() {
  return db.prepare('SELECT * FROM business_asset_categories ORDER BY name').all();
}

function getCategoryNames() {
  return getCategoryRows().map((c) => c.name);
}

// "+ Add new category..." in the category <select> creates the category on
// the fly (admin-only, since asset creation/editing already is) instead of
// needing a separate management screen.
function resolveCategory(body) {
  if (body.category === '__new__') {
    const newName = (body.new_category || '').trim();
    if (!newName) return 'Other';
    const existing = db.prepare('SELECT name FROM business_asset_categories WHERE name = ? COLLATE NOCASE').get(newName);
    if (existing) return existing.name;
    db.prepare('INSERT INTO business_asset_categories (name) VALUES (?)').run(newName);
    return newName;
  }
  return getCategoryNames().includes(body.category) ? body.category : 'Other';
}

function parseCost(raw) {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

const parseKm = parseCost;

// Only ever redirect back to a same-site URL we generated ourselves - never
// follow an arbitrary returnTo value (open-redirect guard).
function safeReturnTo(raw) {
  return typeof raw === 'string' && /^\/(dashboard|assets)(\?[A-Za-z0-9=&_-]*)?$/.test(raw) ? raw : null;
}

router.get('/', (req, res) => {
  const category = req.query.category || '';
  const status = req.query.status || '';

  let sql = `
    SELECT business_assets.*, users.name AS assigned_to_name
    FROM business_assets
    LEFT JOIN users ON users.id = business_assets.assigned_to
    WHERE 1 = 1
  `;
  const params = [];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY category, name';

  const assets = db.prepare(sql).all(...params);
  const techs = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();

  res.render('assets/index', {
    title: 'Asset Register',
    assets,
    techs,
    CATEGORIES: getCategoryNames(),
    STATUSES,
    category,
    status,
  });
});

router.post('/', requireRole('admin'), verifyCsrf, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    setFlash(req, 'error', 'Asset name is required.');
    return res.redirect('/assets');
  }

  db.prepare(
    `INSERT INTO business_assets
      (name, category, brand, model, serial_number, purchase_date, purchase_cost, assigned_to, location, status,
       next_service_due, registration_expiry, current_odometer_km, service_due_at_km, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    resolveCategory(req.body),
    (req.body.brand || '').trim() || null,
    (req.body.model || '').trim() || null,
    (req.body.serial_number || '').trim() || null,
    req.body.purchase_date || null,
    parseCost(req.body.purchase_cost),
    req.body.assigned_to ? Number.parseInt(req.body.assigned_to, 10) : null,
    (req.body.location || '').trim() || null,
    STATUSES.includes(req.body.status) ? req.body.status : 'active',
    req.body.next_service_due || null,
    req.body.registration_expiry || null,
    parseKm(req.body.current_odometer_km),
    parseKm(req.body.service_due_at_km),
    (req.body.notes || '').trim() || null,
    req.user.id
  );

  setFlash(req, 'success', `"${name}" added to the asset register.`);
  res.redirect('/assets');
});

router.get('/:id', (req, res) => {
  const asset = db
    .prepare(
      `SELECT business_assets.*, users.name AS assigned_to_name
       FROM business_assets LEFT JOIN users ON users.id = business_assets.assigned_to
       WHERE business_assets.id = ?`
    )
    .get(req.params.id);
  if (!asset) return res.status(404).render('error', { message: 'Asset not found.' });

  const techs = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();
  const closeUrl = safeReturnTo(req.query.returnTo) || '/assets';

  res.render('assets/show', {
    title: asset.name,
    asset,
    techs,
    CATEGORIES: getCategoryNames(),
    STATUSES,
    error: null,
    closeUrl,
  });
});

router.post('/:id', requireRole('admin'), verifyCsrf, (req, res) => {
  const asset = db.prepare('SELECT * FROM business_assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).render('error', { message: 'Asset not found.' });

  const returnTo = safeReturnTo(req.body.returnTo) || '/assets';

  const name = (req.body.name || '').trim();
  if (!name) {
    setFlash(req, 'error', 'Asset name is required.');
    return res.redirect(`/assets/${asset.id}?returnTo=${encodeURIComponent(returnTo)}`);
  }

  db.prepare(
    `UPDATE business_assets SET
       name = ?, category = ?, brand = ?, model = ?, serial_number = ?, purchase_date = ?, purchase_cost = ?,
       assigned_to = ?, location = ?, status = ?, next_service_due = ?, registration_expiry = ?,
       current_odometer_km = ?, service_due_at_km = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    name,
    resolveCategory(req.body),
    (req.body.brand || '').trim() || null,
    (req.body.model || '').trim() || null,
    (req.body.serial_number || '').trim() || null,
    req.body.purchase_date || null,
    parseCost(req.body.purchase_cost),
    req.body.assigned_to ? Number.parseInt(req.body.assigned_to, 10) : null,
    (req.body.location || '').trim() || null,
    STATUSES.includes(req.body.status) ? req.body.status : asset.status,
    req.body.next_service_due || null,
    req.body.registration_expiry || null,
    parseKm(req.body.current_odometer_km),
    parseKm(req.body.service_due_at_km),
    (req.body.notes || '').trim() || null,
    asset.id
  );

  setFlash(req, 'success', 'Asset updated.');
  res.redirect(returnTo);
});

router.post('/:id/delete', requireRole('admin'), verifyCsrf, (req, res) => {
  const asset = db.prepare('SELECT * FROM business_assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).render('error', { message: 'Asset not found.' });

  db.prepare('DELETE FROM business_assets WHERE id = ?').run(asset.id);
  setFlash(req, 'success', `"${asset.name}" removed from the asset register.`);
  res.redirect(safeReturnTo(req.body.returnTo) || '/assets');
});

module.exports = router;
