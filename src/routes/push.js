const express = require('express');
const db = require('../db');
const config = require('../config');
const { verifyCsrf } = require('../middleware/auth');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

router.post(
  '/subscribe',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription.' });
    }

    await db
      .prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
      )
      .run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth);

    res.json({ ok: true });
  })
);

router.post(
  '/unsubscribe',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint.' });
    await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
    res.json({ ok: true });
  })
);

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id);
    res.json({ enabled: Number(row.n) > 0, publicKey: config.push.publicKey });
  })
);

module.exports = router;
