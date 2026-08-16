const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../lib/asyncHandler');
const { verifyCsrf } = require('../middleware/auth');
const { formatHours, addDays, mondayOf, brisbaneTodayIso } = require('../lib/timesheetCalc');

const router = express.Router();

// Source of truth for both the drag-to-reorder UI and the saved layout's
// validity - a widget key that isn't in here (removed feature, typo, tamper)
// is dropped rather than rendered.
const DEFAULT_WIDGET_ORDER = [
  'pending_approvals',
  'upcoming_bills',
  'job_pipeline',
  'overdue_invoices',
  'outstanding_quotes',
  'quick_tasks',
  'utilisation',
  'upcoming_renewals',
  'business_milestones',
  'upcoming_maintenance',
  'bug_reports',
];

// Merges a user's saved order with the default: known keys keep the saved
// position, anything new (a widget added after the user last customised
// their layout) or never-customised is appended in default order.
function resolveWidgetOrder(savedJson) {
  let saved = [];
  if (savedJson) {
    try {
      const parsed = JSON.parse(savedJson);
      if (Array.isArray(parsed)) saved = parsed;
    } catch {
      saved = [];
    }
  }
  const known = new Set(DEFAULT_WIDGET_ORDER);
  const ordered = saved.filter((k) => known.has(k));
  const missing = DEFAULT_WIDGET_ORDER.filter((k) => !ordered.includes(k));
  return [...ordered, ...missing];
}

