const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');
const { REGULAR_MINUTES_PER_DAY, toIsoDate, addDays, mondayOf, formatHours, dayStats, brisbaneTodayIso, brisbaneDatetimeIso } = require('../lib/timesheetCalc');
const { computeWeekTotals } = require('../lib/timesheetGen');

const router = express.Router();

const TIMESHEET_DAYS = 7;


function getLastEvent(userId) {
  return db.prepare('SELECT * FROM clock_events WHERE user_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1').get(userId);
}

// Geolocation is captured client-side (browser Geolocation API) at the
// moment someone taps clock in/out - it's a snapshot, not continuous
// tracking. Location is mandatory: the client blocks submission without it,
// and this parses/validates it server-side too so that guarantee holds even
// if JS is bypassed.
function parseCoord(raw, min, max) {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

router.get('/', (req, res) => {
  res.redirect(req.user.role === 'admin' ? '/timeclock/timesheets' : '/timeclock/me');
});

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const lastEvent = await getLastEvent(req.user.id);
    const isClockedIn = Boolean(lastEvent && lastEvent.type === 'in');
    const recent = await db.prepare('SELECT * FROM clock_events WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 20').all(req.user.id);

    res.render('timeclock/index', {
      title: 'Time Clock',
      isClockedIn,
      lastEvent,
      recent,
    });
  })
);

router.post(
  '/toggle',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const latitude = parseCoord(req.body.latitude, -90, 90);
    const longitude = latitude === null ? null : parseCoord(req.body.longitude, -180, 180);

    if (latitude === null || longitude === null) {
      setFlash(req, 'error', 'Location access is required to clock in or out. Please enable location services and try again.');
      return res.redirect('/timeclock/me');
    }

    const accuracy = parseCoord(req.body.accuracy, 0, 100000);
    const lastEvent = await getLastEvent(req.user.id);
    const nextType = lastEvent && lastEvent.type === 'in' ? 'out' : 'in';

    await db
      .prepare('INSERT INTO clock_events (user_id, type, occurred_at, latitude, longitude, accuracy) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, nextType, brisbaneDatetimeIso(), latitude, longitude, accuracy);

    setFlash(req, 'success', nextType === 'in' ? 'Clocked in.' : 'Clocked out.');
    res.redirect('/timeclock/me');
  })
);

router.get(
  '/team',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const dayIso = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : brisbaneTodayIso();

    const users = await db.prepare('SELECT id, name, sort_order FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    const events = await db
      .prepare('SELECT * FROM clock_events WHERE (occurred_at)::date = (?)::date ORDER BY user_id, occurred_at ASC')
      .all(dayIso);

    const eventsByUser = {};
    events.forEach((e) => {
      eventsByUser[e.user_id] = eventsByUser[e.user_id] || [];
      eventsByUser[e.user_id].push(e);
    });

    const mapMarkers = [];
    const rows = users.map((u) => {
      const stats = dayStats(eventsByUser[u.id] || []);
      const regular = Math.min(stats.totalMinutes, REGULAR_MINUTES_PER_DAY);
      const overtime = Math.max(0, stats.totalMinutes - REGULAR_MINUTES_PER_DAY);

      if (stats.lastEvent && stats.lastEvent.latitude !== null && stats.lastEvent.longitude !== null) {
        mapMarkers.push({
          name: u.name,
          lat: stats.lastEvent.latitude,
          lng: stats.lastEvent.longitude,
          type: stats.lastEvent.type,
          time: new Date(stats.lastEvent.occurred_at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }),
        });
      }

      return {
        id: u.id,
        name: u.name,
        clockIn: stats.firstIn,
        clockOut: stats.lastOut,
        stillIn: stats.stillIn,
        totalMinutes: stats.totalMinutes,
        regularMinutes: regular,
        overtimeMinutes: overtime,
        hasLocation: Boolean(stats.lastEvent && stats.lastEvent.latitude !== null),
        lastLat: stats.lastEvent ? stats.lastEvent.latitude : null,
        lastLng: stats.lastEvent ? stats.lastEvent.longitude : null,
      };
    });

    const dayAnchor = new Date(`${dayIso}T00:00:00`);

    res.render('timeclock/team', {
      title: 'Time Clock — Today',
      dayIso,
      dayLabel: dayAnchor.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      prevDayIso: addDays(dayIso, -1),
      nextDayIso: addDays(dayIso, 1),
      todayIso: brisbaneTodayIso(),
      rows,
      mapMarkers,
      formatHours,
    });
  })
);

