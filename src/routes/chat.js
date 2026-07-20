const express = require('express');
const db = require('../db');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');

const router = express.Router();

const INITIAL_LIMIT = 100;

function serialize(row) {
  return {
    id: row.id,
    body: row.body,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: row.created_at,
  };
}

function escapeLike(raw) {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
}

function markRead(userId, channelId) {
  const latest = db.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE channel_id = ?').get(channelId);
  if (!latest.id) return;
  db.prepare(
    `INSERT INTO chat_reads (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`
  ).run(userId, channelId, latest.id);
}

// Pin status and manual ordering are per-user (chat_channel_prefs). A channel
// with no pref row yet is unpinned and sorts by its own id.
function channelsWithUnread(userId) {
  return db
    .prepare(
      `SELECT
         c.*,
         COALESCE(cp.pinned, 0) AS pinned,
         COALESCE(cp.sort_order, c.id) AS effective_sort_order,
         (SELECT COUNT(*) FROM chat_messages m
            WHERE m.channel_id = c.id
              AND m.id > COALESCE((SELECT last_read_message_id FROM chat_reads WHERE chat_reads.channel_id = c.id AND chat_reads.user_id = ?), 0)
         ) AS unread_count
       FROM chat_channels c
       LEFT JOIN chat_channel_prefs cp ON cp.channel_id = c.id AND cp.user_id = ?
       ORDER BY effective_sort_order ASC`
    )
    .all(userId, userId);
}

router.get('/', (req, res) => {
  const first = db.prepare('SELECT id FROM chat_channels ORDER BY id ASC LIMIT 1').get();
  if (!first) {
    const result = db.prepare('INSERT INTO chat_channels (name, created_by) VALUES (?, ?)').run('General', req.user.id);
    return res.redirect(`/chat/c/${result.lastInsertRowid}`);
  }
  res.redirect(`/chat/c/${first.id}`);
});

router.post('/channels', verifyCsrf, (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 60);
  if (!name) {
    setFlash(req, 'error', 'Channel name is required.');
    return res.redirect('/chat');
  }

  const result = db.prepare('INSERT INTO chat_channels (name, created_by) VALUES (?, ?)').run(name, req.user.id);
  setFlash(req, 'success', `Channel "${name}" created.`);
  res.redirect(`/chat/c/${result.lastInsertRowid}`);
});

router.post('/channels/:id/pin', verifyCsrf, (req, res) => {
  const channel = db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });

  const existing = db
    .prepare('SELECT pinned FROM chat_channel_prefs WHERE user_id = ? AND channel_id = ?')
    .get(req.user.id, channel.id);
  const nextPinned = existing && existing.pinned ? 0 : 1;

  db.prepare(
    `INSERT INTO chat_channel_prefs (user_id, channel_id, pinned) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET pinned = excluded.pinned`
  ).run(req.user.id, channel.id, nextPinned);

  res.json({ pinned: Boolean(nextPinned) });
});

router.post('/channels/reorder', verifyCsrf, (req, res) => {
  const channelA = db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.body.a);
  const channelB = db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.body.b);
  if (!channelA || !channelB) return res.status(404).json({ error: 'Channel not found.' });

  const prefA = db
    .prepare('SELECT sort_order FROM chat_channel_prefs WHERE user_id = ? AND channel_id = ?')
    .get(req.user.id, channelA.id);
  const prefB = db
    .prepare('SELECT sort_order FROM chat_channel_prefs WHERE user_id = ? AND channel_id = ?')
    .get(req.user.id, channelB.id);
  const orderA = prefA && prefA.sort_order != null ? prefA.sort_order : channelA.id;
  const orderB = prefB && prefB.sort_order != null ? prefB.sort_order : channelB.id;

  const upsert = db.prepare(
    `INSERT INTO chat_channel_prefs (user_id, channel_id, sort_order) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET sort_order = excluded.sort_order`
  );
  upsert.run(req.user.id, channelA.id, orderB);
  upsert.run(req.user.id, channelB.id, orderA);

  res.json({ ok: true });
});

