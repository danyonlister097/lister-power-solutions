// Formats a number as AUD with the minus sign before the $ for negatives
// (-$148.00, not the more awkward $-148.00). Returns '—' for null/undefined.
function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const abs = Math.abs(value).toFixed(2);
  return value < 0 ? `-$${abs}` : `$${abs}`;
}

module.exports = { formatMoney };
