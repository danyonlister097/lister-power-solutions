const express = require('express');
const db = require('../db');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');
const { chatUpload, putFile } = require('../lib/uploads');
const { sendPushToUsers } = require('../lib/push');

const router = express.Router();

const INITIAL_LIMIT = 100;

function serialize(row) {
  return {
    id: row.id,
    body: row.body,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: row.created_at,
    attachmentUrl: row.attachment_url || null,
    attachmentName: row.attachment_name || null,
    pinned: Boolean(row.pinned),
    replyTo: row.reply_to_id
      ? { id: row.reply_to_id, userName: row.reply_user_name, body: row.reply_body, attachmentName: row.reply_attachment_name }
      : null,
  };
}

// Shared fragment joining back to the message being replied to (and its
// author) so serialize() can show a quoted preview without a second round
// trip. LEFT JOIN so a plain message, or a reply whose parent was since
// deleted (reply_to_id goes NULL via ON DELETE SET NULL), just comes back
// with NULLs here rather than disappearing.
const REPLY_JOIN_SQL = `LEFT JOIN chat_messages reply_msg ON reply_msg.id = chat_messages.reply_to_id
   LEFT JOIN users reply_user ON reply_user.id = reply_msg.user_id`;
const REPLY_SELECT_SQL = `reply_msg.body AS reply_body, reply_msg.attachment_name AS reply_attachment_name, reply_user.name AS reply_user_name`;

function escapeLike(raw) {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
}

async function markRead(userId, channelId) {
  const latest = await db.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE channel_id = ?').get(channelId);
  if (!latest.id) return;
  await db
    .prepare(
      `INSERT INTO chat_reads (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_message_id = GREATEST(chat_reads.last_read_message_id, excluded.last_read_message_id)`
    )
    .run(userId, channelId, latest.id);
}

// Correlated subquery counting a channel's messages this user hasn't read
// yet - shared by every place that needs an unread count, so the
// definition of "unread" only lives in one place. Needs the user's id bound
// as the next `?` wherever it's inlined.
const UNREAD_COUNT_SQL = `(SELECT COUNT(*) FROM chat_messages m
   WHERE m.channel_id = c.id
     AND m.id > COALESCE((SELECT last_read_message_id FROM chat_reads WHERE chat_reads.channel_id = c.id AND chat_reads.user_id = ?), 0)
)`;

// Pin status and manual ordering are per-user (chat_channel_prefs). A channel
// with no pref row yet is unpinned and sorts by its own id. Pinned channels
// keep manual drag order; unpinned channels auto-sort by most recent
// message (Slack-style) so active conversations float to the top.
function channelsWithUnread(user) {
  const userId = user.id;
  const adminFilter = user.role === 'admin' ? '' : 'AND c.admin_only = 0';
  return db
    .prepare(
      `SELECT
         c.*,
         COALESCE(cp.pinned, 0) AS pinned,
         COALESCE(cp.sort_order, c.id) AS effective_sort_order,
         ${UNREAD_COUNT_SQL} AS unread_count,
         (SELECT MAX(id) FROM chat_messages WHERE channel_id = c.id) AS last_message_id
       FROM chat_channels c
       LEFT JOIN chat_channel_prefs cp ON cp.channel_id = c.id AND cp.user_id = ?
       WHERE 1=1 ${adminFilter}
       ORDER BY
         COALESCE(cp.pinned, 0) DESC,
         CASE WHEN COALESCE(cp.pinned, 0) = 1 THEN COALESCE(cp.sort_order, c.id) END ASC,
         CASE WHEN COALESCE(cp.pinned, 0) = 0 THEN COALESCE((SELECT MAX(id) FROM chat_messages WHERE channel_id = c.id), 0) END DESC,
         c.id ASC`
    )
    .all(userId, userId);
}

// Total unread messages across every channel visible to this user - powers
// the badge on the Chat icon in the sidebar nav.
function getUnreadTotal(user) {
  const adminFilter = user.role === 'admin' ? '' : 'AND c.admin_only = 0';
  return db
    .prepare(
      `SELECT COALESCE(SUM(${UNREAD_COUNT_SQL}), 0) AS total
       FROM chat_channels c
       WHERE 1=1 ${adminFilter}`
    )
    .get(user.id);
}

