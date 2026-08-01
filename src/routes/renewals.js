const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../lib/asyncHandler');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { addDays, brisbaneTodayIso } = require('../lib/timesheetCalc');

const router = express.Router();

const CATEGORIES = [
  { key: 'licence', label: 'Staff Licence' },
  { key: 'training', label: 'Training' },
  { key: 'vehicle_rego', label: 'Vehicle Rego' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'other', label: 'Other' },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const cat = req.query.category || '';
    const todayIso = brisbaneTodayIso();

    // Manual renewal items
    const params = [];
    let where = '';
    if (cat && cat !== 'vehicle_rego') {
      where = ' WHERE r.category = ?';
      params.push(cat);
    } else if (cat === 'vehicle_rego') {
      where = " WHERE r.category = 'vehicle_rego'";
    }

    const renewals = await db
      .prepare(
        `SELECT r.id, r.title, r.category, r.expiry_date, r.notes,
                u.name AS user_name, a.name AS asset_name
         FROM renewals r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN business_assets a ON a.id = r.asset_id${where}
         ORDER BY r.expiry_date ASC`
      )
      .all(...params);

    // Vehicle rego from asset register (shown under All and Vehicle Rego tabs)
    let assetRegos = [];
    if (!cat || cat === 'vehicle_rego') {
      assetRegos = await db
        .prepare(
          `SELECT id, name, registration_expiry AS expiry_date
           FROM business_assets
           WHERE registration_expiry IS NOT NULL AND status IN ('active', 'in_repair')
           ORDER BY registration_expiry ASC`
        )
        .all();
    }

    const assetItems = assetRegos.map((a) => ({
      id: null,
      asset_register_id: a.id,
      title: a.name,
      category: 'vehicle_rego',
      expiry_date: a.expiry_date,
      user_name: null,
      asset_name: a.name,
      notes: null,
      source: 'asset',
    }));

    const allItems = [
      ...renewals.map((r) => ({ ...r, source: 'renewal' })),
      ...assetItems,
    ].sort((a, b) => {
      const da = a.expiry_date || '9999-99-99';
      const db_ = b.expiry_date || '9999-99-99';
      return da < db_ ? -1 : da > db_ ? 1 : 0;
    });

    const users = await db
      .prepare("SELECT id, name FROM users WHERE active = 1 ORDER BY name")
      .all();
    const assets = await db
      .prepare("SELECT id, name FROM business_assets WHERE status = 'active' ORDER BY name")
      .all();

    res.render('renewals/index', {
      title: 'Renewals',
      items: allItems,
      category: cat,
      CATEGORIES,
      users,
      assets,
      todayIso,
      isAdmin: req.user.role === 'admin',
    });
  })
);

router.post(
  '/',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.title || !b.expiry_date) {
      setFlash(req, 'error', 'Title and expiry date are required.');
      return res.redirect('/renewals');
    }
    await db
      .prepare(
        `INSERT INTO renewals (title, category, user_id, asset_id, expiry_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        b.title.trim(),
        CATEGORY_KEYS.includes(b.category) ? b.category : 'other',
        b.user_id ? Number(b.user_id) : null,
        b.asset_id ? Number(b.asset_id) : null,
        b.expiry_date,
        (b.notes || '').trim() || null,
        req.user.id
      );
    setFlash(req, 'success', 'Renewal item added.');
    res.redirect('/renewals' + (req.body.category ? `?category=${req.body.category}` : ''));
  })
);

router.post(
  '/:id',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT id, category FROM renewals WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Renewal not found.' });
    const b = req.body;
    await db
      .prepare(
        `UPDATE renewals SET title = ?, category = ?, user_id = ?, asset_id = ?, expiry_date = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(
        (b.title || '').trim(),
        CATEGORY_KEYS.includes(b.category) ? b.category : item.category,
        b.user_id ? Number(b.user_id) : null,
        b.asset_id ? Number(b.asset_id) : null,
        b.expiry_date,
        (b.notes || '').trim() || null,
        item.id
      );
    setFlash(req, 'success', 'Renewal item updated.');
    res.redirect('/renewals');
  })
);

router.post(
  '/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'Forbidden.' });
    }
    await db.prepare('DELETE FROM renewals WHERE id = ?').run(req.params.id);
    setFlash(req, 'success', 'Renewal item deleted.');
    res.redirect('/renewals');
  })
);

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
