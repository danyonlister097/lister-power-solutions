const { Readable } = require('stream');
const express = require('express');
const db = require('../db');
const { requireRole, requirePermission, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { upload, putFile, fetchFile, deleteFile } = require('../lib/uploads');
const { homeRoute } = require('../lib/homeRoute');
const { JOB_COLORS, JOB_COLOR_VALUES } = require('../lib/jobColors');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

const STATUSES = ['unscheduled', 'scheduled', 'in_progress', 'completed', 'cancelled'];

// The business runs out of Queensland, which doesn't observe daylight
// saving - so this fixed IANA zone gives the same "today"/"this week"
// boundaries the app always used to get for free from the server's local
// clock. That assumption breaks once the server itself isn't running on
// Australian local time (e.g. Vercel's UTC serverless functions), so it's
// pinned explicitly here instead of relying on ambient server time.
const BUSINESS_TZ = 'Australia/Brisbane';

function parseJobColor(raw) {
  return raw && JOB_COLOR_VALUES.has(raw) ? raw : null;
}

// Only ever redirect back to a same-site URL we generated ourselves - never
// follow an arbitrary returnTo value (open-redirect guard).
function safeReturnTo(raw) {
  return typeof raw === 'string' && /^\/(dashboard|jobs(\/schedule)?)(\?[A-Za-z0-9=&_-]*)?$/.test(raw) ? raw : null;
}

async function setAssignees(jobId, userIds) {
  await db.prepare('DELETE FROM job_assignees WHERE job_id = ?').run(jobId);
  const insert = db.prepare('INSERT INTO job_assignees (job_id, user_id) VALUES (?, ?)');
  const unique = [...new Set(userIds)];
  for (const uid of unique) await insert.run(jobId, uid);
}

function parseAssigneeIds(body) {
  let raw = body.assigned_to;
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) raw = [raw];
  return raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

async function getJobOr404(req, res) {
  const job = await db
    .prepare(
      `SELECT jobs.*, customers.name AS customer_name
       FROM jobs JOIN customers ON customers.id = jobs.customer_id
       WHERE jobs.id = ?`
    )
    .get(req.params.id);
  if (!job) {
    res.status(404).render('error', { message: 'Job not found.' });
    return null;
  }

  const assignees = await db
    .prepare(
      `SELECT users.id, users.name
       FROM job_assignees JOIN users ON users.id = job_assignees.user_id
       WHERE job_assignees.job_id = ?
       ORDER BY users.sort_order, users.name`
    )
    .all(job.id);

  if (req.user.role !== 'admin' && !assignees.some((a) => a.id === req.user.id)) {
    res.status(403).render('error', { message: 'This job is not assigned to you.' });
    return null;
  }

  job.assignees = assignees;
  job.assigneeNames = assignees.map((a) => a.name).join(', ');
  return job;
}

async function checkCompletionRequirements(jobId) {
  const photoCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM job_attachments WHERE job_id = ?').get(jobId)).n);
  const stockCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM job_stock_allocations WHERE job_id = ?').get(jobId)).n);
  const missing = [];
  if (photoCount === 0) missing.push('at least one photo must be added');
  if (stockCount === 0) missing.push('stock used must be populated');
  return missing.length ? `Cannot mark job as completed: ${missing.join(' and ')}.` : null;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    const status = req.query.status || '';
    const range = req.query.range || 'upcoming';
    const assignedTo = isAdmin ? req.query.assignedTo || '' : String(req.user.id);

    const clauses = [];
    const params = {};

    if (!isAdmin) {
      clauses.push('EXISTS (SELECT 1 FROM job_assignees ja WHERE ja.job_id = jobs.id AND ja.user_id = @userId)');
      params.userId = req.user.id;
    } else if (assignedTo) {
      clauses.push('EXISTS (SELECT 1 FROM job_assignees ja WHERE ja.job_id = jobs.id AND ja.user_id = @assignedTo)');
      params.assignedTo = assignedTo;
    }

    if (status) {
      clauses.push('jobs.status = @status');
      params.status = status;
    }

    if (range === 'today') {
      clauses.push(`(jobs.scheduled_start)::date = (now() AT TIME ZONE '${BUSINESS_TZ}')::date`);
    } else if (range === 'week') {
      clauses.push(
        `(jobs.scheduled_start)::date BETWEEN (now() AT TIME ZONE '${BUSINESS_TZ}')::date AND ((now() AT TIME ZONE '${BUSINESS_TZ}') + interval '7 days')::date`
      );
    } else if (range === 'upcoming') {
      clauses.push(`(jobs.scheduled_start IS NULL OR (jobs.scheduled_start)::date >= (now() AT TIME ZONE '${BUSINESS_TZ}')::date)`);
      clauses.push("jobs.status NOT IN ('completed', 'cancelled')");
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const jobs = await db
      .prepare(
        `SELECT jobs.*, customers.name AS customer_name
         FROM jobs
         JOIN customers ON customers.id = jobs.customer_id
         ${where}
         ORDER BY (jobs.scheduled_start IS NULL), jobs.scheduled_start ASC`
      )
      .all(params);

    const assigneeStmt = db.prepare(
      `SELECT users.name FROM job_assignees JOIN users ON users.id = job_assignees.user_id
       WHERE job_assignees.job_id = ? ORDER BY users.sort_order, users.name`
    );
    for (const j of jobs) {
      j.assigneeNames = (await assigneeStmt.all(j.id)).map((r) => r.name).join(', ');
    }

    const techs = isAdmin ? await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all() : [];

    res.render('jobs/list', { title: 'Jobs', jobs, techs, status, range, assignedTo, isAdmin, STATUSES });
  })
);

function toIsoDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function mondayOf(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function sumMinutes(jobList) {
  return jobList.reduce((sum, j) => {
    if (!j.scheduled_start || !j.scheduled_end) return sum;
    return sum + (new Date(j.scheduled_end) - new Date(j.scheduled_start)) / 60000;
  }, 0);
}

function formatHoursLabel(minutes) {
  if (minutes <= 0) return '--';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

async function renderGridView(req, res, numDays) {
  const requestedStart = req.query.start ? new Date(`${req.query.start}T00:00:00`) : new Date();
  const anchor = isNaN(requestedStart) ? new Date() : requestedStart;
  const rangeStart = numDays === 7 ? mondayOf(anchor) : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());

  const days = Array.from({ length: numDays }, (_, i) => {
    const d = new Date(rangeStart);
    d.setDate(rangeStart.getDate() + i);
    return { date: d, iso: toIsoDate(d), label: d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'numeric' }) };
  });
  const rangeStartIso = days[0].iso;
  const rangeEndIso = days[days.length - 1].iso;

  const prevStart = new Date(rangeStart);
  prevStart.setDate(rangeStart.getDate() - numDays);
  const nextStart = new Date(rangeStart);
  nextStart.setDate(rangeStart.getDate() + numDays);

  const jobs = await db
    .prepare(
      `SELECT jobs.*, customers.name AS customer_name
       FROM jobs
       JOIN customers ON customers.id = jobs.customer_id
       WHERE (jobs.scheduled_start)::date BETWEEN (@start)::date AND (@end)::date
       ORDER BY jobs.scheduled_start ASC`
    )
    .all({ start: rangeStartIso, end: rangeEndIso });

  const jobIds = jobs.map((j) => j.id);
  const assigneesByJob = {};
  if (jobIds.length) {
    const placeholders = jobIds.map(() => '?').join(',');
    (
      await db
        .prepare(
          `SELECT job_id, user_id, users.name
           FROM job_assignees JOIN users ON users.id = job_assignees.user_id
           WHERE job_id IN (${placeholders})
           ORDER BY users.sort_order, users.name`
        )
        .all(...jobIds)
    ).forEach((r) => {
      (assigneesByJob[r.job_id] = assigneesByJob[r.job_id] || []).push({ id: r.user_id, name: r.name });
    });
  }
  jobs.forEach((j) => {
    j.assigneeList = assigneesByJob[j.id] || [];
    j.assigneeIds = j.assigneeList.map((a) => a.id);
    j.assigneeNames = j.assigneeList.map((a) => a.name).join(', ');
  });

  const techs = await db.prepare('SELECT id, name, hourly_rate FROM users WHERE active = 1 ORDER BY sort_order, name').all();

  function jobsFor(techId, dayIso) {
    return jobs.filter((j) => {
      const matches = techId === null ? j.assigneeIds.length === 0 : j.assigneeIds.includes(techId);
      return matches && j.scheduled_start.slice(0, 10) === dayIso;
    });
  }

  const rows = [
    { id: null, name: 'Unassigned shifts', days: days.map((d) => jobsFor(null, d.iso)) },
    ...techs.map((t) => {
      const rowDays = days.map((d) => jobsFor(t.id, d.iso));
      const rowJobs = rowDays.flat();
      const minutes = sumMinutes(rowJobs);
      return {
        id: t.id,
        name: t.name,
        days: rowDays,
        shiftCount: rowJobs.length,
        hoursLabel: formatHoursLabel(minutes),
        minutes,
        hourlyRate: t.hourly_rate,
        utilisationPct: Math.round((minutes / 60 / 38) * 100),
      };
    }),
  ];

  const totalShifts = jobs.length;
  const totalMinutes = sumMinutes(jobs);
  const totalHours = (totalMinutes / 60).toFixed(2).replace(/\.00$/, '');
  const activeUsers = new Set(jobs.flatMap((j) => j.assigneeIds)).size;
  const labourCost = rows.reduce((sum, r) => {
    if (r.id === null || !r.hourlyRate) return sum;
    return sum + (r.minutes / 60) * r.hourlyRate;
  }, 0);

  const isDay = numDays === 1;
  const weekLabel = isDay
    ? days[0].date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : `${days[0].date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} - ${days[6].date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`;

  res.render('jobs/schedule', {
    title: 'Schedule',
    view: isDay ? 'day' : 'week',
    days,
    rows,
    weekLabel,
    prevStartIso: toIsoDate(prevStart),
    nextStartIso: toIsoDate(nextStart),
    monthIso: `${rangeStart.getFullYear()}-${String(rangeStart.getMonth() + 1).padStart(2, '0')}`,
    isAdmin: req.user.role === 'admin',
    summary: {
      shifts: totalShifts,
      hours: totalHours,
      users: activeUsers,
      labourCost: labourCost.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' }),
    },
  });
}

