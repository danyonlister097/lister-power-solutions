// Converts a "YYYY-MM-DD" (or ISO datetime) string to Australian DD/MM/YYYY.
function formatAuDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

module.exports = { formatAuDate };
