// Canonical list of page-level sections a non-admin employee's access can be
// tuned to, in nav order. The key is what's stored in user_permissions and
// checked by requirePermission(); the label is what shows on the employee
// form's checkboxes.
// group 1 = business/management tools (restricted); group 2 = day-to-day employee tools (standard)
const PERMISSIONS = [
  { key: 'dashboard',  label: 'Dashboard',            group: 1 },
  { key: 'jobs',       label: 'Jobs',                  group: 1 },
  { key: 'customers',  label: 'Customers',             group: 1 },
  { key: 'quotes',     label: 'Quotes',                group: 1 },
  { key: 'invoices',   label: 'Invoices',              group: 1 },
  { key: 'employees',  label: 'Employees',             group: 1 },
  { key: 'assets',     label: 'Asset Register',        group: 1 },
  { key: 'renewals',   label: 'Renewals',              group: 1 },
  { key: 'schedule',   label: 'Team Schedule',         group: 2 },
  { key: 'timeclock',  label: 'Time Clock',            group: 2 },
  { key: 'leave',      label: 'Request Leave',         group: 2 },
  { key: 'tasks',      label: 'Quick Task',            group: 2 },
  { key: 'chat',       label: 'Chat',                  group: 2 },
  { key: 'forms',      label: 'Forms',                 group: 2 },
  { key: 'inventory',  label: 'Inventory',             group: 2 },
  { key: 'tools',      label: 'Tools',                 group: 2 },
  { key: 'feedback',   label: 'Bug Reports & Ideas',   group: 2 },
];

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// What a brand-new trade/apprentice employee starts with.
const DEFAULT_KEYS_BY_ROLE = {
  admin: PERMISSION_KEYS,
  trade: ['schedule', 'jobs', 'timeclock', 'leave', 'tasks', 'chat', 'forms', 'inventory', 'assets', 'tools', 'feedback'],
  apprentice: ['schedule', 'jobs', 'timeclock', 'leave', 'tasks', 'chat', 'forms', 'inventory', 'assets', 'tools', 'feedback'],
};

module.exports = { PERMISSIONS, PERMISSION_KEYS, DEFAULT_KEYS_BY_ROLE };
