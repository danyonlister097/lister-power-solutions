// One-off script to import all MYOB contacts from the PDF export.
// Run with: node scripts/import-myob-contacts-full.js
// Safe to re-run — skips any customer whose name already exists (case-insensitive).

const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const contacts = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'contacts_final.json'), 'utf8')
);

async function run() {
  let created = 0;
  let skipped = 0;

  for (const c of contacts) {
    const name = c.name.trim();
    if (!name) continue;

    const existing = await db.prepare('SELECT id FROM customers WHERE LOWER(name) = LOWER(?)').get(name);
    if (existing) {
      skipped++;
      continue;
    }

    const notes = c.abn ? `ABN: ${c.abn}` : null;

    await db.prepare(`
      INSERT INTO customers (name, phone, email, address_street, address_city, address_state, address_postcode, address_country, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Australia', ?)
    `).run(
      name,
      c.phone || null,
      c.email || null,
      c.street || null,
      c.city || null,
      c.state || null,
      c.postcode || null,
      notes,
    );
    created++;
  }

  console.log(`Done — ${created} added, ${skipped} already existed.`);
  process.exit(0);
}

run().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