// Polled from the browser (both sitewide, for the nav icon badge, and more
// frequently while inside the chat tool, for per-channel badges) so unread
// state updates without a page reload/navigation.
router.get(
  '/channels/unread-counts',
  asyncHandler(async (req, res) => {
    const channels = await channelsWithUnread(req.user);
    const counts = channels.map((c) => ({ id: c.id, unread: Number(c.unread_count) }));
    const total = counts.reduce((sum, c) => sum + c.unread, 0);
    res.json({ total, channels: counts });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const first = await db.prepare('SELECT id FROM chat_channels ORDER BY id ASC LIMIT 1').get();
    if (!first) {
      const result = await db.prepare('INSERT INTO chat_channels (name, created_by) VALUES (?, ?) RETURNING id').run('General', req.user.id);
      return res.redirect(`/chat/c/${result.lastInsertRowid}`);
    }
    res.redirect(`/chat/c/${first.id}`);
  })
);

router.post(
  '/channels',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const name = (req.body.name || '').trim().slice(0, 60);
    if (!name) {
      setFlash(req, 'error', 'Channel name is required.');
      return res.redirect('/chat');
    }

    const result = await db.prepare('INSERT INTO chat_channels (name, created_by) VALUES (?, ?) RETURNING id').run(name, req.user.id);
    setFlash(req, 'success', `Channel "${name}" created.`);
    res.redirect(`/chat/c/${result.lastInsertRowid}`);
  })
);

router.post(
  '/channels/:id/pin',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const channel = await db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });

    const existing = await db
      .prepare('SELECT pinned FROM chat_channel_prefs WHERE user_id = ? AND channel_id = ?')
      .get(req.user.id, channel.id);
    const nextPinned = existing && existing.pinned ? 0 : 1;

    await db
      .prepare(
        `INSERT INTO chat_channel_prefs (user_id, channel_id, pinned) VALUES (?, ?, ?)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET pinned = excluded.pinned`
      )
      .run(req.user.id, channel.id, nextPinned);

    res.json({ pinned: Boolean(nextPinned) });
  })
);

router.post(
  '/channels/reorder',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const channelA = await db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.body.a);
    const channelB = await db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.body.b);
    if (!channelA || !channelB) return res.status(404).json({ error: 'Channel not found.' });

    const prefA = await db
      .prepare('SELECT sort_order FROM chat_channel_prefs WHERE user_id = ? AND channel_id = ?')
      .get(req.user.id, channelA.id);
    const prefB = await db
      .prepare('SELECT sort_order FROM chat_channel_prefs WHERE user_id = ? AND channel_id = ?')
      .get(req.user.id, channelB.id);
    const orderA = prefA && prefA.sort_order != null ? prefA.sort_order : channelA.id;
    const orderB = prefB && prefB.sort_order != null ? prefB.sort_order : channelB.id;

    const upsert = db.prepare(
      `INSERT INTO chat_channel_prefs (user_id, channel_id, sort_order) VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET sort_order = excluded.sort_order`
    );
    await upsert.run(req.user.id, channelA.id, orderB);
    await upsert.run(req.user.id, channelB.id, orderA);

    res.json({ ok: true });
  })
);

router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    const from = isValidDate(req.query.from) ? req.query.from : '';
    const to = isValidDate(req.query.to) ? req.query.to : '';

    let results = [];
    if (q || from || to) {
      const clauses = [];
      const params = [];
      if (q) {
        clauses.push('chat_messages.body ILIKE ? ESCAPE \'\\\'');
        params.push(`%${escapeLike(q)}%`);
      }
      if (from) {
        clauses.push('(chat_messages.created_at)::date >= (?)::date');
        params.push(from);
      }
      if (to) {
        clauses.push('(chat_messages.created_at)::date <= (?)::date');
        params.push(to);
      }
      results = await db
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
      channels: await channelsWithUnread(req.user),
    });
  })
);

