const express = require('express');
const db = require('../db');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const users = await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    const open = await db
      .prepare(
        `SELECT tasks.*, u.name AS assignee_name, c.name AS creator_name
         FROM tasks LEFT JOIN users u ON u.id = tasks.assigned_to
         JOIN users c ON c.id = tasks.created_by
         WHERE tasks.done = 0 ORDER BY tasks.created_at ASC`
      )
      .all();
    const done = await db
      .prepare(
        `SELECT tasks.*, u.name AS assignee_name, c.name AS creator_name
         FROM tasks LEFT JOIN users u ON u.id = tasks.assigned_to
         JOIN users c ON c.id = tasks.created_by
         WHERE tasks.done = 1 ORDER BY tasks.completed_at DESC LIMIT 20`
      )
      .all();

    res.render('tasks/index', { title: 'Quick Task', users, open, done });
  })
);

router.post(
  '/',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const title = (req.body.title || '').trim();
    if (!title) {
      setFlash(req, 'error', 'Task title is required.');
      return res.redirect('/tasks');
    }
    const assignedTo = req.body.assigned_to || null;

    await db.prepare('INSERT INTO tasks (title, assigned_to, created_by) VALUES (?, ?, ?)').run(title, assignedTo, req.user.id);

    setFlash(req, 'success', 'Task added.');
    res.redirect('/tasks');
  })
);

router.post(
  '/:id/toggle',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).render('error', { message: 'Task not found.' });

    const nextDone = task.done ? 0 : 1;
    await db
      .prepare(
        "UPDATE tasks SET done = ?, completed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = ?"
      )
      .run(nextDone, nextDone, task.id);

    res.redirect('/tasks');
  })
);

router.post(
  '/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).render('error', { message: 'Task not found.' });
    if (task.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }

    await db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    setFlash(req, 'success', 'Task deleted.');
    res.redirect('/tasks');
  })
);

module.exports = router;
