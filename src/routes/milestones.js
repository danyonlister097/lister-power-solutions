const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const milestones = await db
      .prepare(`SELECT milestones.*, users.name AS created_by_name
                FROM milestones JOIN users ON users.id = milestones.created_by
                ORDER BY milestones.date ASC`)
      .all();
    res.render('milestones/index', {
      title: 'Business Milestones',
      milestones,
      isAdmin: req.user.role === 'admin',
    });
  })
);

router.post(
  '/',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const title = (req.body.title || '').trim();
    const date = req.body.date || '';
    const recurrence = req.body.recurrence === 'annual' ? 'annual' : 'once';
    const notes = (req.body.notes || '').trim() || null;

    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setFlash(req, 'error', 'Title and a valid date are required.');
      return res.redirect('/milestones');
    }

    await db
      .prepare('INSERT INTO milestones (title, date, recurrence, notes, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(title, date, recurrence, notes, req.user.id);

    setFlash(req, 'success', `Milestone "${title}" added.`);
    res.redirect('/milestones');
  })
);

router.post(
  '/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const m = await db.prepare('SELECT id, title FROM milestones WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).render('error', { message: 'Milestone not found.' });

    await db.prepare('DELETE FROM milestones WHERE id = ?').run(m.id);

    setFlash(req, 'success', `Milestone "${m.title}" deleted.`);
    res.redirect('/milestones');
  })
);

module.exports = router;