async function renderMonthView(req, res) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  if (/^\d{4}-\d{2}$/.test(req.query.month || '')) {
    const [y, m] = req.query.month.split('-').map(Number);
    year = y;
    month = m - 1;
  }

  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  const gridStart = mondayOf(firstOfMonth);
  const gridEndAnchor = mondayOf(lastOfMonth);
  const gridEnd = new Date(gridEndAnchor);
  gridEnd.setDate(gridEndAnchor.getDate() + 6);

  const weeks = [];
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push({ date: new Date(cursor), iso: toIsoDate(cursor), inMonth: cursor.getMonth() === month, jobs: [] });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  const startIso = toIsoDate(gridStart);
  const endIso = toIsoDate(gridEnd);

  const jobs = await db
    .prepare(
      `SELECT jobs.*, customers.name AS customer_name
       FROM jobs JOIN customers ON customers.id = jobs.customer_id
       WHERE (jobs.scheduled_start)::date BETWEEN (@start)::date AND (@end)::date
       ORDER BY jobs.scheduled_start ASC`
    )
    .all({ start: startIso, end: endIso });

  const jobIds = jobs.map((j) => j.id);
  const assigneesByJob = {};
  if (jobIds.length) {
    const placeholders = jobIds.map(() => '?').join(',');
    (
      await db
        .prepare(
          `SELECT job_id, user_id, users.name
           FROM job_assignees JOIN users ON users.id = job_assignees.user_id
           WHERE job_id IN (${placeholders})
           ORDER BY users.sort_order, users.name`
        )
        .all(...jobIds)
    ).forEach((r) => {
      (assigneesByJob[r.job_id] = assigneesByJob[r.job_id] || []).push({ id: r.user_id, name: r.name });
    });
  }
  jobs.forEach((j) => {
    j.assigneeNames = (assigneesByJob[j.id] || []).map((a) => a.name).join(', ');
  });

  const jobsByDay = {};
  jobs.forEach((j) => {
    const day = j.scheduled_start.slice(0, 10);
    (jobsByDay[day] = jobsByDay[day] || []).push(j);
  });
  weeks.forEach((week) => week.forEach((day) => { day.jobs = jobsByDay[day.iso] || []; }));

  const prevMonth = new Date(year, month - 1, 1);
  const nextMonth = new Date(year, month + 1, 1);

  res.render('jobs/schedule-month', {
    title: 'Schedule',
    view: 'month',
    weeks,
    monthLabel: firstOfMonth.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
    prevMonthIso: `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`,
    nextMonthIso: `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`,
    todayIso: toIsoDate(now),
    isAdmin: req.user.role === 'admin',
  });
}

const DAY_AXIS_START_HOUR = 6;
const DAY_AXIS_END_HOUR = 21;
const DAY_AXIS_TOTAL_MINUTES = (DAY_AXIS_END_HOUR - DAY_AXIS_START_HOUR) * 60;
const DAY_LANE_HEIGHT = 60;

