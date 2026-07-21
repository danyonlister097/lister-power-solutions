const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

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

router.get(
  '/',
  // Gated at the mount point in app.js by the "dashboard" permission
  // instead of a hardcoded role.
  asyncHandler(async (req, res) => {
    const today = new Date();
    const todayIso = toIsoDate(today);
    const weekStart = mondayOf(today);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const weekStartIso = toIsoDate(weekStart);
    const weekEndIso = toIsoDate(weekEnd);
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

    const lowStockItems = await db
      .prepare(
        `SELECT id, name, quantity_on_hand, unit, reorder_threshold
         FROM inventory_items
         WHERE reorder_threshold IS NOT NULL AND quantity_on_hand <= reorder_threshold
         ORDER BY name`
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
    const maintenanceCutoff = toIsoDate(new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000));
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

    res.render('dashboard/index', {
      title: 'Dashboard',
      jobsThisWeek,
      jobsToday,
      revenueThisMonth,
      overdueInvoices,
      overdueTotal,
      outstandingQuotes,
      outstandingQuotesTotal,
      lowStockItems,
      utilisation,
      jobBoard,
      upcomingMaintenance,
    });
  })
);

module.exports = router;
