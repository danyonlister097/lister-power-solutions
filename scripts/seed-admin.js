const db = require('../src/db');
const config = require('../src/config');
const passwords = require('../src/lib/passwords');

function main() {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existingAdmin) {
    console.log('An admin user already exists - nothing to do.');
    return;
  }

  if (!config.admin.email || !config.admin.password) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env to seed the first admin.');
    process.exitCode = 1;
    return;
  }

  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
    config.admin.name,
    config.admin.email.trim().toLowerCase(),
    passwords.hash(config.admin.password),
    'admin'
  );

  console.log(`Admin user created: ${config.admin.email}`);
}

main();