router.get(
  '/timesheets',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const startIso = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : mondayOf(brisbaneTodayIso());
    const endIso = addDays(startIso, TIMESHEET_DAYS - 1);

    const days = [];
    for (let i = 0; i < TIMESHEET_DAYS; i += 1) {
      const iso = addDays(startIso, i);
      const d = new Date(`${iso}T00:00:00`);
      days.push({ iso, label: d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'numeric' }) });
    }

    const users = await db.prepare('SELECT id, name, sort_order FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    const events = await db
      .prepare('SELECT * FROM clock_events WHERE (occurred_at)::date BETWEEN (?)::date AND (?)::date ORDER BY user_id, occurred_at ASC')
      .all(startIso, endIso);
    const timesheetRows = await db.prepare('SELECT * FROM timesheets WHERE week_start = ?').all(startIso);
    const timesheetByUser = {};
    timesheetRows.forEach((t) => {
      timesheetByUser[t.user_id] = t;
    });

    const eventsByUserDay = {};
    events.forEach((e) => {
      const day = e.occurred_at.slice(0, 10);
      eventsByUserDay[e.user_id] = eventsByUserDay[e.user_id] || {};
      eventsByUserDay[e.user_id][day] = eventsByUserDay[e.user_id][day] || [];
      eventsByUserDay[e.user_id][day].push(e);
    });

    let totalRegularMinutes = 0;
    let totalOvertimeMinutes = 0;

    const rows = users.map((u) => {
      let rowTotalMinutes = 0;
      const cells = days.map((day) => {
        const dayEvents = (eventsByUserDay[u.id] && eventsByUserDay[u.id][day.iso]) || [];
        const stats = dayStats(dayEvents);
        rowTotalMinutes += stats.totalMinutes;
        totalRegularMinutes += Math.min(stats.totalMinutes, REGULAR_MINUTES_PER_DAY);
        totalOvertimeMinutes += Math.max(0, stats.totalMinutes - REGULAR_MINUTES_PER_DAY);
        return { minutes: stats.totalMinutes, stillIn: stats.stillIn };
      });
      return { id: u.id, name: u.name, cells, totalMinutes: rowTotalMinutes, timesheet: timesheetByUser[u.id] || null };
    });

    res.render('timeclock/timesheets', {
      title: 'Time Clock — Timesheets',
      days,
      rows,
      startIso,
      endIso,
      prevStartIso: addDays(startIso, -TIMESHEET_DAYS),
      nextStartIso: addDays(startIso, TIMESHEET_DAYS),
      totalRegularMinutes,
      totalOvertimeMinutes,
      formatHours,
    });
  })
);

router.post(
  '/timesheets/:userId/approve',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(req.body.week_start || '') ? req.body.week_start : mondayOf(toIsoDate(new Date()));
    const weekEnd = addDays(weekStart, TIMESHEET_DAYS - 1);
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId);
    if (!user) return res.status(404).render('error', { message: 'Employee not found.' });

    // Recomputed live rather than trusting whatever the cron generated -
    // covers both a week nothing was auto-generated for, and a late
    // correction to a clock event after generation but before approval.
    const totals = await computeWeekTotals(user.id, weekStart, weekEnd);
    await db
      .prepare(
        `INSERT INTO timesheets (user_id, week_start, week_end, total_minutes, regular_minutes, overtime_minutes, status, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'))
         ON CONFLICT (user_id, week_start) DO UPDATE SET
           total_minutes = excluded.total_minutes, regular_minutes = excluded.regular_minutes,
           overtime_minutes = excluded.overtime_minutes, status = 'approved',
           approved_by = excluded.approved_by, approved_at = excluded.approved_at, updated_at = datetime('now')`
      )
      .run(user.id, weekStart, weekEnd, totals.totalMinutes, totals.regularMinutes, totals.overtimeMinutes, req.user.id);

    setFlash(req, 'success', 'Timesheet approved.');
    res.redirect(`/timeclock/timesheets?start=${weekStart}`);
  })
);

// --- Admin: correct/add/remove individual clock events for a user+day ---
// Manual corrections never get a location attached - only a real clock
// in/out captured on-device does.

router.get(
  '/edit/:userId/:date',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(req.params.date) ? req.params.date : toIsoDate(new Date());
    const user = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.params.userId);
    if (!user) return res.status(404).render('error', { message: 'User not found.' });

    const events = await db
      .prepare('SELECT * FROM clock_events WHERE user_id = ? AND (occurred_at)::date = (?)::date ORDER BY occurred_at ASC')
      .all(user.id, dateIso);
    const dateAnchor = new Date(`${dateIso}T00:00:00`);

    res.render('timeclock/edit', {
      title: `Edit Time — ${user.name}`,
      editedUser: user,
      dateIso,
      dateLabel: dateAnchor.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      events,
    });
  })
);

router.post(
  '/edit/:userId/:date/events',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const dateIso = req.params.date;
    const type = req.body.type === 'out' ? 'out' : 'in';
    const time = /^\d{2}:\d{2}$/.test(req.body.time || '') ? req.body.time : null;

    if (!time) {
      setFlash(req, 'error', 'Please provide a valid time.');
    } else {
      await db
        .prepare('INSERT INTO clock_events (user_id, type, occurred_at) VALUES (?, ?, ?)')
        .run(req.params.userId, type, `${dateIso}T${time}:00`);
      setFlash(req, 'success', 'Clock event added.');
    }
    res.redirect(`/timeclock/edit/${req.params.userId}/${dateIso}`);
  })
);

router.post(
  '/events/:id',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const event = await db.prepare('SELECT * FROM clock_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).render('error', { message: 'Clock event not found.' });

    const dateIso = event.occurred_at.slice(0, 10);
    const type = req.body.type === 'out' ? 'out' : 'in';
    const time = /^\d{2}:\d{2}$/.test(req.body.time || '') ? req.body.time : null;

    if (!time) {
      setFlash(req, 'error', 'Please provide a valid time.');
    } else {
      await db.prepare('UPDATE clock_events SET type = ?, occurred_at = ? WHERE id = ?').run(type, `${dateIso}T${time}:00`, event.id);
      setFlash(req, 'success', 'Clock event updated.');
    }
    res.redirect(`/timeclock/edit/${event.user_id}/${dateIso}`);
  })
);

router.post(
  '/events/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const event = await db.prepare('SELECT * FROM clock_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).render('error', { message: 'Clock event not found.' });

    const dateIso = event.occurred_at.slice(0, 10);
    const userId = event.user_id;
    await db.prepare('DELETE FROM clock_events WHERE id = ?').run(event.id);

    setFlash(req, 'success', 'Clock event deleted.');
    res.redirect(`/timeclock/edit/${userId}/${dateIso}`);
  })
);

module.exports = router;
