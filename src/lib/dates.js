const BUSINESS_TZ = 'Australia/Brisbane';

// Converts a "YYYY-MM-DD" (or ISO datetime) string to Australian DD/MM/YYYY.
function formatAuDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// Everything the database stamps itself - created_at, updated_at,
// completed_at, decided_at and so on (the now_utc_text() default and
// datetime('now')) - is UTC wall-clock text with no zone marker, e.g.
// '2026-10-12 07:15:14'. A plain new Date() reads that as the *server's* local
// time, so a page printing it shows the UTC clock: 10 hours behind Brisbane,
// and the wrong calendar day for anything stamped before 10am. The helpers
// below read it as UTC and render it in Brisbane time (UTC+10, no daylight
// saving).
//
// Only for those database-stamped columns. clock_events.occurred_at and the
// jobs' scheduled/actual times are already stored as local wall-clock time and
// must keep going through a plain new Date().
function parseDbTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  const utcText = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(text);
  const parsed = new Date(utcText ? `${utcText[1]}T${utcText[2]}Z` : text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const DATE_TIME_FORMAT = { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' };
const DATE_FORMAT = { day: '2-digit', month: '2-digit', year: 'numeric' };
const TIME_FORMAT = { hour: 'numeric', minute: '2-digit' };

// e.g. "12/10/2026, 5:15 pm". Pass Intl options to change the shape.
function formatDbDateTime(value, options = DATE_TIME_FORMAT) {
  const d = parseDbTimestamp(value);
  return d ? d.toLocaleString('en-AU', { ...options, timeZone: BUSINESS_TZ }) : '';
}

// e.g. "12/10/2026"
function formatDbDate(value, options = DATE_FORMAT) {
  const d = parseDbTimestamp(value);
  return d ? d.toLocaleDateString('en-AU', { ...options, timeZone: BUSINESS_TZ }) : '';
}

// e.g. "5:15 pm"
function formatDbTime(value, options = TIME_FORMAT) {
  const d = parseDbTimestamp(value);
  return d ? d.toLocaleTimeString('en-AU', { ...options, timeZone: BUSINESS_TZ }) : '';
}

// The Brisbane calendar day ("YYYY-MM-DD") a database timestamp falls on - for
// grouping by day, date-range links, or feeding formatAuDate, which only
// reshuffles the digits it is given.
function dbDateIso(value) {
  const d = parseDbTimestamp(value);
  return d ? d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ }) : '';
}

module.exports = { formatAuDate, parseDbTimestamp, formatDbDateTime, formatDbDate, formatDbTime, dbDateIso };
