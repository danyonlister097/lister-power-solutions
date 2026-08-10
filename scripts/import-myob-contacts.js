// One-off script to import MYOB contacts export into the customers table.
// Run with: node scripts/import-myob-contacts.js
// Safe to re-run — skips any customer whose name already exists.

const db = require('../src/db');

const contacts = [
  {
    name: 'Advanced Sheetmetal',
    email: 'John@advsheetmetal.com.au',
    address_street: '25 Hasp Street',
    address_city: 'Seventeen Mile Rocks',
    address_state: 'QLD',
  },
  {
    name: 'Micaela Benson',
    email: 'micaela.benson02@gmail.com',
    address_street: '49 Bertram St',
    address_city: 'Stafford',
    address_state: 'QLD',
    address_postcode: '4053',
  },
  {
    name: 'Commercial Asset Maintenance',
    email: 'accounts@commercialassetmaintenance.com',
    address_street: '4/13 Focal Av',
    address_city: 'Coolum Beach',
    address_state: 'QLD',
    address_postcode: '4573',
    notes: 'ABN: 57 665 481 096',
  },
  {
    name: 'Eresidential',
    email: 'pm.p1@eresidential.com.au',
    address_street: '9/3460 Pacific Highway',
    address_city: 'Springwood',
    address_state: 'QLD',
  },
  {
    name: 'Locate Property',
    email: 'accounts@locate.net.au',
    address_street: '1302 Wynnum Road',
    address_city: 'Tingalpa',
    address_state: 'QLD',
    address_postcode: '4173',
  },
  {
    name: 'Sulaiman Ma',
    email: 'jessie@merakirealty.com.au',
    address_street: '32 Maurice Ct',
    address_city: 'Eagleby',
    address_state: 'QLD',
    address_postcode: '4207',
  },
  {
    name: 'Paradise Portable Homes',
  },
  {
    name: 'Parker Air Solutions',
    phone: '0432590392',
    email: 'Zac@parkerairsolutions.com.au',
    address_street: '101 Forest Ridge Drive',
    address_city: 'Narangba',
    address_state: 'QLD',
    address_postcode: '4504',
    notes: 'ABN: 15 744 630 317',
  },
  {
    name: 'Quantum Medical Imaging Loganholme',
  },
  {
    name: 'Quantum Medical Imaging Rochedale',
  },
  {
    name: 'RCC National PTY Limited',
    email: 'accounts@rccnational.com.au',
    address_street: '30 Bell-Are Ave',
    address_city: 'Northgate',
    address_state: 'QLD',
    address_postcode: '4013',
    notes: 'ABN: 56 143 574 574',
  },
  {
    name: 'Ripley Real Estate',
    phone: '3063 7558',
    email: 'bills@ripleyrealestate.com.au',
    address_street: 'Corporate House, Building 6/2404 Logan Rd',
    address_city: 'Eight Mile Plains',
    address_state: 'QLD',
  },
  {
    name: 'Flexipod Solutions',
    email: 'sales@flexipodsolutions.com.au',
    address_street: '26 Beechwood Cl',
    address_city: 'Stretton',
    address_state: 'QLD',
    address_postcode: '4116',
  },
];

async function run() {
  let created = 0;
  let skipped = 0;

  for (const c of contacts) {
    const existing = await db.prepare('SELECT id FROM customers WHERE LOWER(name) = LOWER(?)').get(c.name);
    if (existing) {
      console.log(`  SKIP  ${c.name}`);
      skipped++;
      continue;
    }

    await db.prepare(`
      INSERT INTO customers (name, phone, email, address_street, address_city, address_state, address_postcode, address_country, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Australia', ?)
    `).run(
      c.name,
      c.phone || null,
      c.email || null,
      c.address_street || null,
      c.address_city || null,
      c.address_state || null,
      c.address_postcode || null,
      c.notes || null,
    );
    console.log(`  ADD   ${c.name}`);
    created++;
  }

  console.log(`\nDone — ${created} added, ${skipped} skipped.`);
  process.exit(0);
}

run().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