function timeMinutes(iso) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function formatHourLabel(h) {
  const period = h < 12 || h === 24 ? 'am' : 'pm';
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}${period}`;
}

async function renderDayView(req, res) {
  const requestedDay = req.query.start ? new Date(`${req.query.start}T00:00:00`) : new Date();
  const day = isNaN(requestedDay) ? new Date() : requestedDay;
  const dayIso = toIsoDate(day);

  const prevDay = new Date(day);
  prevDay.setDate(day.getDate() - 1);
  const nextDay = new Date(day);
  nextDay.setDate(day.getDate() + 1);

  const jobs = await db
    .prepare(
      `SELECT jobs.*, customers.name AS customer_name
       FROM jobs JOIN customers ON customers.id = jobs.customer_id
       WHERE (jobs.scheduled_start)::date = (@day)::date
       ORDER BY jobs.scheduled_start ASC`
    )
    .all({ day: dayIso });

  const jobIds = jobs.map((j) => j.id);
  const assigneesByJob = {};
  if (jobIds.length) {
    const placeholders = jobIds.map(() => '?').join(',');
    (
      await db
        .prepare(
          `SELECT job_id, user_id, users.name
           FROM job_assignees JOIN users ON users.id = job_assignees.user_id
           WHERE job_id IN (${placeholders})
           ORDER BY users.sort_order, users.name`
        )
        .all(...jobIds)
    ).forEach((r) => {
      (assigneesByJob[r.job_id] = assigneesByJob[r.job_id] || []).push({ id: r.user_id, name: r.name });
    });
  }
  jobs.forEach((j) => {
    j.assigneeList = assigneesByJob[j.id] || [];
    j.assigneeIds = j.assigneeList.map((a) => a.id);
    j.assigneeNames = j.assigneeList.map((a) => a.name).join(', ');
  });

  const techs = await db.prepare('SELECT id, name, hourly_rate FROM users WHERE active = 1 ORDER BY sort_order, name').all();

  function blocksFor(techId) {
    const list = jobs
      .filter((j) => (techId === null ? j.assigneeIds.length === 0 : j.assigneeIds.includes(techId)))
      .slice()
      .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));

    const laneEnds = [];
    return list.map((j) => {
      const startMin = timeMinutes(j.scheduled_start);
      const endMin = j.scheduled_end ? timeMinutes(j.scheduled_end) : startMin + 60;
      const clampedStart = Math.max(startMin, DAY_AXIS_START_HOUR * 60);
      const clampedEnd = Math.min(Math.max(endMin, clampedStart + 15), DAY_AXIS_END_HOUR * 60);
      const leftPct = ((clampedStart - DAY_AXIS_START_HOUR * 60) / DAY_AXIS_TOTAL_MINUTES) * 100;
      const widthPct = Math.max(((clampedEnd - clampedStart) / DAY_AXIS_TOTAL_MINUTES) * 100, 2);

      let lane = laneEnds.findIndex((laneEnd) => startMin >= laneEnd);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(endMin);
      } else {
        laneEnds[lane] = endMin;
      }

      return { job: j, leftPct, widthPct, lane, top: lane * DAY_LANE_HEIGHT };
    });
  }

  const rows = [
    { id: null, name: 'Unassigned shifts', blocks: blocksFor(null) },
    ...techs.map((t) => {
      const blocks = blocksFor(t.id);
      const rowJobs = jobs.filter((j) => j.assigneeIds.includes(t.id));
      const minutes = sumMinutes(rowJobs);
      const laneCount = blocks.reduce((max, b) => Math.max(max, b.lane + 1), 1);
      return {
        id: t.id,
        name: t.name,
        blocks,
        trackHeight: laneCount * DAY_LANE_HEIGHT,
        shiftCount: rowJobs.length,
        hoursLabel: formatHoursLabel(minutes),
        minutes,
        hourlyRate: t.hourly_rate,
        utilisationPct: Math.round((minutes / 60 / 38) * 100),
      };
    }),
  ];

  const hourMarks = [];
  for (let h = DAY_AXIS_START_HOUR; h < DAY_AXIS_END_HOUR; h++) {
    hourMarks.push({ hour: h, label: formatHourLabel(h) });
  }

  const totalShifts = jobs.length;
  const totalMinutes = sumMinutes(jobs);
  const totalHours = (totalMinutes / 60).toFixed(2).replace(/\.00$/, '');
  const activeUsers = new Set(jobs.flatMap((j) => j.assigneeIds)).size;
  const labourCost = rows.reduce((sum, r) => {
    if (r.id === null || !r.hourlyRate) return sum;
    return sum + (r.minutes / 60) * r.hourlyRate;
  }, 0);

  res.render('jobs/schedule-day', {
    title: 'Schedule',
    view: 'day',
    dayIso,
    dayLabel: day.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    prevStartIso: toIsoDate(prevDay),
    nextStartIso: toIsoDate(nextDay),
    monthIso: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`,
    hourMarks,
    rows,
    isAdmin: req.user.role === 'admin',
    summary: {
      shifts: totalShifts,
      hours: totalHours,
      users: activeUsers,
      labourCost: labourCost.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' }),
    },
  });
}

router.get(
  '/schedule',
  requirePermission('schedule'),
  asyncHandler(async (req, res) => {
    const view = ['day', 'week', 'month'].includes(req.query.view) ? req.query.view : 'week';
    if (view === 'month') return renderMonthView(req, res);
    if (view === 'day') return renderDayView(req, res);
    return renderGridView(req, res, 7);
  })
);

