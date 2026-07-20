const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

const REGULAR_MINUTES_PER_DAY = 8 * 60;
const TIMESHEET_DAYS = 7;

function toLocalIso(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

function toIsoDate(d) {
  return toLocalIso(d).slice(0, 10);
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
  res.redirect(req.user.role === 'admin' ? '/timeclock/team' : '/timeclock/me');
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
      .run(req.user.id, nextType, toLocalIso(new Date()), latitude, longitude, accuracy);

    setFlash(req, 'success', nextType === 'in' ? 'Clocked in.' : 'Clocked out.');
    res.redirect('/timeclock/me');
  })
);

router.get(
  '/team',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const dayIso = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : toIsoDate(new Date());

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
      todayIso: toIsoDate(new Date()),
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
    const startIso = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : mondayOf(toIsoDate(new Date()));
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
      return { id: u.id, name: u.name, cells, totalMinutes: rowTotalMinutes };
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
