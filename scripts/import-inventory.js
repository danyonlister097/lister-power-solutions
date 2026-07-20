const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const SOURCE_FILE =
  process.argv[2] ||
  path.join(
    'C:\\Users\\Danyon\\AppData\\Local\\Temp\\claude',
    'C--Users-Danyon-Desktop-Tegan-Danyon-Stuff-Danyon-Lister-Power-Solutions-Claude-Claude',
    'c423eb7c-2584-4d99-8b66-c35ade7cfd39',
    'scratchpad',
    'inventory_import.json'
  );

async function main() {
  await db.ready;

  const items = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));

  const findByName = db.prepare('SELECT id FROM inventory_items WHERE name = ?');
  const insert = db.prepare(
    `INSERT INTO inventory_items (name, category, unit, quantity_on_hand, unit_cost, unit_cost_inc_gst)
     VALUES (?, ?, ?, 0, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE inventory_items SET category = ?, unit_cost = ?, unit_cost_inc_gst = ?, updated_at = datetime('now')
     WHERE id = ?`
  );

  let created = 0;
  let updated = 0;

  for (const item of items) {
    const existing = await findByName.get(item.name);
    if (existing) {
      await update.run(item.category || null, item.unit_cost_ex_gst, item.unit_cost_inc_gst, existing.id);
      updated += 1;
    } else {
      await insert.run(item.name, item.category || null, 'each', item.unit_cost_ex_gst, item.unit_cost_inc_gst);
      created += 1;
    }
  }

  console.log(`Inventory import complete: ${created} created, ${updated} updated (of ${items.length} total).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
