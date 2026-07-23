const express = require('express');
const db = require('../db');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'declined'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await db
      .prepare(
        `SELECT f.id, f.type, f.title, f.description, f.status, f.created_at,
                u.name AS submitter_name, f.submitted_by
         FROM feedback_items f
         JOIN users u ON u.id = f.submitted_by
         ORDER BY f.created_at DESC`
      )
      .all();

    res.render('feedback/index', { title: 'Bug Reports & Ideas', items });
  })
);

router.post(
  '/',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const { type, title, description } = req.body;
    if (!['bug', 'idea'].includes(type) || !title || !title.trim()) {
      setFlash(req, 'error', 'A type and title are required.');
      return res.redirect('/feedback');
    }

    await db
      .prepare(
        `INSERT INTO feedback_items (type, title, description, submitted_by)
         VALUES (?, ?, ?, ?)`
      )
      .run(type, title.trim(), (description || '').trim() || null, req.user.id);

    setFlash(req, 'success', 'Thanks — your submission has been logged.');
    res.redirect('/feedback');
  })
);

router.post(
  '/:id/edit',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT id, submitted_by FROM feedback_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Not found.' });
    if (req.user.role !== 'admin' && item.submitted_by !== req.user.id) {
      return res.status(403).render('error', { message: 'You can only edit your own submissions.' });
    }

    const { type, title, description } = req.body;
    if (!['bug', 'idea'].includes(type) || !title || !title.trim()) {
      setFlash(req, 'error', 'A type and title are required.');
      return res.redirect('/feedback');
    }

    await db
      .prepare(`UPDATE feedback_items SET type = ?, title = ?, description = ?, updated_at = now_utc_text() WHERE id = ?`)
      .run(type, title.trim(), (description || '').trim() || null, item.id);

    setFlash(req, 'success', 'Updated.');
    res.redirect('/feedback');
  })
);

router.post(
  '/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT id, submitted_by FROM feedback_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Not found.' });
    if (req.user.role !== 'admin' && item.submitted_by !== req.user.id) {
      return res.status(403).render('error', { message: 'You can only delete your own submissions.' });
    }

    await db.prepare('DELETE FROM feedback_items WHERE id = ?').run(item.id);
    setFlash(req, 'success', 'Deleted.');
    res.redirect('/feedback');
  })
);

router.post(
  '/:id/status',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'Admin only.' });
    }

    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      setFlash(req, 'error', 'Invalid status.');
      return res.redirect('/feedback');
    }

    const item = await db.prepare('SELECT id FROM feedback_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Not found.' });

    await db
      .prepare(`UPDATE feedback_items SET status = ?, updated_at = now_utc_text() WHERE id = ?`)
      .run(status, item.id);

    res.redirect('/feedback');
  })
);

module.exports = router;
