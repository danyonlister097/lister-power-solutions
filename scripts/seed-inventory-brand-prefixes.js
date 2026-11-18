/**
 * Seeds the confidently-identified supplier-code prefix -> brand mappings
 * (confirmed against real item names already in the data, not guessed
 * blind) and backfills inventory_items.brand for every item that matches.
 *
 * Safe to re-run: upserts the mapping, then only fills brand where it's
 * still NULL.
 *
 * Usage: node scripts/seed-inventory-brand-prefixes.js
 */

require('dotenv').config();
const db = require('../src/db');
const { applyKnownPrefixes } = require('../src/lib/inventoryBrands');

const CONFIDENT_PREFIXES = {
  CLI: 'Clipsal',
  HAG: 'Hager',
  NHP: 'NHP',
  MAT: 'Matelec',
  DAI: 'Daikin',
  HIS: 'Hisense',
  MHI: 'Mitsubishi Heavy Industries',
  SCH: 'Schneider Electric',
  VEN: 'Ventair',
  PHI: 'Philips',
  // Second pass - found while reviewing the /inventory/brands resolver page
  // after the first batch. Each confirmed the same way: the brand name is
  // literally present in one of that prefix's own item names/codes, or (for
  // ATO) by cross-referencing an existing, already-well-named item.
  ATO: 'Atom', // id 3: "Atom 30 Watt 240mm ECLIPSE Ducted Exhaust Fan..."
  CRC: 'CRC', // "CRC ZINC IT GALVANIC RUST PROTECT 350g"
  DEK: 'Dektite', // "DEKTITE OD 0-35MM BLACK"
  FLU: 'Fluke', // "...VOLT ALERT STICK" (FLUFLK code = Fluke VoltAlert)
  FUJ: 'Fujitsu', // "FUJITSU LIFESTYLE HWS 7.1KW R32 SET"
  HPM: 'HPM', // "...BATHROOM FAN LGT HEATER..." (HPMBH code)
  IXL: 'IXL', // "BATHROOM FAN LIGHT HEATER VIVID 2HEAT" - IXL Tastic
  LEG: 'Legrand', // "...FAN CNTRL MECH 100VA WHITE" (LEGEM3FCWE code)
  MIT: 'Mitsubishi Electric', // code MITMSZAP71VGKIT matches real MSZ-AP model codes (distinct from MHI = Mitsubishi Heavy Industries)
  OME: 'Omega', // same prefix also has an item literally named "OMEGA 60CM 85L 5 FUNC OVEN"
  OSR: 'Osram', // "...HALOGEN BI-PIN OVEN LAMP..." (OSR66725OVENG code)
  PAN: 'Panasonic', // code PANCS/CU-RZ25XKR matches real Panasonic aircon model codes
  TEL: 'Telstra', // "TELSTRA ROPE 6MM X 400MT BLUE/YELLOW"
  VES: 'Vessel', // "VESSEL ELECTRIC SCREWDRIVER USB 3 SPEED"
};

async function main() {
  for (const [prefix, brand] of Object.entries(CONFIDENT_PREFIXES)) {
    await db
      .prepare('INSERT INTO inventory_brand_prefixes (prefix, brand) VALUES (?, ?) ON CONFLICT (prefix) DO UPDATE SET brand = excluded.brand')
      .run(prefix, brand);
    console.log(`Seeded ${prefix} -> ${brand}`);
  }

  const updated = await applyKnownPrefixes();
  console.log(`\nBackfilled brand on ${updated} inventory item(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
