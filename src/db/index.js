const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { db: dbConfig } = require('../config');

fs.mkdirSync(path.dirname(dbConfig.file), { recursive: true });

const db = new DatabaseSync(dbConfig.file);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const hadJobAssigneesTable = Boolean(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_assignees'").get()
);

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight migration for columns added after initial release -
// CREATE TABLE IF NOT EXISTS above only helps on a fresh database.
const jobColumns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
if (!jobColumns.includes('all_day')) {
  db.exec('ALTER TABLE jobs ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0');
}
if (!jobColumns.includes('color')) {
  db.exec('ALTER TABLE jobs ADD COLUMN color TEXT');
}

// The users.role CHECK constraint moved from ('admin','tech') to
// ('admin','trade','apprentice'). SQLite can't ALTER a CHECK constraint in
// place, so rebuild the table when the old constraint is still present.
const usersTableDef = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
if (usersTableDef && usersTableDef.sql.includes(`'tech'`)) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'trade', 'apprentice')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO users_new (id, name, email, password_hash, role, active, created_at, updated_at)
      SELECT id, name, email, password_hash, CASE WHEN role = 'tech' THEN 'trade' ELSE role END, active, created_at, updated_at
      FROM users
    `);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('PRAGMA foreign_keys = ON');
}

const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('sort_order')) {
  db.exec('ALTER TABLE users ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE users SET sort_order = id');
}
if (!userColumns.includes('hourly_rate')) {
  db.exec('ALTER TABLE users ADD COLUMN hourly_rate REAL');
}

// Multi-assignee support: backfill job_assignees from the legacy single
// jobs.assigned_to column the first time this table is created, then keep
// reconciling on every boot (idempotent) in case any row was written by
// older code between the schema change and the route rewrite landing.
if (!hadJobAssigneesTable) {
  db.exec(`
    INSERT INTO job_assignees (job_id, user_id)
    SELECT id, assigned_to FROM jobs WHERE assigned_to IS NOT NULL
  `);
}
db.exec(`
  INSERT INTO job_assignees (job_id, user_id)
  SELECT jobs.id, jobs.assigned_to FROM jobs
  WHERE jobs.assigned_to IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM job_assignees
      WHERE job_assignees.job_id = jobs.id AND job_assignees.user_id = jobs.assigned_to
    )
`);

// Chat went from a single global room to multiple channels - existing
// messages predate the channel_id column, so backfill them into a "General"
// channel the first time this runs on an older database.
const chatMessageColumns = db.prepare('PRAGMA table_info(chat_messages)').all().map((c) => c.name);
if (!chatMessageColumns.includes('channel_id')) {
  db.exec('ALTER TABLE chat_messages ADD COLUMN channel_id INTEGER REFERENCES chat_channels(id)');
}
const orphanedChatMessages = db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id IS NULL').get();
if (orphanedChatMessages.n > 0 || !db.prepare('SELECT id FROM chat_channels LIMIT 1').get()) {
  let general = db.prepare("SELECT id FROM chat_channels WHERE name = 'General'").get();
  if (!general) {
    const owner =
      db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() ||
      db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
    if (owner) {
      const result = db.prepare('INSERT INTO chat_channels (name, created_by) VALUES (?, ?)').run('General', owner.id);
      general = { id: result.lastInsertRowid };
    }
  }
  if (general) {
    db.prepare('UPDATE chat_messages SET channel_id = ? WHERE channel_id IS NULL').run(general.id);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_id ON chat_messages(channel_id)');

const clockEventColumns = db.prepare('PRAGMA table_info(clock_events)').all().map((c) => c.name);
if (!clockEventColumns.includes('latitude')) {
  db.exec('ALTER TABLE clock_events ADD COLUMN latitude REAL');
  db.exec('ALTER TABLE clock_events ADD COLUMN longitude REAL');
  db.exec('ALTER TABLE clock_events ADD COLUMN accuracy REAL');
}

const inventoryItemColumns = db.prepare('PRAGMA table_info(inventory_items)').all().map((c) => c.name);
if (!inventoryItemColumns.includes('unit_cost_inc_gst')) {
  db.exec('ALTER TABLE inventory_items ADD COLUMN unit_cost_inc_gst REAL');
}

if (!db.prepare('SELECT id FROM business_asset_categories LIMIT 1').get()) {
  const insertCategory = db.prepare('INSERT INTO business_asset_categories (name) VALUES (?)');
  ['Power Tools', 'Ladders', 'HVAC Equipment', 'Testing Equipment', 'Vehicles', 'Safety Equipment', 'Other'].forEach(
    (name) => insertCategory.run(name)
  );
}

// job_forms.job_id moved from NOT NULL to nullable (drafts created from the
// Forms tab start unassigned). SQLite can't ALTER a NOT NULL constraint in
// place, so rebuild the table when the old constraint is still present.
const jobFormsTableDef = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'job_forms'").get();
if (jobFormsTableDef && jobFormsTableDef.sql.includes('job_id INTEGER NOT NULL')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      CREATE TABLE job_forms_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER REFERENCES jobs(id),
        template_id INTEGER REFERENCES form_templates(id),
        name TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO job_forms_new (id, job_id, template_id, name, filename, mime_type, size_bytes, completed, created_by, created_at, updated_at)
      SELECT id, job_id, template_id, name, filename, mime_type, size_bytes, completed, created_by, created_at, updated_at
      FROM job_forms
    `);
    db.exec('DROP TABLE job_forms');
    db.exec('ALTER TABLE job_forms_new RENAME TO job_forms');
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_forms_job_id ON job_forms(job_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_forms_template_id ON job_forms(template_id)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('PRAGMA foreign_keys = ON');
}

const leaveRequestColumns = db.prepare('PRAGMA table_info(leave_requests)').all().map((c) => c.name);
if (!leaveRequestColumns.includes('admin_comment')) {
  db.exec('ALTER TABLE leave_requests ADD COLUMN admin_comment TEXT');
}

const jobColumnsForQuotes = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
if (!jobColumnsForQuotes.includes('quote_id')) {
  db.exec('ALTER TABLE jobs ADD COLUMN quote_id INTEGER REFERENCES quotes(id)');
}

// quote_number was added after quotes already shipped - backfill existing
// rows (in creation order) so every quote has one, matching invoice_number.
const quoteColumns = db.prepare('PRAGMA table_info(quotes)').all().map((c) => c.name);
if (!quoteColumns.includes('quote_number')) {
  db.exec('ALTER TABLE quotes ADD COLUMN quote_number TEXT');
  db.prepare('SELECT id FROM quotes ORDER BY id')
    .all()
    .forEach((q, i) => {
      db.prepare('UPDATE quotes SET quote_number = ? WHERE id = ?').run(`QT-${String(i + 1).padStart(4, '0')}`, q.id);
    });
}

const businessAssetColumns = db.prepare('PRAGMA table_info(business_assets)').all().map((c) => c.name);
if (!businessAssetColumns.includes('next_service_due')) {
  db.exec('ALTER TABLE business_assets ADD COLUMN next_service_due TEXT');
  db.exec('ALTER TABLE business_assets ADD COLUMN registration_expiry TEXT');
}
if (!businessAssetColumns.includes('current_odometer_km')) {
  db.exec('ALTER TABLE business_assets ADD COLUMN current_odometer_km REAL');
  db.exec('ALTER TABLE business_assets ADD COLUMN service_due_at_km REAL');
}

module.exports = db;
