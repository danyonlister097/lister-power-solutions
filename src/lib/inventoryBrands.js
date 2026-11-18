const db = require('../db');

// Supplier codes are (almost always) a 3-letter brand prefix followed by a
// product-line code with no delimiter, e.g. HAGADC932T -> "HAG" + "ADC932T".
function prefixOf(supplierCode) {
  return supplierCode && supplierCode.trim() ? supplierCode.trim().slice(0, 3).toUpperCase() : null;
}

// Applies every confirmed prefix -> brand mapping to any item that doesn't
// have a brand yet. Run after a prefix is newly confirmed (to catch every
// existing item sharing it) and whenever the resolver page loads (to catch
// anything imported since using an already-known prefix). Returns the
// number of items branded.
async function applyKnownPrefixes() {
  const mappings = await db.prepare('SELECT prefix, brand FROM inventory_brand_prefixes').all();
  let updated = 0;
  for (const { prefix, brand } of mappings) {
    const result = await db
      .prepare(
        `UPDATE inventory_items SET brand = ?, updated_at = datetime('now')
         WHERE brand IS NULL AND supplier_code IS NOT NULL AND UPPER(LEFT(supplier_code, 3)) = ?`
      )
      .run(brand, prefix);
    updated += result.changes;
  }
  return updated;
}

module.exports = { prefixOf, applyKnownPrefixes };
