const db = require('../db');
const { addDays, mondayOf, dayStats, REGULAR_MINUTES_PER_DAY, brisbaneTodayIso } = require('./timesheetCalc');

// Total/regular/overtime minutes for one user across a Monday-Sunday week -
// each day's excess over 8h counts as overtime, summed across the week.
// Same rule the live weekly timesheet view uses, so a generated timesheet's
// numbers always match what the grid shows for that week.
async function computeWeekTotals(userId, weekStart, weekEnd) {
  const events = await db
    .prepare('SELECT * FROM clock_events WHERE user_id = ? AND (occurred_at)::date BETWEEN (?)::date AND (?)::date ORDER BY occurred_at ASC')
    .all(userId, weekStart, weekEnd);

  const byDay = {};
  events.forEach((e) => {
    const day = e.occurred_at.slice(0, 10);
    byDay[day] = byDay[day] || [];
    byDay[day].push(e);
  });

  let regularMinutes = 0;
  let overtimeMinutes = 0;
  for (let i = 0; i < 7; i += 1) {
    const iso = addDays(weekStart, i);
    const stats = dayStats(byDay[iso] || []);
    regularMinutes += Math.min(stats.totalMinutes, REGULAR_MINUTES_PER_DAY);
    overtimeMinutes += Math.max(0, stats.totalMinutes - REGULAR_MINUTES_PER_DAY);
  }

  return { totalMinutes: regularMinutes + overtimeMinutes, regularMinutes, overtimeMinutes };
}

// Generates 'pending' timesheets for the most recently completed Mon-Sun
// week (Brisbane), one per active employee. Anchored on mondayOf(today)
// rather than "yesterday" so it resolves to the right week even if invoked
// on a day other than the scheduled Monday 00:00 (e.g. a manual re-run) -
// mondayOf(today) is this week's Monday, so the day before it is always
// last Sunday, whatever "today" happens to be.
// ON CONFLICT DO NOTHING makes a duplicate/retried run harmless, and never
// overwrites a week someone already approved.
async function generateWeeklyTimesheets() {
  const todayBrisbane = brisbaneTodayIso();
  const weekEnd = addDays(mondayOf(todayBrisbane), -1);
  const weekStart = addDays(weekEnd, -6);

  const users = await db.prepare('SELECT id FROM users WHERE active = 1').all();
  let created = 0;
  for (const u of users) {
    const totals = await computeWeekTotals(u.id, weekStart, weekEnd);
    const result = await db
      .prepare(
        `INSERT INTO timesheets (user_id, week_start, week_end, total_minutes, regular_minutes, overtime_minutes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, week_start) DO NOTHING`
      )
      .run(u.id, weekStart, weekEnd, totals.totalMinutes, totals.regularMinutes, totals.overtimeMinutes);
    if (result.changes > 0) created += 1;
  }

  return { weekStart, weekEnd, employeeCount: users.length, created };
}

module.exports = { computeWeekTotals, generateWeeklyTimesheets };