router.get(
  '/',
  // Gated at the mount point in app.js by the "dashboard" permission
  // instead of a hardcoded role.
  asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    // Only admins get a customisable layout - see the message that started
    // this feature: "each admin may have a different preference". Everyone
    // else always sees the default order.
    // loadUser's SELECT is an explicit column list that doesn't include
    // this, so it's fetched here rather than widening that shared query.
    let widgetOrder = DEFAULT_WIDGET_ORDER;
    if (isAdmin) {
      const row = await db.prepare('SELECT dashboard_layout FROM users WHERE id = ?').get(req.user.id);
      widgetOrder = resolveWidgetOrder(row && row.dashboard_layout);
    }

    const todayIso = brisbaneTodayIso();
    const weekStartIso = mondayOf(todayIso);
    const weekEndIso = addDays(weekStartIso, 6);
    const monthStartIso = `${todayIso.slice(0, 7)}-01`;

    const jobsThisWeek = (
      await db
        .prepare('SELECT COUNT(*) AS n FROM jobs WHERE (scheduled_start)::date BETWEEN (?)::date AND (?)::date')
        .get(weekStartIso, weekEndIso)
    ).n;

    const jobsToday = (await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE (scheduled_start)::date = (?)::date').get(todayIso)).n;

    const revenueThisMonth = (
      await db
        .prepare(
          `SELECT COALESCE(SUM(quantity * unit_price), 0) AS total
           FROM invoice_items JOIN invoices ON invoices.id = invoice_items.invoice_id
           WHERE invoices.status = 'paid' AND (invoices.paid_at)::date >= (?)::date`
        )
        .get(monthStartIso)
    ).total;

    const overdueInvoices = await db
      .prepare(
        `SELECT invoices.id, invoices.invoice_number, invoices.due_date, jobs.title AS job_title, customers.name AS customer_name,
           COALESCE((SELECT SUM(quantity * unit_price) FROM invoice_items WHERE invoice_items.invoice_id = invoices.id), 0) AS total
         FROM invoices
         JOIN jobs ON jobs.id = invoices.job_id
         JOIN customers ON customers.id = jobs.customer_id
         WHERE invoices.status = 'sent' AND (invoices.due_date)::date < (?)::date
         ORDER BY invoices.due_date ASC`
      )
      .all(todayIso);
    const overdueTotal = overdueInvoices.reduce((sum, i) => sum + i.total, 0);

    const outstandingQuotes = await db
      .prepare(
        `SELECT quotes.id, quotes.title, customers.name AS customer_name,
           COALESCE((SELECT SUM(quantity * unit_price) FROM quote_items WHERE quote_items.quote_id = quotes.id), 0) AS total
         FROM quotes
         JOIN customers ON customers.id = quotes.customer_id
         WHERE quotes.status IN ('draft', 'sent')
         ORDER BY quotes.created_at DESC`
      )
      .all();
    const outstandingQuotesTotal = outstandingQuotes.reduce((sum, q) => sum + q.total, 0);

    const billsCutoff = addDays(todayIso, 30);
    const upcomingBills = await db
      .prepare(
        `SELECT id, supplier, supplier_invoice_number, due_date, total
         FROM bills
         WHERE status = 'unpaid' AND due_date IS NOT NULL AND (due_date)::date <= (?)::date
         ORDER BY due_date ASC
         LIMIT 15`
      )
      .all(billsCutoff);
    const upcomingBillsTotal = upcomingBills.reduce((sum, b) => sum + b.total, 0);
    const overdueBillsCount = upcomingBills.filter((b) => b.due_date < todayIso).length;

    const lowStockItems = await db
      .prepare(
        `SELECT id, name, quantity_on_hand, unit, reorder_threshold
         FROM inventory_items
         WHERE reorder_threshold IS NOT NULL AND quantity_on_hand <= reorder_threshold
         ORDER BY name`
      )
      .all();

    // Everything an admin needs to review/act on, in one place - leave and
    // timesheets are genuine approvals; low stock isn't, but it's the same
    // "needs your attention" shape, so it lives here instead of duplicating
    // a separate widget further down the page.
    const pendingLeave = await db
      .prepare(
        `SELECT leave_requests.*, users.name AS user_name
         FROM leave_requests JOIN users ON users.id = leave_requests.user_id
         WHERE leave_requests.status = 'pending'
         ORDER BY leave_requests.start_date ASC`
      )
      .all();

    const pendingTimesheets = await db
      .prepare(
        `SELECT timesheets.*, users.name AS user_name
         FROM timesheets JOIN users ON users.id = timesheets.user_id
         WHERE timesheets.status = 'pending' AND timesheets.total_minutes > 0
         ORDER BY timesheets.week_start ASC`
      )
      .all();

    const weekJobs = await db
      .prepare('SELECT id, scheduled_start, scheduled_end FROM jobs WHERE (scheduled_start)::date BETWEEN (?)::date AND (?)::date')
      .all(weekStartIso, weekEndIso);
    const jobIds = weekJobs.map((j) => j.id);
    const minutesByUser = {};
    if (jobIds.length) {
      const placeholders = jobIds.map(() => '?').join(',');
      const assignees = await db.prepare(`SELECT job_id, user_id FROM job_assignees WHERE job_id IN (${placeholders})`).all(...jobIds);
      const jobById = Object.fromEntries(weekJobs.map((j) => [j.id, j]));
      assignees.forEach((a) => {
        const job = jobById[a.job_id];
        if (!job || !job.scheduled_start || !job.scheduled_end) return;
        const minutes = (new Date(job.scheduled_end) - new Date(job.scheduled_start)) / 60000;
        minutesByUser[a.user_id] = (minutesByUser[a.user_id] || 0) + minutes;
      });
    }
    const techs = await db
      .prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('trade', 'apprentice') ORDER BY sort_order, name")
      .all();
    const utilisation = techs.map((t) => ({
      name: t.name,
      pct: Math.round(((minutesByUser[t.id] || 0) / 60 / 38) * 100),
    }));

    // A job's board column is derived, not stored: it starts in Unassigned/
    // Scheduled based on jobs.status, moves to Completed once marked done, then
    // jumps to Invoiced the moment a real (non-cancelled) invoice exists for it
    // - so raising an invoice is what clears a job off the "needs invoicing" pile.
    const pipelineJobs = await db
      .prepare(
        `SELECT jobs.id, jobs.title, jobs.status, customers.name AS customer_name,
           EXISTS(SELECT 1 FROM invoices WHERE invoices.job_id = jobs.id AND invoices.status != 'cancelled') AS has_invoice
         FROM jobs
         JOIN customers ON customers.id = jobs.customer_id
         WHERE jobs.status != 'cancelled'
         ORDER BY jobs.updated_at DESC`
      )
      .all();

    const jobBoard = { unassigned: [], scheduled: [], completed: [], invoiced: [] };
    pipelineJobs.forEach((j) => {
      if (j.has_invoice) jobBoard.invoiced.push(j);
      else if (j.status === 'completed') jobBoard.completed.push(j);
      else if (j.status === 'unscheduled') jobBoard.unassigned.push(j);
      else jobBoard.scheduled.push(j);
    });

    // Vehicles, testing gear, ladders etc. flag themselves here the moment
    // next_service_due/registration_expiry falls within 30 days (or has
    // already passed), or the odometer comes within 1000km of the km-based
    // service mark - no separate reminder system needed.
    const maintenanceCutoff = addDays(todayIso, 30);
    const KM_BUFFER = 1000;
    const upcomingMaintenanceRows = await db
      .prepare(
        `SELECT id, name, category, next_service_due, registration_expiry, current_odometer_km, service_due_at_km
         FROM business_assets
         WHERE status IN ('active', 'in_repair')
           AND (next_service_due IS NOT NULL OR registration_expiry IS NOT NULL
             OR (current_odometer_km IS NOT NULL AND service_due_at_km IS NOT NULL))`
      )
      .all();
    const upcomingMaintenance = upcomingMaintenanceRows
      .map((a) => {
        const flags = [];
        if (a.next_service_due && a.next_service_due <= maintenanceCutoff) {
          flags.push({ reason: 'Service due', overdue: a.next_service_due < todayIso, dueDateIso: a.next_service_due, sortKey: a.next_service_due });
        }
        if (a.registration_expiry && a.registration_expiry <= maintenanceCutoff) {
          flags.push({ reason: 'Rego expiry', overdue: a.registration_expiry < todayIso, dueDateIso: a.registration_expiry, sortKey: a.registration_expiry });
        }
        if (a.current_odometer_km !== null && a.service_due_at_km !== null && a.current_odometer_km >= a.service_due_at_km - KM_BUFFER) {
          flags.push({
            reason: 'Service due (km)',
            overdue: a.current_odometer_km >= a.service_due_at_km,
            currentKm: a.current_odometer_km,
            dueKm: a.service_due_at_km,
            sortKey: '9999-12-31',
          });
        }
        if (!flags.length) return null;
        flags.sort((x, y) => (x.overdue !== y.overdue ? (x.overdue ? -1 : 1) : x.sortKey < y.sortKey ? -1 : 1));
        return { id: a.id, name: a.name, category: a.category, ...flags[0] };
      })
      .filter(Boolean)
      .sort((a, b) => (a.overdue !== b.overdue ? (a.overdue ? -1 : 1) : a.sortKey < b.sortKey ? -1 : 1));

    const activeTasks = await db
      .prepare(
        `SELECT t.id, t.title, au.name AS assignee_name, cu.name AS creator_name
         FROM tasks t
         JOIN users cu ON cu.id = t.created_by
         LEFT JOIN users au ON au.id = t.assigned_to
         WHERE t.done = 0
         ORDER BY t.created_at ASC`
      )
      .all();

    const openFeedback = await db
      .prepare(
        `SELECT f.id, f.type, f.title, f.status, u.name AS submitter_name
         FROM feedback_items f
         JOIN users u ON u.id = f.submitted_by
         WHERE f.status IN ('open', 'in_progress')
         ORDER BY f.created_at DESC`
      )
      .all();

    // Upcoming renewals: manual items + vehicle rego from asset register, within 60 days
    const renewalsCutoff = addDays(todayIso, 60);
    const [upcomingRenewals, upcomingAssetRego] = await Promise.all([
      db
        .prepare(
          `SELECT r.id, r.title, r.category, r.expiry_date, u.name AS user_name
           FROM renewals r
           LEFT JOIN users u ON u.id = r.user_id
           WHERE r.expiry_date <= ?
           ORDER BY r.expiry_date ASC
           LIMIT 10`
        )
        .all(renewalsCutoff),
      db
        .prepare(
          `SELECT id, name, registration_expiry AS expiry_date
           FROM business_assets
           WHERE registration_expiry IS NOT NULL
             AND registration_expiry <= ?
             AND status IN ('active', 'in_repair')
           ORDER BY registration_expiry ASC`
        )
        .all(renewalsCutoff),
    ]);

    // Combine and sort renewal items; asset rego rows get a synthetic category
    const upcomingRenewalItems = [
      ...upcomingRenewals,
      ...upcomingAssetRego.map((a) => ({
        id: null,
        asset_register_id: a.id,
        title: a.name,
        category: 'vehicle_rego',
        expiry_date: a.expiry_date,
        user_name: null,
      })),
    ].sort((a, b) => (a.expiry_date < b.expiry_date ? -1 : 1));

    // Milestones: birthdays + work anniversaries within 30 days, job count milestone
    const allStaff = await db
      .prepare('SELECT id, name, date_of_birth, employment_start_date FROM users WHERE active = 1')
      .all();
    const thisYear = Number(todayIso.slice(0, 4));

    const upcomingBirthdays = allStaff
      .filter((u) => u.date_of_birth)
      .map((u) => {
        const mmdd = u.date_of_birth.slice(5);
        let nextBirthday = `${thisYear}-${mmdd}`;
        if (nextBirthday < todayIso) nextBirthday = `${thisYear + 1}-${mmdd}`;
        const daysUntil = Math.round((new Date(nextBirthday) - new Date(todayIso)) / 86400000);
        return { ...u, nextBirthday, daysUntil };
      })
      .filter((u) => u.daysUntil <= 30)
      .sort((a, b) => a.daysUntil - b.daysUntil);

    const upcomingAnniversaries = allStaff
      .filter((u) => u.employment_start_date)
      .map((u) => {
        const mmdd = u.employment_start_date.slice(5);
        const startYear = Number(u.employment_start_date.slice(0, 4));
        let nextAnniv = `${thisYear}-${mmdd}`;
        if (nextAnniv < todayIso) nextAnniv = `${thisYear + 1}-${mmdd}`;
        const yearsOfService = Number(nextAnniv.slice(0, 4)) - startYear;
        const daysUntil = Math.round((new Date(nextAnniv) - new Date(todayIso)) / 86400000);
        return { ...u, nextAnniv, daysUntil, yearsOfService };
      })
      .filter((u) => u.daysUntil <= 30 && u.yearsOfService > 0)
      .sort((a, b) => a.daysUntil - b.daysUntil);

    const totalJobs = Number((await db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).n);
    const nextJobMilestone = Math.ceil((totalJobs + 1) / 100) * 100;
    const jobsUntilMilestone = nextJobMilestone - totalJobs;
    const jobMilestone = { totalJobs, nextJobMilestone, jobsUntilMilestone, justHit: totalJobs % 100 === 0 && totalJobs > 0 };

    const allCustomMilestones = await db.prepare('SELECT id, title, date, recurrence FROM milestones').all();
    const upcomingCustomMilestones = allCustomMilestones
      .map((m) => {
        let nextDate = m.date;
        let displayTitle = m.title;
        if (m.recurrence === 'annual') {
          const originalYear = Number(m.date.slice(0, 4));
          const mmdd = m.date.slice(5);
          nextDate = `${thisYear}-${mmdd}`;
          if (nextDate < todayIso) nextDate = `${thisYear + 1}-${mmdd}`;
          const yearOffset = Number(nextDate.slice(0, 4)) - originalYear;
          if (yearOffset > 0) {
            displayTitle = m.title.replace(/\b(\d+)\b/, (_, n) => String(Number(n) + yearOffset));
          }
        }
        const daysUntil = Math.round((new Date(nextDate) - new Date(todayIso)) / 86400000);
        return { ...m, nextDate, daysUntil, displayTitle };
      })
      .filter((m) => m.daysUntil >= 0 && m.daysUntil <= 30)
      .sort((a, b) => a.daysUntil - b.daysUntil);

    res.render('dashboard/index', {
      title: 'Dashboard',
      isAdmin,
      widgetOrder,
      todayIso,
      jobsThisWeek,
      jobsToday,
      revenueThisMonth,
      overdueInvoices,
      overdueTotal,
      outstandingQuotes,
      outstandingQuotesTotal,
      upcomingBills,
      upcomingBillsTotal,
      overdueBillsCount,
      lowStockItems,
      pendingLeave,
      pendingTimesheets,
      utilisation,
      jobBoard,
      upcomingMaintenance,
      activeTasks,
      openFeedback,
      upcomingRenewalItems,
      upcomingBirthdays,
      upcomingAnniversaries,
      upcomingCustomMilestones,
      jobMilestone,
      formatHours,
    });
  })
);

router.post(
  '/layout',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
    const order = req.body.order;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array.' });

    const known = new Set(DEFAULT_WIDGET_ORDER);
    const cleaned = order.filter((k) => typeof k === 'string' && known.has(k));
    await db.prepare('UPDATE users SET dashboard_layout = ? WHERE id = ?').run(JSON.stringify(cleaned), req.user.id);
    res.json({ ok: true });
  })
);

module.exports = router;
