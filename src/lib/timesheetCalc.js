// Shared by src/routes/timeclock.js (live display) and the weekly
// timesheet-generation cron (api/index.js) so both compute hours the same
// way - pure date-string math, no timezone library, matching how
// clock_events.occurred_at is stored (naive local time, no UTC offset).
const REGULAR_MINUTES_PER_DAY = 8 * 60;

const BUSINESS_TZ = 'Australia/Brisbane';

// Current date as YYYY-MM-DD in Brisbane time (UTC+10, no DST).
// Use this instead of toIsoDate(new Date()) on Vercel, which runs in UTC.
function brisbaneTodayIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
}

// Current datetime as YYYY-MM-DDTHH:MM:SS in Brisbane local time.
// Use this when recording timestamps (clock in/out) so stored values
// reflect the employee's local time, not the server's UTC clock.
function brisbaneDatetimeIso() {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  const time = now.toLocaleTimeString('en-GB', { timeZone: BUSINESS_TZ, hour12: false });
  return `${date}T${time}`;
}

function toIsoDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toIsoDate(d);
}

function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toIsoDate(d);
}

function formatHours(minutes, alwaysShow) {
  if (!minutes && !alwaysShow) return '--';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}:${String(m).padStart(2, '0')}h`;
}

// Given a user's clock_events for a single day (ascending), pair up in/out
// events to compute total worked minutes - handles multiple sessions per day.
function dayStats(events) {
  let firstIn = null;
  let lastOut = null;
  let openIn = null;
  let totalMinutes = 0;
  let lastEvent = null;

  events.forEach((e) => {
    if (e.type === 'in') {
      if (!firstIn) firstIn = e.occurred_at;
      openIn = e.occurred_at;
    } else if (e.type === 'out' && openIn) {
      lastOut = e.occurred_at;
      totalMinutes += (new Date(e.occurred_at) - new Date(openIn)) / 60000;
      openIn = null;
    }
    lastEvent = e;
  });

  return {
    firstIn,
    lastOut,
    totalMinutes,
    stillIn: Boolean(openIn),
    lastEvent,
  };
}

module.exports = { REGULAR_MINUTES_PER_DAY, toIsoDate, addDays, mondayOf, formatHours, dayStats, brisbaneTodayIso, brisbaneDatetimeIso };