router.post(
  '/schedule/reorder',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const idA = Number(req.body.a);
    const idB = Number(req.body.b);
    const userA = await db.prepare('SELECT id, sort_order FROM users WHERE id = ? AND active = 1').get(idA);
    const userB = await db.prepare('SELECT id, sort_order FROM users WHERE id = ? AND active = 1').get(idB);
    if (!userA || !userB) return res.status(400).json({ error: 'Invalid users.' });

    await db.prepare('UPDATE users SET sort_order = ? WHERE id = ?').run(userB.sort_order, userA.id);
    await db.prepare('UPDATE users SET sort_order = ? WHERE id = ?').run(userA.sort_order, userB.id);

    res.json({ ok: true });
  })
);

function buildSchedule(b) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : null;
  const allDay = b.all_day === 'on' || b.all_day === '1' || b.all_day === 'true';

  if (!date) return { scheduled_start: null, scheduled_end: null, all_day: 0 };

  const defaultStart = allDay ? '07:00' : '09:00';
  const startTime = /^\d{2}:\d{2}$/.test(b.start_time || '') ? b.start_time : defaultStart;
  const endTime = /^\d{2}:\d{2}$/.test(b.end_time || '') ? b.end_time : allDay ? '15:00' : null;

  return {
    scheduled_start: `${date}T${startTime}`,
    scheduled_end: endTime ? `${date}T${endTime}` : null,
    all_day: allDay ? 1 : 0,
  };
}

function deriveFormFields(job) {
  if (!job.scheduled_start) return { date: '', start_time: '', end_time: '' };
  return {
    date: job.scheduled_start.slice(0, 10),
    start_time: job.scheduled_start.slice(11, 16),
    end_time: job.scheduled_end ? job.scheduled_end.slice(11, 16) : '',
  };
}