router.get(
  '/c/:id',
  asyncHandler(async (req, res) => {
    const channel = await db.prepare('SELECT * FROM chat_channels WHERE id = ?').get(req.params.id);
    if (!channel) return res.status(404).render('error', { message: 'Channel not found.' });
    if (channel.admin_only && req.user.role !== 'admin') return res.status(403).render('error', { message: 'This channel is admin-only.' });

    const from = isValidDate(req.query.from) ? req.query.from : '';
    const to = isValidDate(req.query.to) ? req.query.to : '';

    let messages;
    if (from || to) {
      const clauses = ['chat_messages.channel_id = ?'];
      const params = [channel.id];
      if (from) {
        clauses.push('(chat_messages.created_at)::date >= (?)::date');
        params.push(from);
      }
      if (to) {
        clauses.push('(chat_messages.created_at)::date <= (?)::date');
        params.push(to);
      }
      messages = await db
        .prepare(
          `SELECT chat_messages.*, users.name AS user_name, ${REPLY_SELECT_SQL}
           FROM chat_messages JOIN users ON users.id = chat_messages.user_id
           ${REPLY_JOIN_SQL}
           WHERE ${clauses.join(' AND ')}
           ORDER BY chat_messages.id ASC LIMIT 500`
        )
        .all(...params);
    } else {
      messages = (
        await db
          .prepare(
            `SELECT chat_messages.*, users.name AS user_name, ${REPLY_SELECT_SQL}
             FROM chat_messages JOIN users ON users.id = chat_messages.user_id
             ${REPLY_JOIN_SQL}
             WHERE chat_messages.channel_id = ?
             ORDER BY chat_messages.id DESC LIMIT ?`
          )
          .all(channel.id, INITIAL_LIMIT)
      ).reverse();
    }

    await markRead(req.user.id, channel.id);

    const pinnedMessages = await db
      .prepare(
        `SELECT chat_messages.*, users.name AS user_name
         FROM chat_messages JOIN users ON users.id = chat_messages.user_id
         WHERE chat_messages.channel_id = ? AND chat_messages.pinned = 1
         ORDER BY chat_messages.pinned_at DESC`
      )
      .all(channel.id);

    res.render('chat/index', {
      title: `#${channel.name}`,
      channel,
      channels: await channelsWithUnread(req.user),
      unreadOnly: req.query.unreadOnly === '1',
      messages,
      pinnedMessages,
      from,
      to,
    });
  })
);

router.get(
  '/c/:id/messages',
  asyncHandler(async (req, res) => {
    const channel = await db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });

    const afterId = Number.parseInt(req.query.after, 10) || 0;
    const messages = await db
      .prepare(
        `SELECT chat_messages.*, users.name AS user_name, ${REPLY_SELECT_SQL}
         FROM chat_messages JOIN users ON users.id = chat_messages.user_id
         ${REPLY_JOIN_SQL}
         WHERE chat_messages.channel_id = ? AND chat_messages.id > ? ORDER BY chat_messages.id ASC LIMIT 100`
      )
      .all(channel.id, afterId);

    if (messages.length) await markRead(req.user.id, channel.id);

    res.json({ messages: messages.map(serialize) });
  })
);

router.post(
  '/messages/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    const message = await db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found.' });

    await db.prepare('DELETE FROM chat_messages WHERE id = ?').run(message.id);
    res.json({ ok: true });
  })
);

router.post(
  '/messages/:id/pin',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    const message = await db.prepare('SELECT id, pinned FROM chat_messages WHERE id = ?').get(req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found.' });

    const next = message.pinned ? 0 : 1;
    await db
      .prepare(
        `UPDATE chat_messages SET pinned = ?, pinned_by = ?, pinned_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ?`
      )
      .run(next, next ? req.user.id : null, next, message.id);

    if (!next) return res.json({ ok: true, pinned: false });

    const pinned = await db
      .prepare(
        `SELECT chat_messages.*, users.name AS user_name, ${REPLY_SELECT_SQL}
         FROM chat_messages JOIN users ON users.id = chat_messages.user_id
         ${REPLY_JOIN_SQL}
         WHERE chat_messages.id = ?`
      )
      .get(message.id);
    res.json({ ok: true, pinned: true, message: serialize(pinned) });
  })
);

router.post(
  '/channels/:id/lock',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    const channel = await db.prepare('SELECT id, locked FROM chat_channels WHERE id = ?').get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });
    const next = channel.locked ? 0 : 1;
    await db.prepare('UPDATE chat_channels SET locked = ? WHERE id = ?').run(next, channel.id);
    res.json({ ok: true, locked: Boolean(next) });
  })
);

router.post(
  '/channels/:id/admin-only',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    const channel = await db.prepare('SELECT id, admin_only FROM chat_channels WHERE id = ?').get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });
    const next = channel.admin_only ? 0 : 1;
    await db.prepare('UPDATE chat_channels SET admin_only = ? WHERE id = ?').run(next, channel.id);
    res.json({ ok: true, adminOnly: Boolean(next) });
  })
);

