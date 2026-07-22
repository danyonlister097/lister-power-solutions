// Canonical list of page-level sections a non-admin employee's access can be
// tuned to, in nav order. The key is what's stored in user_permissions and
// checked by requirePermission(); the label is what shows on the employee
// form's checkboxes.
const PERMISSIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'schedule', label: 'Team Schedule' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'customers', label: 'Customers' },
  { key: 'quotes', label: 'Quotes' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'employees', label: 'Employees' },
  { key: 'timeclock', label: 'Time Clock' },
  { key: 'leave', label: 'Request Leave' },
  { key: 'tasks', label: 'Quick Task' },
  { key: 'chat', label: 'Chat' },
  { key: 'forms', label: 'Forms' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'assets', label: 'Asset Register' },
  { key: 'tools', label: 'Tools' },
];

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

// What a brand-new trade/apprentice employee starts with - matches what
// every non-admin could already reach before per-employee permissions
// existed, so turning this feature on doesn't quietly take anything away
// from existing staff.
const DEFAULT_KEYS_BY_ROLE = {
  admin: PERMISSION_KEYS,
  trade: ['jobs', 'timeclock', 'leave', 'tasks', 'chat', 'forms', 'inventory', 'assets', 'tools'],
  apprentice: ['jobs', 'timeclock', 'leave', 'tasks', 'chat', 'forms', 'inventory', 'assets', 'tools'],
};

module.exports = { PERMISSIONS, PERMISSION_KEYS, DEFAULT_KEYS_BY_ROLE };
