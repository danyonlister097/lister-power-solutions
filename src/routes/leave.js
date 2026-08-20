const express = require('express');
const db = require('../db');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');
const { LEAVE_TYPES, LEAVE_TYPE_LABELS, parseLeaveType } = require('../lib/leaveTypes');

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

async function loadViewData(req) {
  const [pending, approved, declined] = await Promise.all([
    byStatus('pending', 'ASC'),
    byStatus('approved', 'DESC'),
    byStatus('denied', 'DESC'),
  ]);
  return {
    isAdmin: req.user.role === 'admin',
    currentUserId: req.user.id,
    pending,
    approved,
    declined,
    LEAVE_TYPES,
    LEAVE_TYPE_LABELS,
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.render('leave/index', {
      title: 'Request Leave',
      ...(await loadViewData(req)),
      error: null,
    });
  })
);

router.post(
  '/',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const { start_date, end_date, reason } = req.body;

    if (!start_date || !end_date || end_date < start_date) {
      return res.status(400).render('leave/index', {
        title: 'Request Leave',
        ...(await loadViewData(req)),
        error: 'Please provide a valid start and end date.',
      });
    }

    await db
      .prepare('INSERT INTO leave_requests (user_id, start_date, end_date, reason, leave_type) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, start_date, end_date, reason || null, parseLeaveType(req.body.leave_type));

    setFlash(req, 'success', 'Leave request submitted.');
    res.redirect('/leave');
  })
);

router.post(
  '/:id/cancel',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const request = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
    if (!request || request.user_id !== req.user.id || request.status !== 'pending') {
      return res.status(404).render('error', { message: 'Leave request not found.' });
    }

    await db.prepare("UPDATE leave_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(request.id);

    setFlash(req, 'success', 'Leave request cancelled.');
    res.redirect('/leave');
  })
);

router.post(
  '/:id/set-status',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }

    const request = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).render('error', { message: 'Leave request not found.' });

    const allowed = ['pending', 'approved', 'denied'];
    const status = allowed.includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).render('error', { message: 'Invalid status.' });

    if (status === 'pending') {
      await db
        .prepare("UPDATE leave_requests SET status = 'pending', decided_by = NULL, decided_at = NULL, updated_at = datetime('now') WHERE id = ?")
        .run(request.id);
    } else {
      await db
        .prepare("UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
        .run(status, req.user.id, request.id);
    }

    const label = status === 'approved' ? 'approved' : status === 'denied' ? 'declined' : 'reset to pending';
    setFlash(req, 'success', `Leave request ${label}.`);
    res.redirect('/leave');
  })
);

router.post(
  '/:id/decide',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }

    const request = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
    if (!request || request.status !== 'pending') {
      return res.status(404).render('error', { message: 'Leave request not found.' });
    }

    const action = req.body.action === 'approve' ? 'approved' : 'denied';
    await db
      .prepare(
        "UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      )
      .run(action, req.user.id, request.id);

    setFlash(req, 'success', `Leave request ${action}.`);
    res.redirect('/leave');
  })
);

router.get(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }

    const request = await db
      .prepare(
        `SELECT leave_requests.*, users.name AS user_name
         FROM leave_requests JOIN users ON users.id = leave_requests.user_id
         WHERE leave_requests.id = ?`
      )
      .get(req.params.id);
    if (!request) return res.status(404).render('error', { message: 'Leave request not found.' });

    res.render('leave/edit', { title: 'Edit Leave', request, LEAVE_TYPES, error: null });
  })
);

router.post(
  '/:id',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }

    const request = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).render('error', { message: 'Leave request not found.' });

    const { start_date, end_date, admin_comment } = req.body;
    if (!start_date || !end_date || end_date < start_date) {
      const user = await db.prepare('SELECT name FROM users WHERE id = ?').get(request.user_id);
      return res.status(400).render('leave/edit', {
        title: 'Edit Leave',
        request: { ...request, ...req.body, user_name: user.name },
        LEAVE_TYPES,
        error: 'Please provide a valid start and end date.',
      });
    }

    await db
      .prepare("UPDATE leave_requests SET start_date = ?, end_date = ?, admin_comment = ?, leave_type = ?, updated_at = datetime('now') WHERE id = ?")
      .run(start_date, end_date, admin_comment || null, parseLeaveType(req.body.leave_type), request.id);

    setFlash(req, 'success', 'Leave request updated.');
    res.redirect('/leave');
  })
);

router.post(
  '/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }

    const request = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).render('error', { message: 'Leave request not found.' });

    await db.prepare('DELETE FROM leave_requests WHERE id = ?').run(request.id);

    setFlash(req, 'success', 'Leave request deleted.');
    res.redirect('/leave');
  })
);

module.exports = router;
