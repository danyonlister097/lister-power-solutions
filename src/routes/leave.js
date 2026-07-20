const express = require('express');
const db = require('../db');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');

const router = express.Router();

function byStatus(status, order) {
  return db
    .prepare(
      `SELECT leave_requests.*, users.name AS user_name, decider.name AS decided_by_name
       FROM leave_requests
       JOIN users ON users.id = leave_requests.user_id
       LEFT JOIN users decider ON decider.id = leave_requests.decided_by
       WHERE leave_requests.status = ?
       ORDER BY leave_requests.start_date ${order}`
    )
    .all(status);
}

function loadViewData(req) {
  return {
    isAdmin: req.user.role === 'admin',
    currentUserId: req.user.id,
    pending: byStatus('pending', 'ASC'),
    approved: byStatus('approved', 'DESC'),
    declined: byStatus('denied', 'DESC'),
  };
}

router.get('/', (req, res) => {
  res.render('leave/index', {
    title: 'Request Leave',
    ...loadViewData(req),
    error: null,
  });
});

router.post('/', verifyCsrf, (req, res) => {
  const { start_date, end_date, reason } = req.body;

  if (!start_date || !end_date || end_date < start_date) {
    return res.status(400).render('leave/index', {
      title: 'Request Leave',
      ...loadViewData(req),
      error: 'Please provide a valid start and end date.',
    });
  }

  db.prepare(
    'INSERT INTO leave_requests (user_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, start_date, end_date, reason || null);

  setFlash(req, 'success', 'Leave request submitted.');
  res.redirect('/leave');
});

router.post('/:id/cancel', verifyCsrf, (req, res) => {
  const request = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!request || request.user_id !== req.user.id || request.status !== 'pending') {
    return res.status(404).render('error', { message: 'Leave request not found.' });
  }

  db.prepare("UPDATE leave_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(
    request.id
  );

  setFlash(req, 'success', 'Leave request cancelled.');
  res.redirect('/leave');
});

router.post('/:id/decide', verifyCsrf, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'You do not have access to this page.' });
  }

  const request = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!request || request.status !== 'pending') {
    return res.status(404).render('error', { message: 'Leave request not found.' });
  }

  const action = req.body.action === 'approve' ? 'approved' : 'denied';
  db.prepare(
    "UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(action, req.user.id, request.id);

  setFlash(req, 'success', `Leave request ${action}.`);
  res.redirect('/leave');
});

router.get('/:id/edit', (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'You do not have access to this page.' });
  }

  const request = db
    .prepare(
      `SELECT leave_requests.*, users.name AS user_name
       FROM leave_requests JOIN users ON users.id = leave_requests.user_id
       WHERE leave_requests.id = ?`
    )
    .get(req.params.id);
  if (!request) return res.status(404).render('error', { message: 'Leave request not found.' });

  res.render('leave/edit', { title: 'Edit Leave', request, error: null });
});

router.post('/:id', verifyCsrf, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'You do not have access to this page.' });
  }

  const request = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).render('error', { message: 'Leave request not found.' });

  const { start_date, end_date, admin_comment } = req.body;
  if (!start_date || !end_date || end_date < start_date) {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(request.user_id);
    return res.status(400).render('leave/edit', {
      title: 'Edit Leave',
      request: { ...request, ...req.body, user_name: user.name },
      error: 'Please provide a valid start and end date.',
    });
  }

  db.prepare(
    "UPDATE leave_requests SET start_date = ?, end_date = ?, admin_comment = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(start_date, end_date, admin_comment || null, request.id);

  setFlash(req, 'success', 'Leave request updated.');
  res.redirect('/leave');
});

router.post('/:id/delete', verifyCsrf, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'You do not have access to this page.' });
  }

  const request = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).render('error', { message: 'Leave request not found.' });

  db.prepare('DELETE FROM leave_requests WHERE id = ?').run(request.id);

  setFlash(req, 'success', 'Leave request deleted.');
  res.redirect('/leave');
});

module.exports = router;
