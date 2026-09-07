function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Wraps Australian-style phone numbers (10 digits starting with 0, optionally
// spaced or dashed) in tap-to-message links - e.g. a tenant's number typed
// into a job's free-text Description/Notes. Escapes the rest of the text
// first, so the result is always safe to render unescaped.
function linkifyPhoneNumbers(text) {
  if (!text) return text;
  const escaped = escapeHtml(text);
  return escaped.replace(/\b0\d(?:[ -]?\d){7}\d\b/g, (match) => {
    const digits = match.replace(/\D/g, '');
    return `<a href="sms:${digits}">${match}</a>`;
  });
}

module.exports = { linkifyPhoneNumbers };