function toLocalIsoMinute(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

router.post(
  '/:id/reschedule',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (!job.scheduled_start) return res.status(400).json({ error: 'Job has no scheduled date to move.' });

    const newDate = req.body.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate || '')) return res.status(400).json({ error: 'Invalid date.' });

    if (Object.prototype.hasOwnProperty.call(req.body, 'assignedTo')) {
      const raw = req.body.assignedTo;
      if (!raw) {
        await setAssignees(job.id, []);
      } else {
        const assignee = await db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(raw);
        if (!assignee) return res.status(400).json({ error: 'Invalid user.' });
        await setAssignees(job.id, [assignee.id]);
      }
    }

    const [y, m, d] = newDate.split('-').map(Number);
    const oldStart = new Date(job.scheduled_start);
    const newStart = new Date(oldStart);
    newStart.setFullYear(y, m - 1, d);

    let newEndIso = null;
    if (job.scheduled_end) {
      const durationMs = new Date(job.scheduled_end) - oldStart;
      newEndIso = toLocalIsoMinute(new Date(newStart.getTime() + durationMs));
    }

    await db
      .prepare(
        `UPDATE jobs SET scheduled_start = ?, scheduled_end = ?,
           status = CASE WHEN status = 'unscheduled' THEN 'scheduled' ELSE status END,
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(toLocalIsoMinute(newStart), newEndIso, job.id);

    res.json({ ok: true });
  })
);

router.get(
  '/new',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const customers = await db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();
    const techs = await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    const preselectedCustomerId = req.query.customer_id ? Number(req.query.customer_id) : null;
    const preselectedDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : '';
    res.render('jobs/form', {
      title: 'New Job',
      job: { customer_id: preselectedCustomerId, date: preselectedDate, start_time: '', end_time: '', all_day: false, assigneeIds: [] },
      customers,
      techs,
      STATUSES,
      colors: JOB_COLORS,
      error: null,
    });
  })
);

router.post(
  '/',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const b = req.body;
    const customers = await db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();
    const techs = await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    const assigneeIds = parseAssigneeIds(b);

    if (!b.title || !b.title.trim() || !b.customer_id) {
      return res.status(400).render('jobs/form', {
        title: 'New Job',
        job: { ...b, assigneeIds },
        customers,
        techs,
        STATUSES,
        colors: JOB_COLORS,
        error: 'Job title and customer are required.',
      });
    }

    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
    const schedule = buildSchedule(b);
    const status = schedule.scheduled_start ? 'scheduled' : 'unscheduled';

    const result = await db
      .prepare(
        `INSERT INTO jobs
          (customer_id, title, description, status, scheduled_start, scheduled_end, all_day, color,
           site_address_street, site_address_city, site_address_state, site_address_postcode, notes, created_by)
         VALUES
          (@customer_id, @title, @description, @status, @scheduled_start, @scheduled_end, @all_day, @color,
           @site_address_street, @site_address_city, @site_address_state, @site_address_postcode, @notes, @created_by)
         RETURNING id`
      )
      .run({
        customer_id: b.customer_id,
        title: b.title.trim(),
        description: b.description || null,
        status,
        scheduled_start: schedule.scheduled_start,
        scheduled_end: schedule.scheduled_end,
        all_day: schedule.all_day,
        color: parseJobColor(b.color),
        site_address_street: b.site_address_street || customer.address_street || null,
        site_address_city: b.site_address_city || customer.address_city || null,
        site_address_state: b.site_address_state || customer.address_state || null,
        site_address_postcode: b.site_address_postcode || customer.address_postcode || null,
        notes: b.notes || null,
        created_by: req.user.id,
      });

    await setAssignees(result.lastInsertRowid, assigneeIds);

    setFlash(req, 'success', `Job "${b.title.trim()}" created.`);
    res.redirect(`/jobs/${result.lastInsertRowid}`);
  })
);

const COST_CATEGORIES = ['labour', 'material', 'subcontractor', 'travel', 'other'];

// "You instantly know which jobs make money" - profitability across every
// job, most recently updated first.
router.get(
  '/costing',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const rows = (
      await db
        .prepare(
          `SELECT jobs.id, jobs.title, jobs.status, customers.name AS customer_name,
             job_costs.quoted_amount,
             COALESCE((SELECT SUM(quantity * unit_cost) FROM job_cost_items WHERE job_cost_items.job_id = jobs.id), 0) AS total_cost
           FROM jobs
           JOIN customers ON customers.id = jobs.customer_id
           LEFT JOIN job_costs ON job_costs.job_id = jobs.id
           ORDER BY jobs.updated_at DESC`
        )
        .all()
    ).map((r) => ({
      ...r,
      profit: r.quoted_amount !== null ? r.quoted_amount - r.total_cost : null,
    }));

    res.render('jobs/costing', { title: 'Job Costing', rows });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;
    const attachments = await db.prepare('SELECT * FROM job_attachments WHERE job_id = ? ORDER BY created_at DESC').all(job.id);
    const jobForms = await db.prepare('SELECT * FROM job_forms WHERE job_id = ? ORDER BY created_at DESC').all(job.id);

    let costing = null;
    if (req.user.role === 'admin') {
      const jobCosts = await db.prepare('SELECT * FROM job_costs WHERE job_id = ?').get(job.id);
      const costItems = await db.prepare('SELECT * FROM job_cost_items WHERE job_id = ? ORDER BY created_at ASC').all(job.id);
      const totalCost = costItems.reduce((sum, i) => sum + i.quantity * i.unit_cost, 0);
      const quotedAmount = jobCosts ? jobCosts.quoted_amount : null;
      costing = {
        quotedAmount,
        costItems,
        totalCost,
        profit: quotedAmount !== null ? quotedAmount - totalCost : null,
        categories: COST_CATEGORIES,
      };
    }

    let jobInvoices = null;
    if (req.user.role === 'admin') {
      jobInvoices = await db
        .prepare(
          `SELECT invoices.*,
             COALESCE((SELECT SUM(quantity * unit_price) FROM invoice_items WHERE invoice_items.invoice_id = invoices.id), 0) AS total
           FROM invoices WHERE invoices.job_id = ? ORDER BY invoices.created_at DESC`
        )
        .all(job.id);
    }

    const inventoryItems = await db.prepare('SELECT id, name, unit, quantity_on_hand FROM inventory_items ORDER BY name ASC').all();
    const stockAllocations = await db
      .prepare(
        `SELECT job_stock_allocations.*, inventory_items.name AS item_name, inventory_items.unit AS item_unit
         FROM job_stock_allocations JOIN inventory_items ON inventory_items.id = job_stock_allocations.item_id
         WHERE job_stock_allocations.job_id = ? ORDER BY job_stock_allocations.created_at DESC`
      )
      .all(job.id);
    const linkedAssets = await db
      .prepare(
        `SELECT customer_assets.* FROM job_assets
         JOIN customer_assets ON customer_assets.id = job_assets.asset_id
         WHERE job_assets.job_id = ? ORDER BY customer_assets.type, customer_assets.name`
      )
      .all(job.id);

    res.render('jobs/show', {
      title: job.title,
      job,
      STATUSES,
      attachments,
      jobForms,
      costing,
      jobInvoices,
      inventoryItems,
      stockAllocations,
      linkedAssets,
      closeUrl: safeReturnTo(req.query.returnTo) || homeRoute(req.user),
    });
  })
);

router.post(
  '/:id/costing/quote',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).render('error', { message: 'Job not found.' });

    const quotedAmount = req.body.quoted_amount === '' ? null : Number.parseFloat(req.body.quoted_amount);

    await db
      .prepare(
        `INSERT INTO job_costs (job_id, quoted_amount, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(job_id) DO UPDATE SET quoted_amount = excluded.quoted_amount, updated_at = excluded.updated_at`
      )
      .run(job.id, Number.isFinite(quotedAmount) ? quotedAmount : null);

    setFlash(req, 'success', 'Quoted amount updated.');
    res.redirect(`/jobs/${job.id}`);
  })
);

router.post(
  '/:id/costing/items',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).render('error', { message: 'Job not found.' });

    const category = COST_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
    const description = (req.body.description || '').trim();
    const quantity = Number.parseFloat(req.body.quantity);
    const unitCost = Number.parseFloat(req.body.unit_cost);

    if (!description || !Number.isFinite(quantity) || !Number.isFinite(unitCost)) {
      setFlash(req, 'error', 'Please provide a description, quantity, and cost.');
      return res.redirect(`/jobs/${job.id}`);
    }

    await db
      .prepare(`INSERT INTO job_cost_items (job_id, category, description, quantity, unit_cost, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(job.id, category, description, quantity, unitCost, req.user.id);

    setFlash(req, 'success', 'Cost item added.');
    res.redirect(`/jobs/${job.id}`);
  })
);

