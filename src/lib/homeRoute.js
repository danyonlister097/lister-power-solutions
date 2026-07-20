function homeRoute(user) {
  if (!user) return '/login';
  return user.role === 'admin' ? '/dashboard' : '/jobs';
}

module.exports = { homeRoute };
