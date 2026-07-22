// Nav order, first permission the user actually has wins - since which
// pages an employee can reach is now configurable per employee, sending
// everyone to a hardcoded '/jobs' would 403 anyone who wasn't granted it.
const ROUTE_BY_PERMISSION = {
  dashboard: '/dashboard',
  schedule: '/jobs/schedule',
  jobs: '/jobs',
  customers: '/customers',
  quotes: '/quotes',
  invoices: '/invoices',
  employees: '/users',
  timeclock: '/timeclock',
  leave: '/leave',
  tasks: '/tasks',
  chat: '/chat',
  forms: '/forms',
  inventory: '/inventory',
  assets: '/assets',
  tools: '/tools',
};

function homeRoute(user) {
  if (!user) return '/login';
  const key = Object.keys(ROUTE_BY_PERMISSION).find((k) => user.permissions.includes(k));
  return key ? ROUTE_BY_PERMISSION[key] : '/jobs';
}

module.exports = { homeRoute };