router.post(
  '/:id/costing/items/:itemId/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const item = await db.prepare('SELECT * FROM job_cost_items WHERE id = ? AND job_id = ?').get(req.params.itemId, req.params.id);
    if (!item) return res.status(404).render('error', { message: 'Cost item not found.' });

    // The stock was genuinely taken regardless of whether we still track its
    // cost, so unlink rather than delete the allocation record.
    await db.prepare('UPDATE job_stock_allocations SET cost_item_id = NULL WHERE cost_item_id = ?').run(item.id);
    await db.prepare('DELETE FROM job_cost_items WHERE id = ?').run(item.id);

    setFlash(req, 'success', 'Cost item removed.');
    res.redirect(`/jobs/${req.params.id}`);
  })
);

router.get(
  '/:id/edit',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;
    const customers = await db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();
    const techs = await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    res.render('jobs/form', {
      title: `Edit ${job.title}`,
      job: { ...job, ...deriveFormFields(job), assigneeIds: job.assignees.map((a) => a.id) },
      customers,
      techs,
      STATUSES,
      colors: JOB_COLORS,
      error: null,
      returnTo: safeReturnTo(req.query.returnTo),
    });
  })
);

router.post(
  '/:id',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;

    const b = req.body;
    const customers = await db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();
    const techs = await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    const assigneeIds = parseAssigneeIds(b);
    const returnTo = safeReturnTo(b.returnTo);

    if (!b.title || !b.title.trim() || !b.customer_id) {
      return res.status(400).render('jobs/form', {
        title: `Edit ${job.title}`,
        job: { ...job, ...b, assigneeIds },
        customers,
        techs,
        STATUSES,
        colors: JOB_COLORS,
        error: 'Job title and customer are required.',
        returnTo,
      });
    }

    const schedule = buildSchedule(b);

    const newStatus = b.status || job.status;
    if (newStatus === 'completed' && job.status !== 'completed') {
      const err = await checkCompletionRequirements(job.id);
      if (err) {
        setFlash(req, 'error', err);
        return res.redirect(`/jobs/${job.id}/edit`);
      }
    }

    await db
      .prepare(
        `UPDATE jobs SET
           customer_id = @customer_id, title = @title, description = @description, status = @status,
           scheduled_start = @scheduled_start, scheduled_end = @scheduled_end, all_day = @all_day, color = @color,
           site_address_street = @site_address_street, site_address_city = @site_address_city,
           site_address_state = @site_address_state, site_address_postcode = @site_address_postcode,
           notes = @notes,
           completed_at = CASE WHEN @status = 'completed' AND completed_at IS NULL THEN datetime('now') ELSE completed_at END,
           updated_at = datetime('now')
         WHERE id = @id`
      )
      .run({
        id: job.id,
        customer_id: b.customer_id,
        title: b.title.trim(),
        description: b.description || null,
        status: newStatus,
        scheduled_start: schedule.scheduled_start,
        scheduled_end: schedule.scheduled_end,
        all_day: schedule.all_day,
        color: parseJobColor(b.color),
        site_address_street: b.site_address_street || null,
        site_address_city: b.site_address_city || null,
        site_address_state: b.site_address_state || null,
        site_address_postcode: b.site_address_postcode || null,
        notes: b.notes || null,
      });

    await setAssignees(job.id, assigneeIds);

    setFlash(req, 'success', 'Job updated.');
    res.redirect(returnTo || homeRoute(req.user));
  })
);

router.post(
  '/:id/status',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;

    const status = req.body.status;
    if (!STATUSES.includes(status)) {
      return res.status(400).render('error', { message: 'Invalid status.' });
    }

    if (status === 'completed') {
      const err = await checkCompletionRequirements(job.id);
      if (err) {
        setFlash(req, 'error', err);
        return res.redirect(`/jobs/${job.id}`);
      }
    }

    await db
      .prepare(
        `UPDATE jobs SET status = @status,
           completed_at = CASE WHEN @status = 'completed' AND completed_at IS NULL THEN datetime('now') ELSE completed_at END,
           updated_at = datetime('now')
         WHERE id = @id`
      )
      .run({ id: job.id, status });

    setFlash(req, 'success', `Job marked ${status.replace('_', ' ')}.`);
    res.redirect(homeRoute(req.user));
  })
);

