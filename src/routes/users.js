const express = require('express');
const db = require('../db');
const passwords = require('../lib/passwords');
const { verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');
const { PERMISSIONS, PERMISSION_KEYS, DEFAULT_KEYS_BY_ROLE } = require('../lib/permissions');

const router = express.Router();

const ROLES = ['admin', 'trade', 'apprentice'];

// Gated at the mount point in app.js by the "employees" permission instead
// of a hardcoded role. Note: granting this to a non-admin lets them edit
// any employee's role, including their own - same power an admin already
// has, just extended to whoever gets this checkbox.

async function getUserOr404(req, res) {
  const user = await db.prepare('SELECT id, name, email, role, active, hourly_rate FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    res.status(404).render('error', { message: 'Employee not found.' });
    return null;
  }
  return user;
}

function parseHourlyRate(raw) {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parsePermissionKeys(body) {
  return [].concat(body.permissions || []).filter((k) => PERMISSION_KEYS.includes(k));
}

// Saved unconditionally, even for an admin whose access doesn't currently
// depend on these rows (loadUser gives admins every key regardless) - so
// that if they're ever demoted to trade/apprentice, the form's last-checked
// boxes take effect immediately instead of leaving them with no access
// until someone remembers to configure it.
async function savePermissions(userId, keys) {
  await db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
  for (const key of keys) {
    await db.prepare('INSERT INTO user_permissions (user_id, permission_key) VALUES (?, ?)').run(userId, key);
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const users = await db.prepare('SELECT id, name, email, role, active FROM users WHERE active = 1 ORDER BY role, name').all();
    res.render('users/list', { title: 'Employees', users });
  })
);

router.get('/new', (req, res) => {
  res.render('users/form', {
    title: 'New Employee',
    targetUser: {},
    error: null,
    PERMISSIONS,
    DEFAULT_KEYS_BY_ROLE,
    selectedPermissions: DEFAULT_KEYS_BY_ROLE.trade,
  });
});

router.post(
  '/',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const b = req.body;
    const selectedPermissions = parsePermissionKeys(b);

    if (!b.name || !b.name.trim() || !b.email || !b.email.trim() || !b.password || b.password.length < 8) {
      return res.status(400).render('users/form', {
        title: 'New Employee',
        targetUser: b,
        error: 'Name, email, and a password of at least 8 characters are required.',
        PERMISSIONS,
        DEFAULT_KEYS_BY_ROLE,
        selectedPermissions,
      });
    }

    const email = b.email.trim().toLowerCase();
    const existing = await db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(400).render('users/form', {
        title: 'New Employee',
        targetUser: b,
        error: 'An employee with that email already exists.',
        existingUser: existing,
        PERMISSIONS,
        DEFAULT_KEYS_BY_ROLE,
        selectedPermissions,
      });
    }

    const nextSortOrder = (await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM users').get()).next;

    const result = await db
      .prepare('INSERT INTO users (name, email, password_hash, role, sort_order, hourly_rate) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .run(
        b.name.trim(),
        email,
        passwords.hash(b.password),
        ROLES.includes(b.role) ? b.role : 'trade',
        nextSortOrder,
        parseHourlyRate(b.hourly_rate)
      );
    await savePermissions(result.lastInsertRowid, selectedPermissions);

    setFlash(req, 'success', `Employee "${b.name.trim()}" created.`);
    res.redirect('/users');
  })
);

router.get(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    const targetUser = await getUserOr404(req, res);
    if (!targetUser) return;
    const rows = await db.prepare('SELECT permission_key FROM user_permissions WHERE user_id = ?').all(targetUser.id);
    res.render('users/form', {
      title: `Edit ${targetUser.name}`,
      targetUser,
      error: null,
      PERMISSIONS,
      DEFAULT_KEYS_BY_ROLE,
      selectedPermissions: rows.map((r) => r.permission_key),
    });
  })
);

router.post(
  '/:id',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const targetUser = await getUserOr404(req, res);
    if (!targetUser) return;

    const b = req.body;
    const selectedPermissions = parsePermissionKeys(b);

    if (!b.name || !b.name.trim() || !b.email || !b.email.trim()) {
      return res.status(400).render('users/form', {
        title: `Edit ${targetUser.name}`,
        targetUser: { ...targetUser, ...b },
        error: 'Name and email are required.',
        PERMISSIONS,
        DEFAULT_KEYS_BY_ROLE,
        selectedPermissions,
      });
    }

    await db
      .prepare(`UPDATE users SET name = ?, email = ?, role = ?, active = ?, hourly_rate = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(
        b.name.trim(),
        b.email.trim().toLowerCase(),
        ROLES.includes(b.role) ? b.role : targetUser.role,
        b.active ? 1 : 0,
        parseHourlyRate(b.hourly_rate),
        targetUser.id
      );
    await savePermissions(targetUser.id, selectedPermissions);

    if (b.password) {
      if (b.password.length < 8) {
        return res.status(400).render('users/form', {
          title: `Edit ${targetUser.name}`,
          targetUser: { ...targetUser, ...b },
          error: 'New password must be at least 8 characters.',
          PERMISSIONS,
          DEFAULT_KEYS_BY_ROLE,
          selectedPermissions,
        });
      }
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwords.hash(b.password), targetUser.id);
    }

    setFlash(req, 'success', 'Employee updated.');
    res.redirect('/users');
  })
);

router.post(
  '/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const targetUser = await getUserOr404(req, res);
    if (!targetUser) return;

    if (targetUser.id === req.user.id) {
      setFlash(req, 'error', 'You cannot remove your own account.');
      return res.redirect('/users');
    }

    await db.prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").run(targetUser.id);

    setFlash(req, 'success', `Employee "${targetUser.name}" removed.`);
    res.redirect('/users');
  })
);

module.exports = router;
