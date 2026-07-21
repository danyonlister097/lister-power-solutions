const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { db: dbConfig } = require('../config');
const logger = require('../lib/logger');

// Vercel serverless functions are short-lived and can run many concurrent
// invocations, so each pool instance is kept small - use Neon's pooled
// ("-pooler") connection string as DATABASE_URL so the real connection
// fan-out is handled by PgBouncer on Neon's side, not by this process.
const pool = new Pool({
  connectionString: dbConfig.connectionString,
  max: 5,
});

// Required by pg: an idle client that loses its connection (network blip,
// Neon pooler recycling it, etc.) emits 'error' on the pool. With no
// listener, Node treats it as an uncaught exception and kills the whole
// process - so one transient disconnect would take the entire server down.
pool.on('error', (err) => {
  logger.error('Postgres pool error', { error: err.message, stack: err.stack });
});

// pg-pool has a known race on connection-time failures (e.g. a TLS
// handshake dropped mid-connect while growing the pool under concurrent
// load, which cold starts + Neon's pooler make more likely): the rejection
// can surface a tick before pg's own handler attaches to it, so Node sees
// it as unhandled and kills the process before pool.on('error') above ever
// gets a chance to run. This is the last line of defence against that -
// log it and keep the process (and every other in-flight request) alive,
// since a transient connection drop should not take the whole function down.
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection (kept process alive)', {
    error: err && err.message,
    stack: err && err.stack,
  });
});

// Translates the small set of SQLite-isms this codebase's SQL strings use
// into Postgres equivalents, so the 200+ existing call sites didn't need
// their SQL text rewritten by hand:
//   datetime('now')              -> current UTC time, same 'YYYY-MM-DD HH:MM:SS' shape
//   datetime('now', '-90 days')  -> same, offset by an interval
function translateDateFns(sql) {
  return sql
    .replace(/datetime\(\s*'now'\s*,\s*'([+-]?\d+)\s*days?'\s*\)/gi, (_m, n) => {
      const sign = n.trim().startsWith('-') ? '-' : '+';
      const amount = n.trim().replace(/^[+-]/, '');
      return `to_char((now() AT TIME ZONE 'UTC') ${sign} interval '${amount} days', 'YYYY-MM-DD HH24:MI:SS')`;
    })
    .replace(/datetime\(\s*'now'\s*\)/gi, `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
}

// Rewrites either style of placeholder this codebase uses into Postgres's
// $1, $2... and returns the matching positional values array:
//   '?'      (positional) - args are bound in call order, e.g. .get(id)
//   '@name'  (named)      - a single {name: value} object, e.g. .run({id, name})
// better-sqlite3 supported both call shapes directly; this reproduces both
// on top of pg, which only understands $-numbered placeholders.
function bindQuery(sql, args) {
  const text = translateDateFns(sql);

  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const named = args[0];
    const values = [];
    const bound = text.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => {
      if (!(name in named)) throw new Error(`db: missing named parameter @${name}`);
      values.push(named[name]);
      return `$${values.length}`;
    });
    return { text: bound, values };
  }

  let n = 0;
  const bound = text.replace(/\?/g, () => `$${(n += 1)}`);
  return { text: bound, values: args };
}

function prepare(sql) {
  return {
    async get(...args) {
      const { text, values } = bindQuery(sql, args);
      const result = await pool.query(text, values);
      return result.rows[0];
    },
    async all(...args) {
      const { text, values } = bindQuery(sql, args);
      const result = await pool.query(text, values);
      return result.rows;
    },
    async run(...args) {
      const { text, values } = bindQuery(sql, args);
      const result = await pool.query(text, values);
      const out = { changes: result.rowCount };
      if (result.rows[0] && 'id' in result.rows[0]) out.lastInsertRowid = result.rows[0].id;
      return out;
    },
  };
}

async function ensureSeedData() {
  const categories = await pool.query('SELECT id FROM business_asset_categories LIMIT 1');
  if (categories.rowCount === 0) {
    const starters = ['Power Tools', 'Ladders', 'HVAC Equipment', 'Testing Equipment', 'Vehicles', 'Safety Equipment', 'Other'];
    for (const name of starters) {
      await pool.query('INSERT INTO business_asset_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    }
  }

  // Chat went from a single global room to multiple channels - every
  // install needs at least a "General" channel to exist before anyone can
  // post. Owned by the first admin; skipped (and retried next boot) if no
  // admin has been seeded yet.
  const anyChannel = await pool.query('SELECT id FROM chat_channels LIMIT 1');
  if (anyChannel.rowCount === 0) {
    const owner =
      (await pool.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")).rows[0] ||
      (await pool.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0];
    if (owner) {
      await pool.query('INSERT INTO chat_channels (name, created_by) VALUES ($1, $2)', ['General', owner.id]);
    }
  }
}

let ready;
function initSchema() {
  if (!ready) {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    ready = pool.query(schema).then(ensureSeedData);
  }
  return ready;
}

module.exports = { prepare, pool, ready: initSchema() };
