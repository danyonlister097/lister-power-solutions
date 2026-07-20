const session = require('express-session');
const db = require('../db');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, sess, expires) VALUES (@sid, @sess, @expires) ' +
        'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this.pruneStmt.run(Date.now());
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const ttl = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : DEFAULT_TTL_MS;
      this.setStmt.run({ sid, sess: JSON.stringify(sessionData), expires: Date.now() + ttl });
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb || (() => {}));
  }
}

module.exports = SqliteSessionStore;