router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const from = isValidDate(req.query.from) ? req.query.from : '';
  const to = isValidDate(req.query.to) ? req.query.to : '';

  let results = [];
  if (q || from || to) {
    const clauses = [];
    const params = [];
    if (q) {
      clauses.push('chat_messages.body LIKE ? ESCAPE \'\\\'');
      params.push(`%${escapeLike(q)}%`);
    }
    if (from) {
      clauses.push('date(chat_messages.created_at) >= date(?)');
      params.push(from);
    }
    if (to) {
      clauses.push('date(chat_messages.created_at) <= date(?)');
      params.push(to);
    }
    results = db
      .prepare(
        `SELECT chat_messages.*, users.name AS user_name, chat_channels.name AS channel_name
         FROM chat_messages
         JOIN users ON users.id = chat_messages.user_id
         JOIN chat_channels ON chat_channels.id = chat_messages.channel_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY chat_messages.created_at DESC
         LIMIT 100`
      )
      .all(...params);
  }

  res.render('chat/search', {
    title: 'Search chats',
    q,
    from,
    to,
    results,
    channels: channelsWithUnread(req.user.id),
  });
});

router.get('/c/:id', (req, res) => {
  const channel = db.prepare('SELECT * FROM chat_channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).render('error', { message: 'Channel not found.' });

  const from = isValidDate(req.query.from) ? req.query.from : '';
  const to = isValidDate(req.query.to) ? req.query.to : '';

  let messages;
  if (from || to) {
    const clauses = ['chat_messages.channel_id = ?'];
    const params = [channel.id];
    if (from) {
      clauses.push('date(chat_messages.created_at) >= date(?)');
      params.push(from);
    }
    if (to) {
      clauses.push('date(chat_messages.created_at) <= date(?)');
      params.push(to);
    }
    messages = db
      .prepare(
        `SELECT chat_messages.*, users.name AS user_name
         FROM chat_messages JOIN users ON users.id = chat_messages.user_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY chat_messages.id ASC LIMIT 500`
      )
      .all(...params);
  } else {
    messages = db
      .prepare(
        `SELECT chat_messages.*, users.name AS user_name
         FROM chat_messages JOIN users ON users.id = chat_messages.user_id
         WHERE chat_messages.channel_id = ?
         ORDER BY chat_messages.id DESC LIMIT ?`
      )
      .all(channel.id, INITIAL_LIMIT)
      .reverse();
  }

  markRead(req.user.id, channel.id);

  res.render('chat/index', {
    title: `#${channel.name}`,
    channel,
    channels: channelsWithUnread(req.user.id),
    unreadOnly: req.query.unreadOnly === '1',
    messages,
    from,
    to,
  });
});

router.get('/c/:id/messages', (req, res) => {
  const channel = db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });

  const afterId = Number.parseInt(req.query.after, 10) || 0;
  const messages = db
    .prepare(
      `SELECT chat_messages.*, users.name AS user_name
       FROM chat_messages JOIN users ON users.id = chat_messages.user_id
       WHERE chat_messages.channel_id = ? AND chat_messages.id > ? ORDER BY chat_messages.id ASC LIMIT 100`
    )
    .all(channel.id, afterId);

  if (messages.length) markRead(req.user.id, channel.id);

  res.json({ messages: messages.map(serialize) });
});

router.post('/c/:id', verifyCsrf, (req, res) => {
  const channel = db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });

  const body = (req.body.body || '').trim().slice(0, 2000);
  const wantsJson = req.get('Accept') === 'application/json';

  if (!body) {
    if (wantsJson) return res.status(400).json({ error: 'Message required.' });
    return res.redirect(`/chat/c/${channel.id}`);
  }

  const result = db.prepare('INSERT INTO chat_messages (channel_id, user_id, body) VALUES (?, ?, ?)').run(
    channel.id,
    req.user.id,
    body
  );
  const row = db
    .prepare(
      `SELECT chat_messages.*, users.name AS user_name
       FROM chat_messages JOIN users ON users.id = chat_messages.user_id
       WHERE chat_messages.id = ?`
    )
    .get(result.lastInsertRowid);

  markRead(req.user.id, channel.id);

  if (wantsJson) return res.json({ message: serialize(row) });
  res.redirect(`/chat/c/${channel.id}`);
});

module.exports = router;
