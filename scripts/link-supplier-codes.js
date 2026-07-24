/**
 * Reads the ServiceM8/CNW CSV export and populates supplier_code on matching
 * inventory_items rows (matched case-insensitively on name).
 *
 * Usage:  node scripts/link-supplier-codes.js <path-to-csv>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/link-supplier-codes.js <path-to-csv>');
  process.exit(1);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    // Simple split — fields in this CSV don't contain commas inside quotes
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => {
      row[h] = (cols[i] || '').trim();
    });
    return row;
  });
}

async function main() {
  const text = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const rows = parseCsv(text).filter((r) => r['Item Number'] && r['Name']);

  const items = await db.prepare('SELECT id, name FROM inventory_items').all();
  const itemMap = new Map(items.map((i) => [i.name.toLowerCase().trim(), i]));

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const row of rows) {
    const code = row['Item Number'].trim();
    const name = row['Name'].trim().toLowerCase();
    const item = itemMap.get(name);

    if (!item) {
      console.log(`  NOT FOUND: "${row['Name']}"`);
      notFound++;
      continue;
    }

    const existing = await db.prepare('SELECT supplier_code FROM inventory_items WHERE id = ?').get(item.id);
    if (existing.supplier_code) {
      skipped++;
      continue;
    }

    await db.prepare('UPDATE inventory_items SET supplier_code = ?, updated_at = datetime(\'now\') WHERE id = ?').run(code, item.id);
    console.log(`  Linked: "${row['Name']}" → ${code}`);
    updated++;
  }

  console.log(`\nDone. Updated: ${updated} | Skipped (already had code): ${skipped} | Not matched: ${notFound}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