router.post(
  '/channels/:id/rename',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    const channel = await db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });

    const name = (req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Channel name is required.' });

    await db.prepare('UPDATE chat_channels SET name = ? WHERE id = ?').run(name, channel.id);
    res.json({ ok: true, name });
  })
);

router.post(
  '/channels/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    const channel = await db.prepare('SELECT id FROM chat_channels WHERE id = ?').get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });

    await db.prepare('DELETE FROM chat_messages WHERE channel_id = ?').run(channel.id);
    await db.prepare('DELETE FROM chat_channel_prefs WHERE channel_id = ?').run(channel.id);
    await db.prepare('DELETE FROM chat_reads WHERE channel_id = ?').run(channel.id);
    await db.prepare('DELETE FROM chat_channels WHERE id = ?').run(channel.id);

    res.json({ ok: true });
  })
);

router.post(
  '/c/:id',
  (req, res, next) => chatUpload.single('attachment')(req, res, (err) => {
    if (err) {
      const wantsJson = req.get('Accept') === 'application/json';
      if (wantsJson) return res.status(400).json({ error: err.message });
      return res.redirect(`/chat/c/${req.params.id}`);
    }
    next();
  }),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const channel = await db.prepare('SELECT id, name, locked, admin_only FROM chat_channels WHERE id = ?').get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });
    if (channel.locked && req.user.role !== 'admin') {
      const wantsJson = req.get('Accept') === 'application/json';
      if (wantsJson) return res.status(403).json({ error: 'Channel is locked.' });
      return res.redirect(`/chat/c/${channel.id}`);
    }

    const body = (req.body.body || '').trim().slice(0, 2000);
    const wantsJson = req.get('Accept') === 'application/json';

    let attachmentUrl = null;
    let attachmentName = null;
    if (req.file) {
      attachmentUrl = await putFile(req.file);
      attachmentName = req.file.originalname;
    }

    if (!body && !attachmentUrl) {
      if (wantsJson) return res.status(400).json({ error: 'Message or attachment required.' });
      return res.redirect(`/chat/c/${channel.id}`);
    }

    // Only honour reply_to if it's a real message in this same channel -
    // otherwise silently post as a normal message rather than erroring, in
    // case the quoted message got deleted between the reply button being
    // clicked and this submit going through.
    let replyToId = null;
    if (req.body.reply_to) {
      const parent = await db.prepare('SELECT id FROM chat_messages WHERE id = ? AND channel_id = ?').get(req.body.reply_to, channel.id);
      if (parent) replyToId = parent.id;
    }

    const result = await db
      .prepare('INSERT INTO chat_messages (channel_id, user_id, body, attachment_url, attachment_name, reply_to_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .run(channel.id, req.user.id, body || null, attachmentUrl, attachmentName, replyToId);
    const row = await db
      .prepare(
        `SELECT chat_messages.*, users.name AS user_name, ${REPLY_SELECT_SQL}
         FROM chat_messages JOIN users ON users.id = chat_messages.user_id
         ${REPLY_JOIN_SQL}
         WHERE chat_messages.id = ?`
      )
      .get(result.lastInsertRowid);

    await markRead(req.user.id, channel.id);

    // Notify everyone who can see this channel except the sender - same
    // visibility rule the channel list itself uses (admin_only channels
    // only page admins).
    const recipients = await db
      .prepare(
        channel.admin_only
          ? "SELECT id FROM users WHERE role = 'admin' AND active = 1 AND id != ?"
          : 'SELECT id FROM users WHERE active = 1 AND id != ?'
      )
      .all(req.user.id);
    const preview = body || (attachmentName ? `📎 ${attachmentName}` : '');
    await sendPushToUsers(
      recipients.map((r) => r.id),
      {
        title: `#${channel.name}`,
        body: `${req.user.name}: ${preview}`.slice(0, 150),
        url: `/chat/c/${channel.id}`,
        tag: `chat-${channel.id}`,
      }
    );

    if (wantsJson) return res.json({ message: serialize(row) });
    res.redirect(`/chat/c/${channel.id}`);
  })
);

router.getUnreadTotal = getUnreadTotal;
module.exports = router;
