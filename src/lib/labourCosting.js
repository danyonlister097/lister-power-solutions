const db = require('../db');

// Labour is costed at the tech's pay rate plus this on-cost loading (leave,
// super, etc.) - not their charge-out rate, which is what gets billed.
const LABOUR_ONCOST_MULTIPLIER = 1.3;

// Weekend penalty rates: weekdays are ordinary time; on a Saturday the first
// 2 hours worked are time and a half and the rest of that day is double time;
// Sunday is all double time. `label` names the cost line (null keeps the
// plain "actual hours worked" wording for ordinary time).
const SATURDAY_TIME_AND_A_HALF_HOURS = 2;
const RATE_TIERS = {
  ordinary: { multiplier: 1, label: null },
  sat_1_5: { multiplier: 1.5, label: 'Saturday time and a half' },
  sat_2_0: { multiplier: 2, label: 'Saturday double time' },
  sun_2_0: { multiplier: 2, label: 'Sunday double time' },
};

// Splits a worked interval into hours per rate tier. Walks it one calendar
// day at a time so a job running past midnight is costed by the day each
// hour actually fell on. Days are read in the server's local time - the same
// way actual start/finish are parsed and shown back to the user (see
// toLocalInput in jobs/show.ejs) - so the weekday always matches the date on
// screen. Note the 2 hours of time and a half is counted per job.
function splitHoursByRateTier(start, end) {
  const hours = { ordinary: 0, sat_1_5: 0, sat_2_0: 0, sun_2_0: 0 };
  let cursor = new Date(start);
  const finish = new Date(end);

  while (cursor < finish) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    const segmentEnd = nextMidnight < finish ? nextMidnight : finish;
    const segmentHours = (segmentEnd - cursor) / 3600000;
    const day = cursor.getDay();

    if (day === 0) {
      hours.sun_2_0 += segmentHours;
    } else if (day === 6) {
      const timeAndAHalf = Math.min(segmentHours, SATURDAY_TIME_AND_A_HALF_HOURS);
      hours.sat_1_5 += timeAndAHalf;
      hours.sat_2_0 += segmentHours - timeAndAHalf;
    } else {
      hours.ordinary += segmentHours;
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
    const hoursByTier = splitHoursByRateTier(job.actual_start, job.actual_end);
    const assignees = await db
      .prepare(
        `SELECT users.id, users.name, users.pay_rate FROM job_assignees
         JOIN users ON users.id = job_assignees.user_id
         WHERE job_assignees.job_id = ?`
      )
      .all(jobId);

    for (const tech of assignees) {
      if (tech.pay_rate == null) continue;
      for (const [tier, def] of Object.entries(RATE_TIERS)) {
        const quantity = Math.round(hoursByTier[tier] * 100) / 100;
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
