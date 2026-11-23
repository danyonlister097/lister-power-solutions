const db = require('../db');
const { toIsoDate } = require('./timesheetCalc');

// jobs.actual_start/actual_end are saved via Date#toISOString() (see toIso in
// routes/jobs.js), so they carry a trailing "Z" even though, like
// clock_events.occurred_at, the digits are really a naive local timestamp,
// not a true UTC instant - toIso's own new Date(v) has nothing but those same
// local digits to parse in the first place. Date getters (getHours() etc.)
// treat a "Z" string as real UTC and convert it to the server process's zone,
// which silently shifts these digits by whatever that zone's offset is -
// harmless when the process happens to run in UTC, wrong otherwise (e.g. a
// dev machine set to Australia/Brisbane). Stripping the "Z" first makes both
// columns parse the same way, regardless of the server's own timezone.
function parseNaiveLocal(v) {
  return new Date(String(v).replace(/Z$/, ''));
}

// Labour is costed at the tech's pay rate plus this on-cost loading (leave,
// super, etc.) - not their charge-out rate, which is what gets billed.
const LABOUR_ONCOST_MULTIPLIER = 1.3;

// Weekend penalty rates: on a Saturday the first 2 hours worked are time and
// a half and the rest of that day is double time; Sunday is all double time.
// Weekday hours are ordinary time unless the tech has already clocked enough
// hours that day to be in daily overtime (see DAILY_* below). `label` names
// the cost line (null keeps the plain "actual hours worked" wording for
// ordinary time).
const SATURDAY_TIME_AND_A_HALF_HOURS = 2;

// Daily overtime on a weekday: once a tech's *clocked* hours for the day
// (across every job/task, not just this one) pass 8h, further hours are time
// and a half; past 10h they're double time. This is why a job's own hours
// can land in more than one tier - e.g. clocking in at 7:30am and starting a
// job at 2:30pm means the 8h mark falls 1h into that job, at 3:30pm.
const DAILY_ORDINARY_MINUTES = 8 * 60;
const DAILY_TIME_AND_A_HALF_MINUTES = 2 * 60; // the next 2h, i.e. up to the 10h mark

const RATE_TIERS = {
  ordinary: { multiplier: 1, label: null },
  ot_1_5: { multiplier: 1.5, label: 'Time and a half (after 8h on shift)' },
  ot_2_0: { multiplier: 2, label: 'Double time (after 10h on shift)' },
  sat_1_5: { multiplier: 1.5, label: 'Saturday time and a half' },
  sat_2_0: { multiplier: 2, label: 'Saturday double time' },
  sun_2_0: { multiplier: 2, label: 'Sunday double time' },
};

// Sums a tech's clocked-in minutes on the given calendar day up to (but not
// past) `beforeTime` - i.e. how much of their daily overtime allowance is
// already used by the time a job segment starts. Pairs clock_events the same
// way dayStats does, but only needs the running total, not full sessions.
// A tech with no clock history that day (subbie, or didn't use the time
// clock) simply gets 0 - the job's own hours are then all that count.
async function clockedMinutesBeforeOnDay(userId, dayRef, beforeTime) {
  const dayIso = toIsoDate(dayRef);
  const events = await db
    .prepare('SELECT type, occurred_at FROM clock_events WHERE user_id = ? AND (occurred_at)::date = (?)::date ORDER BY occurred_at ASC')
    .all(userId, dayIso);

  let minutes = 0;
  let openIn = null;
  for (const e of events) {
    const t = new Date(e.occurred_at);
    if (e.type === 'in') {
      openIn = t;
    } else if (e.type === 'out' && openIn) {
      const segEnd = t < beforeTime ? t : beforeTime;
      if (segEnd > openIn) minutes += (segEnd - openIn) / 60000;
      openIn = null;
    }
  }
  if (openIn && beforeTime > openIn) minutes += (beforeTime - openIn) / 60000;
  return minutes;
}

// Splits a chunk of worked minutes into daily rate tiers given how many
// minutes of the day's overtime allowance are already used (`priorMinutes`).
function splitMinutesByDailyOvertime(priorMinutes, segmentMinutes) {
  const boundaries = [
    { limit: DAILY_ORDINARY_MINUTES, tier: 'ordinary' },
    { limit: DAILY_ORDINARY_MINUTES + DAILY_TIME_AND_A_HALF_MINUTES, tier: 'ot_1_5' },
    { limit: Infinity, tier: 'ot_2_0' },
  ];
  const result = { ordinary: 0, ot_1_5: 0, ot_2_0: 0 };
  let cursor = priorMinutes;
  let remaining = segmentMinutes;
  for (const { limit, tier } of boundaries) {
    if (remaining <= 0) break;
    if (cursor >= limit) continue;
    const used = Math.min(limit - cursor, remaining);
    result[tier] += used;
    cursor += used;
    remaining -= used;
  }
  return result;
}

