const crypto = require('crypto');

const KEY_LENGTH = 64;

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `${salt}:${derived.toString('hex')}`;
}

function verify(password, stored) {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH);
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

module.exports = { hash, verify };
