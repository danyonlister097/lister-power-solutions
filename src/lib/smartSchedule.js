const { brisbaneTodayIso, toIsoDate } = require('./timesheetCalc');

// Home base: 125 Fairway Drive, Kensington Grove QLD 4341
const HOME_BASE = { lat: -27.6714, lng: 152.5753 };

const WORK_DAY_START_MINUTES = 7 * 60 + 30; // 7:30am
const MAX_WORK_MINUTES_PER_DAY = 6 * 60; // 6 hours of job work - travel rides on top of this, not counted against it
const DEFAULT_JOB_DURATION_MINUTES = 60; // used when a job has no expected duration set
const MAX_SCHEDULE_DAYS = 5; // Mon-Fri; anything left over is overflow for next week's run
const TRAVEL_MINUTES_PER_KM = 1.5; // ~40km/h effective - accounts for roads not being a straight line
const MIN_TRAVEL_MINUTES = 5; // floor for any two genuinely different addresses

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Straight-line distance scaled to a rough travel-time estimate. There's no
// live Directions/Distance Matrix call here (a separate, billed Google API)
// - just a flat speed assumption, rounded to a clean 5-minute increment.
function travelMinutes(a, b) {
  const km = haversineKm(a, b);
  if (km < 0.1) return 0;
  return Math.max(MIN_TRAVEL_MINUTES, Math.round((km * TRAVEL_MINUTES_PER_KM) / 5) * 5);
}

function nearestNeighborOrder(jobs) {
  let current = HOME_BASE;
  const remaining = [...jobs];
  const ordered = [];
  while (remaining.length) {
    let nearestIdx = 0;
    let nearestDist = Infinity;
    remaining.forEach((j, i) => {
      const d = haversineKm(current, j);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    });
    const next = remaining.splice(nearestIdx, 1)[0];
    ordered.push(next);
    current = next;
  }
  return ordered;
}

function routeKm(jobs) {
  let total = 0;
  let prev = HOME_BASE;
  for (const j of jobs) { total += haversineKm(prev, j); prev = j; }
  total += haversineKm(prev, HOME_BASE);
  return Math.round(total);
}

function minutesToClock(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Next Monday from today (or this Monday if today is Monday). Anchored on
// brisbaneTodayIso() rather than a bare `new Date()` - Vercel's serverless
// functions run in UTC, where "today" can be a different calendar day than
// Brisbane for part of each day, which silently pushed this to the wrong
// week (the same bug fixed in routes/jobs.js's schedule views).
function nextMondayIso() {
  const d = new Date(`${brisbaneTodayIso()}T00:00:00`);
  const day = d.getDay(); // 0=Sun
  const offset = day === 1 ? 7 : ((8 - day) % 7 || 7);
  d.setDate(d.getDate() + offset);
  return toIsoDate(d);
}

function addDaysToIso(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayLabel(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'short',
  });
}

// Greedily packs an already route-ordered list of jobs into day buckets, each
// capped at MAX_WORK_MINUTES_PER_DAY of actual job duration - travel time
// between consecutive jobs rides on top of the cap, it isn't counted against
// it. A day always takes at least one job even if that job's own duration
// alone exceeds the cap, since a single job can't be split across days.
// Days beyond MAX_SCHEDULE_DAYS aren't opened - anything left over comes
// back as overflow for the next run.
function packIntoDays(orderedJobs, weekStartIso) {
  const days = [];
  const overflow = [];
  let dayJobs = [];
  let dayWorkMinutes = 0;
  let clock = WORK_DAY_START_MINUTES;
  let lastLocation = null;

  function closeDay() {
    if (!dayJobs.length) return;
    const date = addDaysToIso(weekStartIso, days.length);
    days.push({
      date,
      dayLabel: dayLabel(date),
      jobs: dayJobs,
      totalKm: routeKm(dayJobs),
      totalWorkMinutes: dayWorkMinutes,
      totalTravelMinutes: dayJobs.reduce((s, j) => s + j.travelMinutesBefore, 0),
    });
    dayJobs = [];
    dayWorkMinutes = 0;
    clock = WORK_DAY_START_MINUTES;
    lastLocation = null;
  }

  for (const job of orderedJobs) {
    if (days.length >= MAX_SCHEDULE_DAYS) {
      overflow.push(job);
      continue;
    }

    const duration = job.duration_minutes != null ? Number(job.duration_minutes) : DEFAULT_JOB_DURATION_MINUTES;

    if (dayJobs.length && dayWorkMinutes + duration > MAX_WORK_MINUTES_PER_DAY) {
      closeDay();
      if (days.length >= MAX_SCHEDULE_DAYS) {
        overflow.push(job);
        continue;
      }
    }

    const travel = dayJobs.length ? travelMinutes(lastLocation, job) : 0;
    const start = dayJobs.length ? clock + travel : WORK_DAY_START_MINUTES;
    const end = start + duration;

    dayJobs.push({
      ...job,
      startTime: minutesToClock(start),
      endTime: minutesToClock(end),
      travelMinutesBefore: travel,
      durationMinutes: duration,
      durationEstimated: job.duration_minutes == null,
    });
    dayWorkMinutes += duration;
    clock = end;
    lastLocation = job;
  }

  closeDay();

  return { days, overflow };
}

function generateSchedule(jobs, weekStartIso) {
  const located   = jobs.filter((j) => j.lat != null && j.lng != null);
  const unlocated = jobs.filter((j) => j.lat == null || j.lng == null);

  const ordered = nearestNeighborOrder(located);
  const { days, overflow } = packIntoDays(ordered, weekStartIso);

  return { schedule: days, unlocated, overflow };
}

module.exports = {
  generateSchedule,
  nextMondayIso,
  addDaysToIso,
  HOME_BASE,
  haversineKm,
  MAX_WORK_MINUTES_PER_DAY,
  WORK_DAY_START_MINUTES,
};