// Splits one tech's worked interval into hours per rate tier. Walks it one
// calendar day at a time so a job running past midnight is costed by the day
// each hour actually fell on (and daily overtime resets for the new day).
// Days are read in the server's local time - the same way actual start/finish
// are parsed and shown back to the user (see toLocalInput in jobs/show.ejs) -
// so the weekday always matches the date on screen. Note the 2 hours of
// Saturday time and a half is counted per job, not per day.
async function splitHoursByRateTier(userId, start, end) {
  const hours = { ordinary: 0, ot_1_5: 0, ot_2_0: 0, sat_1_5: 0, sat_2_0: 0, sun_2_0: 0 };
  let cursor = parseNaiveLocal(start);
  const finish = parseNaiveLocal(end);

  while (cursor < finish) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const segmentEnd = nextMidnight < finish ? nextMidnight : finish;
    const segmentMinutes = (segmentEnd - cursor) / 60000;
    const day = cursor.getDay();

    if (day === 0) {
      hours.sun_2_0 += segmentMinutes / 60;
    } else if (day === 6) {
      const timeAndAHalf = Math.min(segmentMinutes / 60, SATURDAY_TIME_AND_A_HALF_HOURS);
      hours.sat_1_5 += timeAndAHalf;
      hours.sat_2_0 += segmentMinutes / 60 - timeAndAHalf;
    } else {
      const priorMinutes = await clockedMinutesBeforeOnDay(userId, cursor, cursor);
      const split = splitMinutesByDailyOvertime(priorMinutes, segmentMinutes);
      hours.ordinary += split.ordinary / 60;
      hours.ot_1_5 += split.ot_1_5 / 60;
      hours.ot_2_0 += split.ot_2_0 / 60;
    }
    cursor = segmentEnd;
  }
  return hours;
}

// Keeps the labour cost items for a job in sync with its actual start/finish
// times: one line per assigned tech per rate tier worked, 1 quantity = 1 hour,
// priced at pay rate x on-cost x the tier's multiplier. Runs after every
// actual-start/actual-end save, so correcting a mis-logged time updates the
// lines in place instead of leaving them stale or duplicating them. Only ever
// touches rows it created itself (auto_for_user_id) - anything an admin added
// or edited by hand is a normal, untagged cost item.
async function syncAutoLabourCostItems(jobId, actingUserId) {
  const job = await db.prepare('SELECT actual_start, actual_end FROM jobs WHERE id = ?').get(jobId);

  const desired = [];
  if (job.actual_start && job.actual_end) {
    const assignees = await db
      .prepare(
        `SELECT users.id, users.name, users.pay_rate FROM job_assignees
         JOIN users ON users.id = job_assignees.user_id
         WHERE job_assignees.job_id = ?`
      )
      .all(jobId);

    for (const tech of assignees) {
      if (tech.pay_rate == null) continue;
      // Each tech's own clocked hours that day decide where daily overtime
      // kicks in, so this is computed per tech, not once for the whole job.
      const hoursByTier = await splitHoursByRateTier(tech.id, job.actual_start, job.actual_end);
      for (const [tier, def] of Object.entries(RATE_TIERS)) {
        const quantity = Math.round((hoursByTier[tier] || 0) * 100) / 100;
        if (!(quantity > 0)) continue;
        desired.push({
          userId: tech.id,
          tier,
          description: `${tech.name} - ${def.label || 'actual hours worked'}`,
          quantity,
          unitCost: Math.round(tech.pay_rate * LABOUR_ONCOST_MULTIPLIER * def.multiplier * 100) / 100,
        });
      }
    }
  }

  // Rows from before rate tiers existed have no tier recorded - they were
  // all ordinary time.
  const existing = await db
    .prepare('SELECT id, auto_for_user_id, auto_tier FROM job_cost_items WHERE job_id = ? AND auto_for_user_id IS NOT NULL')
    .all(jobId);
  const existingByKey = new Map(existing.map((r) => [`${r.auto_for_user_id}:${r.auto_tier || 'ordinary'}`, r]));
  const wanted = new Set();

  for (const line of desired) {
    const key = `${line.userId}:${line.tier}`;
    wanted.add(key);
    const row = existingByKey.get(key);
    if (row) {
      await db
        .prepare('UPDATE job_cost_items SET quantity = ?, unit_cost = ?, description = ?, auto_tier = ? WHERE id = ?')
        .run(line.quantity, line.unitCost, line.description, line.tier, row.id);
    } else {
      await db
        .prepare(
          `INSERT INTO job_cost_items (job_id, category, description, quantity, unit_cost, created_by, auto_for_user_id, auto_tier)
           VALUES (?, 'labour', ?, ?, ?, ?, ?, ?)`
        )
        .run(jobId, line.description, line.quantity, line.unitCost, actingUserId, line.userId, line.tier);
    }
  }

  // Anything no longer wanted: times cleared, tech unassigned or without a
  // pay rate, or the job moved to a day where that tier doesn't apply.
  for (const row of existing) {
    if (!wanted.has(`${row.auto_for_user_id}:${row.auto_tier || 'ordinary'}`)) {
      await db.prepare('DELETE FROM job_cost_items WHERE id = ?').run(row.id);
    }
  }
}

module.exports = { LABOUR_ONCOST_MULTIPLIER, RATE_TIERS, splitHoursByRateTier, syncAutoLabourCostItems };
