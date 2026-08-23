const webpush = require('web-push');
const db = require('../db');
const config = require('../config');
const logger = require('./logger');

const configured = Boolean(config.push.publicKey && config.push.privateKey);
if (configured) {
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
} else {
  logger.warn('Push notifications disabled (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set)');
}

// Sends `payload` to every device a user has subscribed on. A subscription
// the push service reports as gone (410) or not found (404) means the user
// uninstalled the app / cleared data / the device is gone for good - those
// rows are pruned so future sends don't keep retrying them.
async function sendPushToUser(userId, payload) {
  if (!configured) return;
  const subs = await db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  const body = JSON.stringify(payload);

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        logger.error('Push notification failed', { userId, subId: sub.id, error: err.message });
      }
    }
  }
}

async function sendPushToUsers(userIds, payload) {
  const unique = [...new Set(userIds)];
  for (const id of unique) await sendPushToUser(id, payload);
}

async function sendPushToAdmins(payload) {
  const admins = await db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all();
  await sendPushToUsers(admins.map((a) => a.id), payload);
}

module.exports = { sendPushToUser, sendPushToUsers, sendPushToAdmins };