router.post(
  '/:id/unassign',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    await setAssignees(job.id, []);
    res.json({ ok: true });
  })
);

router.post(
  '/:id/duplicate',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).render('error', { message: 'Job not found.' });

    const status = job.scheduled_start ? 'scheduled' : 'unscheduled';

    const result = await db
      .prepare(
        `INSERT INTO jobs
          (customer_id, title, description, status, scheduled_start, scheduled_end, all_day, color,
           site_address_street, site_address_city, site_address_state, site_address_postcode, notes, created_by)
         VALUES
          (@customer_id, @title, @description, @status, @scheduled_start, @scheduled_end, @all_day, @color,
           @site_address_street, @site_address_city, @site_address_state, @site_address_postcode, @notes, @created_by)
         RETURNING id`
      )
      .run({
        customer_id: job.customer_id,
        title: `${job.title} (copy)`,
        description: job.description,
        status,
        scheduled_start: job.scheduled_start,
        scheduled_end: job.scheduled_end,
        all_day: job.all_day,
        color: job.color,
        site_address_street: job.site_address_street,
        site_address_city: job.site_address_city,
        site_address_state: job.site_address_state,
        site_address_postcode: job.site_address_postcode,
        notes: job.notes,
        created_by: req.user.id,
      });

    await setAssignees(result.lastInsertRowid, []);

    setFlash(req, 'success', 'Job duplicated into Unassigned shifts.');
    const returnTo = typeof req.body.returnTo === 'string' && req.body.returnTo.startsWith('/') ? req.body.returnTo : null;
    res.redirect(returnTo || homeRoute(req.user));
  })
);

router.post(
  '/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).render('error', { message: 'Job not found.' });

    const attachments = await db.prepare('SELECT filename FROM job_attachments WHERE job_id = ?').all(job.id);
    await Promise.all(attachments.map((a) => deleteFile(a.filename)));

    await db.prepare('DELETE FROM job_attachments WHERE job_id = ?').run(job.id);
    await db.prepare('DELETE FROM job_assignees WHERE job_id = ?').run(job.id);
    await db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);

    setFlash(req, 'success', `Job "${job.title}" deleted.`);
    const returnTo = typeof req.body.returnTo === 'string' && req.body.returnTo.startsWith('/') ? req.body.returnTo : null;
    res.redirect(returnTo || homeRoute(req.user));
  })
);

const loadJobForAccess = asyncHandler(async (req, res, next) => {
  const job = await getJobOr404(req, res);
  if (!job) return;
  req.job = job;
  next();
});

function uploadPhotos(req, res, next) {
  upload.array('photos', 5)(req, res, (err) => {
    if (err) {
      setFlash(req, 'error', err.message || 'Upload failed.');
      return res.redirect(`/jobs/${req.params.id}`);
    }
    next();
  });
}

router.post(
  '/:id/attachments',
  loadJobForAccess,
  uploadPhotos,
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    const insert = db.prepare(
      `INSERT INTO job_attachments (job_id, filename, original_name, mime_type, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const f of files) {
      const url = await putFile(f);
      await insert.run(req.job.id, url, f.originalname, f.mimetype, f.size, req.user.id);
    }

    setFlash(req, 'success', files.length ? `${files.length} photo${files.length > 1 ? 's' : ''} uploaded.` : 'No photos selected.');
    res.redirect(`/jobs/${req.job.id}`);
  })
);

router.get(
  '/:id/attachments/:attachmentId',
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;

    const attachment = await db.prepare('SELECT * FROM job_attachments WHERE id = ? AND job_id = ?').get(req.params.attachmentId, job.id);
    if (!attachment) return res.status(404).render('error', { message: 'Attachment not found.' });

    const stream = await fetchFile(attachment.filename);
    if (!stream) return res.status(404).render('error', { message: 'File not found.' });
    res.type(attachment.mime_type);
    Readable.fromWeb(stream).pipe(res);
  })
);

router.post(
  '/:id/attachments/:attachmentId/delete',
  loadJobForAccess,
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const attachment = await db
      .prepare('SELECT * FROM job_attachments WHERE id = ? AND job_id = ?')
      .get(req.params.attachmentId, req.job.id);
    if (!attachment) return res.status(404).render('error', { message: 'Attachment not found.' });

    await deleteFile(attachment.filename);
    await db.prepare('DELETE FROM job_attachments WHERE id = ?').run(attachment.id);

    setFlash(req, 'success', 'Photo removed.');
    res.redirect(`/jobs/${req.job.id}`);
  })
);

module.exports = router;
