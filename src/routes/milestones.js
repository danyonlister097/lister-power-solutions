const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');
const { brisbaneTodayIso } = require('../lib/timesheetCalc');

const router = express.Router();

const WINDOW_DAYS = 183; // ~6 months

function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysUntil(fromIso, toIso) {
  return Math.round((new Date(toIso) - new Date(fromIso)) / 86400000);
}

function buildUpcoming(todayIso, allStaff, customMilestones, totalJobs) {
  const horizon = addDays(todayIso, WINDOW_DAYS);
  const thisYear = Number(todayIso.slice(0, 4));
  const items = [];

  // Birthdays
  for (const u of allStaff.filter((s) => s.date_of_birth)) {
    const mmdd = u.date_of_birth.slice(5);
    let next = `${thisYear}-${mmdd}`;
    if (next < todayIso) next = `${thisYear + 1}-${mmdd}`;
    if (next > horizon) continue;
    items.push({ date: next, days: daysUntil(todayIso, next), icon: '🎂', label: u.name, sub: 'Birthday', type: 'birthday' });
  }

  // Work anniversaries
  for (const u of allStaff.filter((s) => s.employment_start_date)) {
    const mmdd = u.employment_start_date.slice(5);
    const startYear = Number(u.employment_start_date.slice(0, 4));
    let next = `${thisYear}-${mmdd}`;
    if (next < todayIso) next = `${thisYear + 1}-${mmdd}`;
    if (next > horizon) continue;
    const yrs = Number(next.slice(0, 4)) - startYear;
    if (yrs <= 0) continue;
    items.push({ date: next, days: daysUntil(todayIso, next), icon: '🏅', label: u.name, sub: `${yrs} year${yrs === 1 ? '' : 's'} with the team`, type: 'anniversary' });
  }

  // Custom milestones
  for (const m of customMilestones) {
    let next = m.date;
    let displayTitle = m.title;
    if (m.recurrence === 'annual') {
      const originalYear = Number(m.date.slice(0, 4));
      const mmdd = m.date.slice(5);
      next = `${thisYear}-${mmdd}`;
      if (next < todayIso) next = `${thisYear + 1}-${mmdd}`;
      const yearOffset = Number(next.slice(0, 4)) - originalYear;
      if (yearOffset > 0) {
        displayTitle = m.title.replace(/\b(\d+)\b/, (_, n) => String(Number(n) + yearOffset));
      }
    }
    if (next < todayIso || next > horizon) continue;
    items.push({ date: next, days: daysUntil(todayIso, next), icon: '⭐', label: displayTitle, sub: m.recurrence === 'annual' ? 'Annual milestone' : 'Milestone', type: 'custom', id: m.id });
  }

  // Job count milestone
  const nextJobMilestone = Math.ceil((totalJobs + 1) / 100) * 100;
  items.push({ date: null, days: null, icon: '🏆', label: `Job #${nextJobMilestone} milestone`, sub: `${nextJobMilestone - totalJobs} job${nextJobMilestone - totalJobs === 1 ? '' : 's'} away (${totalJobs} total)`, type: 'jobs' });

  items.sort((a, b) => {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date.localeCompare(b.date);
  });

  return items;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const todayIso = brisbaneTodayIso();
    const allStaff = await db.prepare('SELECT id, name, date_of_birth, employment_start_date FROM users WHERE active = 1').all();
    const customMilestones = await db.prepare('SELECT id, title, date, recurrence, notes FROM milestones ORDER BY date ASC').all();
    const totalJobs = Number((await db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).n);

    const upcoming = buildUpcoming(todayIso, allStaff, customMilestones, totalJobs);

    res.render('milestones/index', {
      title: 'Business Milestones',
      upcoming,
      customMilestones,
      isAdmin: req.user.role === 'admin',
    });
  })
);

router.post(
  '/',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const title = (req.body.title || '').trim();
    const date = req.body.date || '';
    const recurrence = req.body.recurrence === 'annual' ? 'annual' : 'once';
    const notes = (req.body.notes || '').trim() || null;

    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setFlash(req, 'error', 'Title and a valid date are required.');
      return res.redirect('/milestones');
    }

    await db
      .prepare('INSERT INTO milestones (title, date, recurrence, notes, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(title, date, recurrence, notes, req.user.id);

    setFlash(req, 'success', `Milestone "${title}" added.`);
    res.redirect('/milestones');
  })
);

router.post(
  '/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const m = await db.prepare('SELECT id, title FROM milestones WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).render('error', { message: 'Milestone not found.' });

    await db.prepare('DELETE FROM milestones WHERE id = ?').run(m.id);

    setFlash(req, 'success', `Milestone "${m.title}" deleted.`);
    res.redirect('/milestones');
  })
);

module.exports = router;
