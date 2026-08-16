const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../lib/asyncHandler');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { brisbaneTodayIso } = require('../lib/timesheetCalc');
const { licenseUpload, putFile, fetchFile, deleteFile } = require('../lib/uploads');

const router = express.Router();

function labelToKey(label) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
}

async function loadCategories() {
  return db.prepare('SELECT id, key, label FROM renewal_categories ORDER BY sort_order, label').all();
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const tab = req.query.tab === 'documents' ? 'documents' : 'renewals';
    const todayIso = brisbaneTodayIso();
    const users = await db.prepare("SELECT id, name FROM users WHERE active = 1 ORDER BY name").all();

    if (tab === 'documents') {
      const documents = await db
        .prepare(
          `SELECT d.*, u.name AS user_name
           FROM license_documents d
           LEFT JOIN users u ON u.id = d.user_id
           ORDER BY (d.expiry_date IS NULL), d.expiry_date ASC, d.title ASC`
        )
        .all();
      return res.render('renewals/index', {
        title: 'Documents/Licensing',
        tab,
        documents,
        users,
        todayIso,
        isAdmin: req.user.role === 'admin',
      });
    }

    const cat = req.query.category || '';
    const CATEGORIES = await loadCategories();

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

    const assets = await db
      .prepare("SELECT id, name FROM business_assets WHERE status = 'active' ORDER BY name")
      .all();

    res.render('renewals/index', {
      title: 'Renewals',
      tab,
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
        (b.category || 'other').trim(),
        b.user_id ? Number(b.user_id) : null,
        b.asset_id ? Number(b.asset_id) : null,
        b.expiry_date,
        (b.notes || '').trim() || null,
        req.user.id
      );
    setFlash(req, 'success', 'Renewal item added.');
    res.redirect('/renewals');
  })
);

// ── Categories management (must be before /:id routes) ──────────────────────

router.post(
  '/categories',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).render('error', { message: 'Forbidden.' });
    const label = (req.body.label || '').trim();
    if (!label) {
      setFlash(req, 'error', 'Category name is required.');
      return res.redirect('/renewals');
    }
    const key = labelToKey(label);
    if (!key) {
      setFlash(req, 'error', 'Invalid category name.');
      return res.redirect('/renewals');
    }
    try {
      const row = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM renewal_categories').get();
      await db
        .prepare('INSERT INTO renewal_categories (key, label, sort_order) VALUES (?, ?, ?)')
        .run(key, label, Number(row.m) + 10);
      setFlash(req, 'success', `Category "${label}" added.`);
    } catch (err) {
      if (err.code === '23505') {
        setFlash(req, 'error', 'A category with that name already exists.');
      } else {
        throw err;
      }
    }
    res.redirect('/renewals');
  })
);

router.post(
  '/categories/:catid/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).render('error', { message: 'Forbidden.' });
    await db.prepare('DELETE FROM renewal_categories WHERE id = ?').run(req.params.catid);
    setFlash(req, 'success', 'Category deleted.');
    res.redirect('/renewals');
  })
);

// ── Documents/Licensing (must also be before /:id routes) ───────────────────

router.post(
  '/documents',
  (req, res, next) => licenseUpload.single('attachment')(req, res, (err) => {
    if (err) {
      setFlash(req, 'error', err.message);
      return res.redirect('/renewals?tab=documents');
    }
    next();
  }),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.title || !b.title.trim()) {
      setFlash(req, 'error', 'Title is required.');
      return res.redirect('/renewals?tab=documents');
    }

    let fileUrl = null;
    let fileName = null;
    if (req.file) {
      fileUrl = await putFile(req.file);
      fileName = req.file.originalname;
    }

    await db
      .prepare(
        `INSERT INTO license_documents (title, license_number, user_id, expiry_date, notes, file_url, file_name, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        b.title.trim(),
        (b.license_number || '').trim() || null,
        b.user_id ? Number(b.user_id) : null,
        b.expiry_date || null,
        (b.notes || '').trim() || null,
        fileUrl,
        fileName,
        req.user.id
      );
    setFlash(req, 'success', 'Document added.');
    res.redirect('/renewals?tab=documents');
  })
);

router.get(
  '/documents/:id/file',
  asyncHandler(async (req, res) => {
    const doc = await db.prepare('SELECT * FROM license_documents WHERE id = ?').get(req.params.id);
    if (!doc || !doc.file_url) return res.status(404).render('error', { message: 'No file attached.' });
    const stream = await fetchFile(doc.file_url);
    if (!stream) return res.status(404).render('error', { message: 'File not found.' });
    if (doc.file_name) {
      const isPdf = doc.file_name.toLowerCase().endsWith('.pdf');
      res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
      if (isPdf) res.setHeader('Content-Type', 'application/pdf');
    }
    stream.pipe(res);
  })
);

router.post(
  '/documents/:id',
  (req, res, next) => licenseUpload.single('attachment')(req, res, (err) => {
    if (err) {
      setFlash(req, 'error', err.message);
      return res.redirect('/renewals?tab=documents');
    }
    next();
  }),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const doc = await db.prepare('SELECT * FROM license_documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).render('error', { message: 'Document not found.' });
    const b = req.body;

    let fileUrl = doc.file_url;
    let fileName = doc.file_name;
    if (req.file) {
      await deleteFile(doc.file_url);
      fileUrl = await putFile(req.file);
      fileName = req.file.originalname;
    }

    await db
      .prepare(
        `UPDATE license_documents SET title = ?, license_number = ?, user_id = ?, expiry_date = ?, notes = ?,
           file_url = ?, file_name = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(
        (b.title || '').trim() || doc.title,
        (b.license_number || '').trim() || null,
        b.user_id ? Number(b.user_id) : null,
        b.expiry_date || null,
        (b.notes || '').trim() || null,
        fileUrl,
        fileName,
        doc.id
      );
    setFlash(req, 'success', 'Document updated.');
    res.redirect('/renewals?tab=documents');
  })
);

router.post(
  '/documents/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).render('error', { message: 'Forbidden.' });
    const doc = await db.prepare('SELECT file_url FROM license_documents WHERE id = ?').get(req.params.id);
    if (doc) await deleteFile(doc.file_url);
    await db.prepare('DELETE FROM license_documents WHERE id = ?').run(req.params.id);
    setFlash(req, 'success', 'Document deleted.');
    res.redirect('/renewals?tab=documents');
  })
);

// ── Per-item actions (after category routes so /categories/* is not swallowed) ──

router.post(
  '/:id/duplicate',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db
      .prepare('SELECT title, category, user_id, asset_id, expiry_date, notes FROM renewals WHERE id = ?')
      .get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Renewal not found.' });
    await db
      .prepare(
        `INSERT INTO renewals (title, category, user_id, asset_id, expiry_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(item.title, item.category, item.user_id, item.asset_id, item.expiry_date, item.notes, req.user.id);
    setFlash(req, 'success', 'Renewal item duplicated.');
    res.redirect('/renewals');
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
        (b.category || '').trim() || item.category,
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
    if (req.user.role !== 'admin') return res.status(403).render('error', { message: 'Forbidden.' });
    await db.prepare('DELETE FROM renewals WHERE id = ?').run(req.params.id);
    setFlash(req, 'success', 'Renewal item deleted.');
    res.redirect('/renewals');
  })
);

module.exports = router;
