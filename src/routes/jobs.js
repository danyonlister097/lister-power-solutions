const { Readable } = require('stream');
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, requirePermission, verifyCsrf } = require('../middleware/auth');
const { setFlash } = require('../lib/flash');
const { upload, putFile, fetchFile, deleteFile } = require('../lib/uploads');
const { homeRoute } = require('../lib/homeRoute');
const { JOB_COLORS, JOB_COLOR_VALUES } = require('../lib/jobColors');
const { asyncHandler } = require('../lib/asyncHandler');
const { geocodeAddress, buildAddress } = require('../lib/geocode');
const { generateSchedule, nextMondayIso, addDaysToIso } = require('../lib/smartSchedule');
const { LEAVE_TYPE_LABELS } = require('../lib/leaveTypes');

const router = express.Router();

const STATUSES = ['unscheduled', 'scheduled', 'in_progress', 'completed', 'invoiced', 'cancelled'];
// "Invoiced" is a superstate of "completed" (invoicing implies the work is
// done) - both count as "done" for completion-requirement checks and for
// only scheduling follow-up emails/setting completed_at once.
const jobIsDone = (status) => status === 'completed' || status === 'invoiced';
// Hyphenated rather than "Air Conditioning" with a space - these values ride
// through the returnTo query string (see safeReturnTo below), whose guard
// only allows a strict charset with no spaces. Views display them via
// c.replace(/-/g, ' ') (same trick STATUSES uses with underscores).
const JOB_CATEGORIES = ['Electrical', 'Air-Conditioning', 'Solar', 'Handyman'];

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

function parseJobCategory(raw) {
  return raw && JOB_CATEGORIES.includes(raw) ? raw : null;
}

// Only ever redirect back to a same-site URL we generated ourselves - never
// follow an arbitrary returnTo value (open-redirect guard).
function safeReturnTo(raw) {
  return typeof raw === 'string' && /^\/(dashboard|jobs(\/schedule|\/\d+)?)(\?[A-Za-z0-9=&_-]*)?$/.test(raw) ? raw : null;
}

// Appends an already-validated returnTo as a query param, for handlers that
// redirect back to a fixed path (e.g. the job's own show page) but still
// need to carry the visitor's original origin (e.g. Schedule) forward so
// *that* page's own close/edit links keep pointing the right way.
function withReturnTo(path, returnTo) {
  return returnTo ? `${path}?returnTo=${encodeURIComponent(returnTo)}` : path;
}

// job_costs/job_cost_items/job_stock_allocations/job_assets/job_forms/quotes
// all reference jobs(id) with no ON DELETE CASCADE, so a plain
// `DELETE FROM jobs` fails with an opaque foreign-key-violation exception
// (a generic error page) the moment a job has any costing, stock, linked
// asset, form, or quote against it - which most real jobs do. This unwinds
// all of it first. Invoices are financial records and are never silently
// deleted here - callers must check hasInvoices() and block the delete
// instead of calling this.
async function hasInvoices(jobIds) {
  const placeholders = jobIds.map(() => '?').join(',');
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE job_id IN (${placeholders})`).get(...jobIds);
  return Number(row.n) > 0;
}

async function deleteJobsCascade(jobIds) {
  const placeholders = jobIds.map(() => '?').join(',');

  const attachments = await db.prepare(`SELECT filename FROM job_attachments WHERE job_id IN (${placeholders})`).all(...jobIds);
  await Promise.all(attachments.map((a) => deleteFile(a.filename)));
  await db.prepare(`DELETE FROM job_attachments WHERE job_id IN (${placeholders})`).run(...jobIds);

  const forms = await db.prepare(`SELECT filename FROM job_forms WHERE job_id IN (${placeholders})`).all(...jobIds);
  await Promise.all(forms.map((f) => deleteFile(f.filename)));
  await db.prepare(`DELETE FROM job_forms WHERE job_id IN (${placeholders})`).run(...jobIds);

  // Stock taken off a deleted job still needs to go back on the shelf.
  const allocations = await db.prepare(`SELECT item_id, quantity FROM job_stock_allocations WHERE job_id IN (${placeholders})`).all(...jobIds);
  for (const a of allocations) {
    await db
      .prepare(`UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + ?, updated_at = datetime('now') WHERE id = ?`)
      .run(a.quantity, a.item_id);
  }
  // Allocations reference job_cost_items, so they must go first.
  await db.prepare(`DELETE FROM job_stock_allocations WHERE job_id IN (${placeholders})`).run(...jobIds);
  await db.prepare(`DELETE FROM job_cost_items WHERE job_id IN (${placeholders})`).run(...jobIds);
  await db.prepare(`DELETE FROM job_costs WHERE job_id IN (${placeholders})`).run(...jobIds);
  await db.prepare(`DELETE FROM job_assets WHERE job_id IN (${placeholders})`).run(...jobIds);

  // A quote that created this job is a sales record worth keeping - just
  // unlink it rather than deleting it.
  await db.prepare(`UPDATE quotes SET job_id = NULL WHERE job_id IN (${placeholders})`).run(...jobIds);

  await db.prepare(`DELETE FROM job_assignees WHERE job_id IN (${placeholders})`).run(...jobIds);
  await db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...jobIds);
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

async function getAssigneeNames(jobId) {
  const rows = await db
    .prepare(
      `SELECT users.name FROM job_assignees JOIN users ON users.id = job_assignees.user_id
       WHERE job_assignees.job_id = ? ORDER BY users.sort_order, users.name`
    )
    .all(jobId);
  return rows.map((r) => r.name);
}

function truncateForHistory(v, max = 200) {
  if (!v) return v;
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function formatScheduleForHistory(job) {
  if (!job.scheduled_start) return 'Not scheduled';
  const start = new Date(job.scheduled_start);
  const datePart = start.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  if (job.all_day) return `${datePart} (all day)`;
  const timePart = start.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  if (!job.scheduled_end) return `${datePart}, ${timePart}`;
  const endTimePart = new Date(job.scheduled_end).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  return `${datePart}, ${timePart}-${endTimePart}`;
}

function formatDateTimeForHistory(v) {
  if (!v) return null;
  return new Date(v).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Snapshot used to diff before/after an edit for job_history - a flat map of
// display label -> already human-readable string, so a recorded change never
// has to re-resolve a raw column value (an FK id, a boolean flag) at render
// time. Called once before and once after a mutation; only fields that
// actually differ get written to job_history.
async function captureJobSnapshot(jobId) {
  const job = await db
    .prepare(`SELECT jobs.*, customers.name AS customer_name FROM jobs JOIN customers ON customers.id = jobs.customer_id WHERE jobs.id = ?`)
    .get(jobId);
  if (!job) return null;
  const assigneeNames = await getAssigneeNames(jobId);
  const site = [job.site_address_street, job.site_address_city, job.site_address_state, job.site_address_postcode].filter(Boolean).join(', ');
  return {
    Title: job.title || null,
    Customer: job.customer_name || null,
    Status: job.status ? job.status.replace(/_/g, ' ') : null,
    Category: job.category ? job.category.replace(/-/g, ' ') : null,
    Scheduled: formatScheduleForHistory(job),
    'Estimated duration': job.duration_minutes ? `${job.duration_minutes} min` : null,
    'Assigned to': assigneeNames.length ? assigneeNames.join(', ') : 'Unassigned',
    'Site address': site || null,
    Description: truncateForHistory(job.description),
    Notes: truncateForHistory(job.notes),
    'Actual start': formatDateTimeForHistory(job.actual_start),
    'Actual finish': formatDateTimeForHistory(job.actual_end),
    'Photos N/A': job.photos_na ? 'Yes' : 'No',
    'Stock N/A': job.stock_na ? 'Yes' : 'No',
  };
}

function diffJobSnapshots(before, after) {
  if (!before || !after) return [];
  const changes = [];
  for (const field of Object.keys(after)) {
    if (before[field] !== after[field]) changes.push({ field, from: before[field], to: after[field] });
  }
  return changes;
}

async function recordJobHistory(jobId, userId, changes) {
  if (!changes || !changes.length) return;
  await db.prepare('INSERT INTO job_history (job_id, user_id, changes) VALUES (?, ?, ?)').run(jobId, userId || null, JSON.stringify(changes));
}

// Shared by the job page's History card and the Jobs list's on-demand
// History popup, so both read the exact same data the exact same way.
async function loadJobHistoryData(jobId) {
  const job = await db.prepare('SELECT created_by, created_at FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const createdBy = job.created_by ? await db.prepare('SELECT name FROM users WHERE id = ?').get(job.created_by) : null;
  const historyRows = await db
    .prepare(
      `SELECT job_history.*, users.name AS user_name
       FROM job_history LEFT JOIN users ON users.id = job_history.user_id
       WHERE job_history.job_id = ? ORDER BY job_history.created_at DESC`
    )
    .all(jobId);
  return {
    createdByName: createdBy ? createdBy.name : null,
    createdAt: job.created_at,
    history: historyRows.map((r) => ({ id: r.id, userName: r.user_name, createdAt: r.created_at, changes: JSON.parse(r.changes) })),
  };
}

// A tech on approved leave can't be assigned to a job scheduled that day -
// used both by the create/edit job form and by schedule drag-and-drop.
// Returns the first conflict found (name + leave type label) or null.
async function findAssigneeLeaveConflict(userIds, dayIso) {
  if (!userIds || !userIds.length || !dayIso) return null;
  const placeholders = userIds.map(() => '?').join(',');
  const row = await db
    .prepare(
      `SELECT leave_requests.leave_type, users.name
       FROM leave_requests JOIN users ON users.id = leave_requests.user_id
       WHERE leave_requests.status = 'approved'
         AND leave_requests.user_id IN (${placeholders})
         AND leave_requests.start_date <= ? AND leave_requests.end_date >= ?
       LIMIT 1`
    )
    .get(...userIds, dayIso, dayIso);
  if (!row) return null;
  return { name: row.name, label: LEAVE_TYPE_LABELS[row.leave_type] || 'Leave' };
}

// Approved leave for every active tech, keyed by user id - embedded into the
// job form so it can grey out on-leave techs client-side as the date changes.
async function loadTechLeaveMap() {
  const rows = await db
    .prepare("SELECT user_id, start_date, end_date, leave_type FROM leave_requests WHERE status = 'approved'")
    .all();
  const map = {};
  for (const r of rows) {
    (map[r.user_id] = map[r.user_id] || []).push({
      start_date: r.start_date,
      end_date: r.end_date,
      label: LEAVE_TYPE_LABELS[r.leave_type] || 'Leave',
    });
  }
  return map;
}

// Approved leave overlapping a date range, keyed by user id - used to flag
// "Unavailable" on the week/day schedule grids.
async function getApprovedLeaveInRange(startIso, endIso) {
  const rows = await db
    .prepare(
      `SELECT user_id, start_date, end_date, leave_type FROM leave_requests
       WHERE status = 'approved' AND start_date <= ? AND end_date >= ?`
    )
    .all(endIso, startIso);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  return byUser;
}

function leaveOnDay(leaveByUser, userId, dayIso) {
  const list = leaveByUser.get(userId);
  if (!list) return null;
  const hit = list.find((r) => dayIso >= r.start_date && dayIso <= r.end_date);
  return hit ? { label: LEAVE_TYPE_LABELS[hit.leave_type] || 'Leave' } : null;
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

// A leading work-order number in the title (e.g. "4441 - Aircon leaking",
// sometimes with no spaces around the dash) is how jobs get entered from
// property managers' maintenance systems - the same number showing up
// twice usually means the same job got entered twice. Matched separately
// from an identical description (trimmed/case-insensitive), since either
// on its own is a strong signal. Computed globally (not filtered by the
// list's current category/assignedTo) so a genuine duplicate is never
// hidden just because its pair was mis-categorised differently.
const JOB_NUMBER_PREFIX = /^(\d+)\s*[-–—]\s*/;
const DUPLICATE_MATCH_TYPES = ['number', 'description'];

function addToGroup(map, key, id) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(id);
}

// A match (a specific job-number or description text) is only ever flagged
// or dismissed as a whole - not per pair - so a verdict made on two jobs
// automatically covers a third job that later reuses the same number.
// Returns Map<jobId, Array<{matchType, matchKey, verdict, reason}>>, where
// verdict is 'pending' (never reviewed) or 'duplicate' (confirmed); matches
// dismissed as "not a duplicate" are simply left out.
async function findDuplicateJobIds() {
  const allJobs = await db.prepare("SELECT id, title, description FROM jobs WHERE status != 'cancelled'").all();
  const decisions = await db.prepare('SELECT match_type, match_key, is_duplicate, reason FROM job_duplicate_decisions').all();
  const decisionByKey = new Map(decisions.map((d) => [`${d.match_type}:${d.match_key}`, d]));

  const byNumber = new Map();
  const byDescription = new Map();
  for (const j of allJobs) {
    const m = j.title.match(JOB_NUMBER_PREFIX);
    if (m) addToGroup(byNumber, m[1], j.id);
    const desc = (j.description || '').trim().toLowerCase();
    if (desc) addToGroup(byDescription, desc, j.id);
  }

  const matches = new Map();
  function markDuplicateGroups(groups, matchType) {
    for (const [matchKey, ids] of groups.entries()) {
      if (ids.length < 2) continue;
      const decision = decisionByKey.get(`${matchType}:${matchKey}`);
      if (decision && !decision.is_duplicate) continue; // dismissed - not flagged
      const entry = {
        matchType,
        matchKey,
        verdict: decision ? 'duplicate' : 'pending',
        reason: decision ? decision.reason : null,
      };
      for (const id of ids) {
        if (!matches.has(id)) matches.set(id, []);
        matches.get(id).push(entry);
      }
    }
  }
  markDuplicateGroups(byNumber, 'number');
  markDuplicateGroups(byDescription, 'description');
  return matches;
}

async function checkCompletionRequirements(jobId) {
  const flags = await db.prepare('SELECT photos_na, stock_na, actual_start, actual_end FROM jobs WHERE id = ?').get(jobId);
  const missing = [];
  if (!flags?.photos_na) {
    const photoCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM job_attachments WHERE job_id = ?').get(jobId)).n);
    if (photoCount === 0) missing.push('at least one photo must be added (or mark Photos as N/A)');
  }
  if (!flags?.stock_na) {
    const stockCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM job_stock_allocations WHERE job_id = ?').get(jobId)).n);
    if (stockCount === 0) missing.push('stock used must be populated (or mark Stock as N/A)');
  }
  if (!flags?.actual_start) missing.push('actual start time must be recorded');
  if (!flags?.actual_end) missing.push('actual finish time must be recorded');
  return missing.length ? `Cannot mark job as completed: ${missing.join(', ')}.` : null;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    const status = req.query.status || '';
    const category = req.query.category || '';
    const customerId = req.query.customer || '';
    const range = req.query.range || 'all';
    const assignedTo = isAdmin ? req.query.assignedTo || '' : String(req.user.id);
    const dupeReasons = await findDuplicateJobIds();
    // Non-admin-visible duplicate jobs still get flagged on their own rows,
    // but the "show me only duplicates" view is an admin data-hygiene tool -
    // gating it here also stops a non-admin using ?dupes=1 to see job titles
    // outside their own assigned jobs.
    const dupesOnly = isAdmin && req.query.dupes === '1';

    const clauses = [];
    const params = {};

    if (dupesOnly) {
      clauses.push('jobs.id = ANY(@dupeIds)');
      params.dupeIds = [...dupeReasons.keys()];
    } else {
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

      if (category) {
        clauses.push('jobs.category = @category');
        params.category = category;
      }

      if (customerId) {
        clauses.push('jobs.customer_id = @customerId');
        params.customerId = customerId;
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
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // Invoiced jobs are historical - most recent first is more useful than
    // the closest-upcoming-first order every other status view wants.
    const orderBy = status === 'invoiced' ? 'jobs.scheduled_start DESC NULLS LAST' : 'jobs.scheduled_start ASC NULLS LAST';
    const jobs = await db
      .prepare(
        `SELECT jobs.*, customers.name AS customer_name
         FROM jobs
         JOIN customers ON customers.id = jobs.customer_id
         ${where}
         ORDER BY ${orderBy}`
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
    const jobCustomers = isAdmin
      ? await db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all()
      : [];

    // Status counters — scoped to the same assignee/category/customer filter but across all time/status
    const countClauses = [];
    const countParams = { uid: isAdmin ? Number(assignedTo) : req.user.id };
    if (category) {
      countClauses.push('jobs.category = @category');
      countParams.category = category;
    }
    if (customerId) {
      countClauses.push('jobs.customer_id = @customerId');
      countParams.customerId = customerId;
    }
    const countWhere = countClauses.length ? `WHERE ${countClauses.join(' AND ')}` : '';
    const countRows = isAdmin && !assignedTo
      ? await db.prepare(`SELECT status, COUNT(*) AS n FROM jobs ${countWhere} GROUP BY status`).all(countParams)
      : await db.prepare(
          `SELECT jobs.status, COUNT(*) AS n FROM jobs
           JOIN job_assignees ja ON ja.job_id = jobs.id AND ja.user_id = @uid
           ${countWhere}
           GROUP BY jobs.status`
        ).all(countParams);
    const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const row of countRows) if (statusCounts[row.status] !== undefined) statusCounts[row.status] = Number(row.n);

    res.render('jobs/list', {
      title: 'Jobs',
      jobs,
      techs,
      jobCustomers,
      status,
      category,
      customerId,
      range,
      assignedTo,
      isAdmin,
      STATUSES,
      JOB_CATEGORIES,
      statusCounts,
      dupeReasons,
      dupesOnly,
      duplicateCount: dupeReasons.size,
      dismissedDuplicates: dupesOnly
        ? await db
            .prepare(
              `SELECT job_duplicate_decisions.*, users.name AS decided_by_name
               FROM job_duplicate_decisions
               JOIN users ON users.id = job_duplicate_decisions.decided_by
               WHERE is_duplicate = 0
               ORDER BY decided_at DESC`
            )
            .all()
        : [],
    });
  })
);

router.post(
  '/duplicates/decide',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const isDuplicate = req.body.is_duplicate === '1' ? 1 : 0;
    const reason = (req.body.reason || '').trim() || null;
    let matches = [];
    try {
      matches = JSON.parse(req.body.matches || '[]');
    } catch {
      matches = [];
    }
    matches = matches.filter((m) => m && DUPLICATE_MATCH_TYPES.includes(m.matchType) && typeof m.matchKey === 'string' && m.matchKey);

    if (!matches.length) {
      setFlash(req, 'error', 'Nothing to decide.');
      return res.redirect(safeReturnTo(req.body.returnTo) || '/jobs');
    }

    for (const m of matches) {
      await db
        .prepare(
          `INSERT INTO job_duplicate_decisions (match_type, match_key, is_duplicate, reason, decided_by)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (match_type, match_key) DO UPDATE SET
             is_duplicate = excluded.is_duplicate, reason = excluded.reason,
             decided_by = excluded.decided_by, decided_at = now_utc_text()`
        )
        .run(m.matchType, m.matchKey, isDuplicate, reason, req.user.id);
    }

    setFlash(req, 'success', isDuplicate ? 'Marked as a confirmed duplicate.' : "Marked as not a duplicate - won't be flagged again.");
    res.redirect(safeReturnTo(req.body.returnTo) || '/jobs');
  })
);

router.post(
  '/duplicates/:id/undo',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    await db.prepare('DELETE FROM job_duplicate_decisions WHERE id = ?').run(req.params.id);
    setFlash(req, 'success', 'Decision undone.');
    res.redirect(safeReturnTo(req.body.returnTo) || '/jobs?dupes=1');
  })
);

function toIsoDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function brisbaneTodayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: BUSINESS_TZ });
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
  // Falling back to a bare `new Date()` here reads the server's local clock
  // - fine on a machine set to Australian time, but Vercel's serverless
  // functions run in UTC, where "today" can already have rolled over to
  // tomorrow (or not yet rolled over from yesterday) relative to Brisbane
  // for a chunk of each day, silently landing the default view on the
  // wrong week. Anchoring on brisbaneTodayIso() keeps it correct everywhere.
  const todayIso = brisbaneTodayIso();
  const requestedStart = req.query.start ? new Date(`${req.query.start}T00:00:00`) : new Date(`${todayIso}T00:00:00`);
  const anchor = isNaN(requestedStart) ? new Date(`${todayIso}T00:00:00`) : requestedStart;
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
  const leaveByUser = await getApprovedLeaveInRange(rangeStartIso, rangeEndIso);

  function jobsFor(techId, dayIso) {
    return jobs.filter((j) => {
      const matches = techId === null ? j.assigneeIds.length === 0 : j.assigneeIds.includes(techId);
      return matches && j.scheduled_start.slice(0, 10) === dayIso;
    });
  }

  const rows = [
    { id: null, name: 'Unassigned shifts', days: days.map((d) => jobsFor(null, d.iso)), leaveByDay: days.map(() => null) },
    ...techs.map((t) => {
      const rowDays = days.map((d) => jobsFor(t.id, d.iso));
      const rowJobs = rowDays.flat();
      const minutes = sumMinutes(rowJobs);
      return {
        id: t.id,
        name: t.name,
        days: rowDays,
        leaveByDay: days.map((d) => leaveOnDay(leaveByUser, t.id, d.iso)),
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

  const isAdmin = req.user.role === 'admin';
  const visibleRows = isAdmin ? rows : rows.filter((r) => r.id === req.user.id);

  res.render('jobs/schedule', {
    title: 'Schedule',
    currentUrl: req.originalUrl,
    view: isDay ? 'day' : 'week',
    capacityHours: 38,
    days,
    rows: visibleRows,
    weekLabel,
    prevStartIso: toIsoDate(prevStart),
    nextStartIso: toIsoDate(nextStart),
    monthIso: `${rangeStart.getFullYear()}-${String(rangeStart.getMonth() + 1).padStart(2, '0')}`,
    todayIso: brisbaneTodayIso(),
    isAdmin,
    summary: {
      shifts: totalShifts,
      hours: totalHours,
      users: activeUsers,
      labourCost: labourCost.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' }),
    },
  });
}

async function renderMonthView(req, res) {
  const todayIso = brisbaneTodayIso();
  let year = Number(todayIso.slice(0, 4));
  let month = Number(todayIso.slice(5, 7)) - 1;
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
    j.assigneeIds = (assigneesByJob[j.id] || []).map((a) => a.id);
    j.assigneeNames = (assigneesByJob[j.id] || []).map((a) => a.name).join(', ');
  });

  const isAdmin = req.user.role === 'admin';
  const visibleJobs = isAdmin ? jobs : jobs.filter((j) => j.assigneeIds.includes(req.user.id));

  const jobsByDay = {};
  visibleJobs.forEach((j) => {
    const day = j.scheduled_start.slice(0, 10);
    (jobsByDay[day] = jobsByDay[day] || []).push(j);
  });
  weeks.forEach((week) => week.forEach((day) => { day.jobs = jobsByDay[day.iso] || []; }));

  // Team leave - same visibility rule as the week/day grids: a non-admin
  // only sees their own row/schedule, so they only see their own leave here
  // too, not the whole team's.
  const leaveByUser = await getApprovedLeaveInRange(startIso, endIso);
  const leaveTechs = isAdmin
    ? await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all()
    : [{ id: req.user.id, name: req.user.name }];
  weeks.forEach((week) =>
    week.forEach((day) => {
      day.leave = leaveTechs
        .map((t) => {
          const hit = leaveOnDay(leaveByUser, t.id, day.iso);
          return hit ? { name: t.name, label: hit.label } : null;
        })
        .filter(Boolean);
    })
  );

  const prevMonth = new Date(year, month - 1, 1);
  const nextMonth = new Date(year, month + 1, 1);

  res.render('jobs/schedule-month', {
    title: 'Schedule',
    currentUrl: req.originalUrl,
    view: 'month',
    weeks,
    monthLabel: firstOfMonth.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
    monthIso: `${year}-${String(month + 1).padStart(2, '0')}`,
    prevMonthIso: `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`,
    nextMonthIso: `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`,
    todayIso,
    isAdmin,
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
  const todayIso = brisbaneTodayIso();
  const requestedDay = req.query.start ? new Date(`${req.query.start}T00:00:00`) : new Date(`${todayIso}T00:00:00`);
  const day = isNaN(requestedDay) ? new Date(`${todayIso}T00:00:00`) : requestedDay;
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
  const leaveByUser = await getApprovedLeaveInRange(dayIso, dayIso);

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
        leave: leaveOnDay(leaveByUser, t.id, dayIso),
        shiftCount: rowJobs.length,
        hoursLabel: formatHoursLabel(minutes),
        minutes,
        hourlyRate: t.hourly_rate,
        utilisationPct: Math.round((minutes / 60 / 8) * 100),
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

  const isAdmin = req.user.role === 'admin';
  const visibleRows = isAdmin ? rows : rows.filter((r) => r.id === req.user.id);
  const visibleDayJobs = isAdmin ? jobs : jobs.filter((j) => j.assigneeIds.includes(req.user.id));

  res.render('jobs/schedule-day', {
    title: 'Schedule',
    currentUrl: req.originalUrl,
    view: 'day',
    capacityHours: 8,
    axisStartHour: DAY_AXIS_START_HOUR,
    axisEndHour: DAY_AXIS_END_HOUR,
    dayIso,
    dayLabel: day.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    prevStartIso: toIsoDate(prevDay),
    nextStartIso: toIsoDate(nextDay),
    monthIso: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`,
    todayIso: brisbaneTodayIso(),
    hourMarks,
    rows: visibleRows,
    dayJobs: visibleDayJobs,
    isAdmin,
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
  requireAuth,
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

// 15/30/45 minutes, then half-hour increments from 1 hour up to 8 hours (480 minutes).
const DURATION_OPTIONS_MINUTES = new Set([15, 30, 45, ...Array.from({ length: 15 }, (_, i) => 60 + i * 30)]);

function parseDurationMinutes(raw) {
  const n = Number.parseInt(raw, 10);
  return DURATION_OPTIONS_MINUTES.has(n) ? n : null;
}

function buildSchedule(b) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : null;
  const allDay = b.all_day === 'on' || b.all_day === '1' || b.all_day === 'true';
  const duration_minutes = parseDurationMinutes(b.duration_minutes);

  if (!date) return { scheduled_start: null, scheduled_end: null, all_day: 0, duration_minutes };

  const defaultStart = allDay ? '07:00' : '09:00';
  const startTime = /^\d{2}:\d{2}$/.test(b.start_time || '') ? b.start_time : defaultStart;
  const endTime = /^\d{2}:\d{2}$/.test(b.end_time || '') ? b.end_time : allDay ? '15:00' : null;

  return {
    scheduled_start: `${date}T${startTime}`,
    scheduled_end: endTime ? `${date}T${endTime}` : null,
    all_day: allDay ? 1 : 0,
    duration_minutes,
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
    const before = await captureJobSnapshot(job.id);

    const newDate = req.body.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate || '')) return res.status(400).json({ error: 'Invalid date.' });

    // Optional - set by the day view's slide-to-reschedule drag, which moves
    // a job's time within the same day rather than to a different day/tech.
    const newTime = req.body.time;
    if (newTime !== undefined && !/^\d{2}:\d{2}$/.test(newTime)) return res.status(400).json({ error: 'Invalid time.' });

    // Resolve who the job's assignees will be *after* this move, whether or
    // not this particular drag also changed them, so a plain day-to-day drag
    // (assignee untouched) still gets checked against the new date.
    let newAssigneeIds = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'assignedTo')) {
      const raw = req.body.assignedTo;
      if (!raw) {
        newAssigneeIds = [];
      } else {
        const assignee = await db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(raw);
        if (!assignee) return res.status(400).json({ error: 'Invalid user.' });
        newAssigneeIds = [assignee.id];
      }
    }
    const effectiveAssigneeIds = newAssigneeIds !== null
      ? newAssigneeIds
      : (await db.prepare('SELECT user_id FROM job_assignees WHERE job_id = ?').all(job.id)).map((r) => r.user_id);

    const leaveConflict = await findAssigneeLeaveConflict(effectiveAssigneeIds, newDate);
    if (leaveConflict) {
      return res.status(400).json({ error: `${leaveConflict.name} is on ${leaveConflict.label} on ${newDate} and can't be scheduled that day.` });
    }

    if (newAssigneeIds !== null) await setAssignees(job.id, newAssigneeIds);

    const [y, m, d] = newDate.split('-').map(Number);
    const oldStart = new Date(job.scheduled_start);
    const newStart = new Date(oldStart);
    newStart.setFullYear(y, m - 1, d);
    if (newTime) {
      const [hh, mm] = newTime.split(':').map(Number);
      newStart.setHours(hh, mm, 0, 0);
    }

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

    const after = await captureJobSnapshot(job.id);
    await recordJobHistory(job.id, req.user.id, diffJobSnapshots(before, after));

    res.json({ ok: true });
  })
);

// ── Bulk delete ───────────────────────────────────────────────────────────────

router.post(
  '/bulk-delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const ids = []
      .concat(req.body.job_ids || [])
      .map((id) => Number.parseInt(id, 10))
      .filter(Number.isFinite);

    if (!ids.length) {
      setFlash(req, 'error', 'No jobs selected.');
      return res.redirect('/jobs');
    }

    if (await hasInvoices(ids)) {
      setFlash(req, 'error', "One or more selected jobs have an invoice raised against them and can't be deleted. Delete those invoices first.");
      return res.redirect('/jobs');
    }

    await deleteJobsCascade(ids);

    setFlash(req, 'success', `${ids.length} job${ids.length === 1 ? '' : 's'} deleted.`);
    res.redirect('/jobs');
  })
);

// ── Bulk unschedule ───────────────────────────────────────────────────────────

router.post(
  '/bulk-unschedule',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const ids = []
      .concat(req.body.job_ids || [])
      .map((id) => Number.parseInt(id, 10))
      .filter(Number.isFinite);

    if (!ids.length) {
      setFlash(req, 'error', 'No jobs selected.');
      return res.redirect('/jobs');
    }

    const before = {};
    for (const id of ids) before[id] = await captureJobSnapshot(id);

    const placeholders = ids.map(() => '?').join(',');
    await db
      .prepare(
        `UPDATE jobs SET status = 'unscheduled', scheduled_start = NULL, scheduled_end = NULL, updated_at = datetime('now') WHERE id IN (${placeholders})`
      )
      .run(...ids);
    await db.prepare(`DELETE FROM job_assignees WHERE job_id IN (${placeholders})`).run(...ids);

    for (const id of ids) {
      const after = await captureJobSnapshot(id);
      await recordJobHistory(id, req.user.id, diffJobSnapshots(before[id], after));
    }

    setFlash(req, 'success', `${ids.length} job${ids.length === 1 ? '' : 's'} reverted to unscheduled.`);
    res.redirect('/jobs');
  })
);

// ── Smart Scheduling ──────────────────────────────────────────────────────────

router.get(
  '/smart-schedule',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const config = require('../config');
    const hasApiKey = !!config.maps.apiKey;
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : nextMondayIso();
    res.render('jobs/smart-schedule', { title: 'Smart Schedule', weekStart, hasApiKey });
  })
);

// POST /jobs/smart-schedule/generate — geocode missing customers, run algorithm, return JSON
router.post(
  '/smart-schedule/generate',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(req.body.week || '') ? req.body.week : nextMondayIso();

    // Fetch all unscheduled jobs with their customer address + existing coords
    const jobs = await db
      .prepare(
        `SELECT jobs.id, jobs.title, jobs.description, jobs.duration_minutes,
                customers.id AS customer_id, customers.name AS customer_name,
                customers.address_street, customers.address_city,
                customers.address_state, customers.address_postcode,
                customers.lat, customers.lng
         FROM jobs
         JOIN customers ON customers.id = jobs.customer_id
         WHERE jobs.status = 'unscheduled'
         ORDER BY jobs.created_at ASC`
      )
      .all();

    // Geocode any customers that are missing coordinates (deduplicated by customer_id)
    const needsGeocode = [...new Map(
      jobs.filter((j) => j.lat == null || j.lng == null).map((j) => [j.customer_id, j])
    ).values()];

    for (const customer of needsGeocode) {
      const address = buildAddress(customer);
      if (!address.trim()) continue;
      const coords = await geocodeAddress(address);
      if (coords) {
        await db.prepare('UPDATE customers SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, customer.customer_id);
        // Update in-memory so the algorithm uses fresh coords this run
        jobs.filter((j) => j.customer_id === customer.customer_id).forEach((j) => {
          j.lat = coords.lat;
          j.lng = coords.lng;
        });
      }
    }

    const result = generateSchedule(jobs, weekStart);
    res.json({ ok: true, weekStart, ...result });
  })
);

// POST /jobs/smart-schedule/commit — assign a day's jobs to a date, each at
// its own algorithm-computed start/end time (not one flat block for the day)
router.post(
  '/smart-schedule/commit',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const { date, jobs } = req.body;
    const isTime = (t) => /^\d{2}:\d{2}$/.test(t || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Array.isArray(jobs) || !jobs.length || jobs.some((j) => !j.id || !isTime(j.startTime))) {
      return res.status(400).json({ ok: false, error: 'date and jobs (with id + startTime) required' });
    }
    for (const j of jobs) {
      const jobId = Number(j.id);
      const before = await captureJobSnapshot(jobId);
      const scheduledStart = `${date}T${j.startTime}:00`;
      const scheduledEnd = isTime(j.endTime) ? `${date}T${j.endTime}:00` : null;
      await db
        .prepare(`UPDATE jobs SET scheduled_start = ?, scheduled_end = ?, status = 'scheduled', updated_at = datetime('now') WHERE id = ? AND status = 'unscheduled'`)
        .run(scheduledStart, scheduledEnd, jobId);
      await db.prepare('DELETE FROM job_assignees WHERE job_id = ?').run(jobId);
      const after = await captureJobSnapshot(jobId);
      await recordJobHistory(jobId, req.user.id, diffJobSnapshots(before, after));
    }
    res.json({ ok: true, committed: jobs.length });
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
    const randomColor = JOB_COLORS[Math.floor(Math.random() * JOB_COLORS.length)].value;
    const techLeave = await loadTechLeaveMap();
    res.render('jobs/form', {
      title: 'New Job',
      job: { customer_id: preselectedCustomerId, date: preselectedDate, start_time: '', end_time: '', all_day: false, assigneeIds: [], color: randomColor, category: null },
      customers,
      techs,
      techLeave,
      STATUSES,
      colors: JOB_COLORS,
      categories: JOB_CATEGORIES,
      error: null,
      returnTo: safeReturnTo(req.query.returnTo),
    });
  })
);

// ── Aircon auto-stock allocation ─────────────────────────────────────────────

const AIRCON_JOB_PATTERN = /\baircon\s+(install(?:ation)?|replace(?:ment)?)\b/i;

// Each entry's `pattern` is matched with ILIKE so inventory names don't need
// to be exact - just distinctive enough to hit only the intended item.
const AIRCON_STOCK_BASE = [
  { code: 'NHPNL120S',   qty: 1 }, // W/P SWITCH IP66 2 POLE 20A 250VAC (isolator)
  { code: 'CBL1.5TEF',   qty: 3 }, // FLAT TWIN & EARTH 1.5MM
  { code: 'CBL1.5SDIRD', qty: 3 }, // SDI 1.5MM RED/WHITE 100M
  { code: 'A-AEWC80',    qty: 1 }, // AIRCON DUCT WALL CAP 80MM
  { code: 'A-AECD80',    qty: 1 }, // AIRCON DUCT STRAIGHT 2MTR 80MM
  { code: 'CDT9020MD',   qty: 1 }, // MD CONDUIT PVC RIGID 20MM GREY 4MTR
];

const AIRCON_STOCK_SMALL = [...AIRCON_STOCK_BASE, { code: 'A-APCB0609', qty: 3 }]; // PAIRCOIL 1/4IN-3/8IN
const AIRCON_STOCK_LARGE = [...AIRCON_STOCK_BASE, { code: 'A-APCB0612', qty: 3 }]; // PAIRCOIL 1/4IN-1/2IN

function isLargeAircon(title) {
  const m = title.match(/\b(\d+(?:\.\d+)?)\s*kw\b/i);
  return m ? parseFloat(m[1]) >= 5 : false;
}

async function autoAllocateAirconStock(jobId, jobTitle, allocatedBy) {
  if (!AIRCON_JOB_PATTERN.test(jobTitle)) return;
  const stockList = isLargeAircon(jobTitle) ? AIRCON_STOCK_LARGE : AIRCON_STOCK_SMALL;
  for (const { code, pattern, qty } of stockList) {
    const item = code
      ? await db.prepare('SELECT id FROM inventory_items WHERE supplier_code = ?').get(code)
      : await db.prepare("SELECT id FROM inventory_items WHERE name ILIKE '%' || ? || '%' LIMIT 1").get(pattern);
    if (!item) continue;
    await db.prepare('INSERT INTO job_stock_allocations (job_id, item_id, quantity, allocated_by) VALUES (?, ?, ?, ?)').run(jobId, item.id, qty, allocatedBy);
    await db.prepare('UPDATE inventory_items SET quantity_on_hand = GREATEST(quantity_on_hand - ?, 0), updated_at = now_utc_text() WHERE id = ?').run(qty, item.id);
  }
}

router.post(
  '/',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const b = req.body;
    const customers = await db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();
    const techs = await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    const assigneeIds = parseAssigneeIds(b);
    const returnTo = safeReturnTo(b.returnTo);

    if (!b.title || !b.title.trim() || !b.customer_id) {
      return res.status(400).render('jobs/form', {
        title: 'New Job',
        job: { ...b, assigneeIds },
        customers,
        techs,
        techLeave: await loadTechLeaveMap(),
        STATUSES,
        colors: JOB_COLORS,
        categories: JOB_CATEGORIES,
        error: 'Job title and customer are required.',
        returnTo,
      });
    }

    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id);
    const schedule = buildSchedule(b);
    const status = schedule.scheduled_start ? 'scheduled' : 'unscheduled';

    const leaveConflict = await findAssigneeLeaveConflict(assigneeIds, schedule.scheduled_start ? schedule.scheduled_start.slice(0, 10) : null);
    if (leaveConflict) {
      return res.status(400).render('jobs/form', {
        title: 'New Job',
        job: { ...b, assigneeIds },
        customers,
        techs,
        techLeave: await loadTechLeaveMap(),
        STATUSES,
        colors: JOB_COLORS,
        categories: JOB_CATEGORIES,
        error: `${leaveConflict.name} is on ${leaveConflict.label} that day and can't be assigned. Remove them or pick a different date.`,
        returnTo,
      });
    }

    const result = await db
      .prepare(
        `INSERT INTO jobs
          (customer_id, title, description, status, scheduled_start, scheduled_end, all_day, duration_minutes, color, category,
           site_address_street, site_address_city, site_address_state, site_address_postcode, notes, created_by)
         VALUES
          (@customer_id, @title, @description, @status, @scheduled_start, @scheduled_end, @all_day, @duration_minutes, @color, @category,
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
        duration_minutes: schedule.duration_minutes,
        color: parseJobColor(b.color),
        category: parseJobCategory(b.category),
        site_address_street: b.site_address_street || customer.address_street || null,
        site_address_city: b.site_address_city || customer.address_city || null,
        site_address_state: b.site_address_state || customer.address_state || null,
        site_address_postcode: b.site_address_postcode || customer.address_postcode || null,
        notes: b.notes || null,
        created_by: req.user.id,
      });

    await setAssignees(result.lastInsertRowid, assigneeIds);
    await autoAllocateAirconStock(result.lastInsertRowid, b.title.trim(), req.user.id);

    setFlash(req, 'success', `Job "${b.title.trim()}" created.`);
    res.redirect(withReturnTo(`/jobs/${result.lastInsertRowid}`, returnTo));
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
      // Lets the Add cost item form fill in Unit cost straight from an
      // employee's rate (set on their Employees tab profile) instead of
      // having to know/retype it.
      const employees = await db.prepare('SELECT id, name, hourly_rate FROM users WHERE active = 1 ORDER BY sort_order, name').all();
      costing = {
        quotedAmount,
        costItems,
        totalCost,
        profit: quotedAmount !== null ? quotedAmount - totalCost : null,
        categories: COST_CATEGORIES,
        employees,
      };
    }

    const inventoryItems = await db.prepare('SELECT id, name, supplier_code, unit, quantity_on_hand FROM inventory_items ORDER BY name ASC').all();
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

    let createdByName = null;
    let jobHistory = [];
    if (req.user.role === 'admin') {
      const historyData = await loadJobHistoryData(job.id);
      createdByName = historyData.createdByName;
      jobHistory = historyData.history;
    }

    res.render('jobs/show', {
      title: job.title,
      job,
      STATUSES,
      attachments,
      jobForms,
      costing,
      inventoryItems,
      stockAllocations,
      linkedAssets,
      createdByName,
      jobHistory,
      closeUrl: safeReturnTo(req.query.returnTo) || '/jobs',
    });
  })
);

// Backs the "History" item in the Jobs list's row ⋮ menu - a quick popup
// without leaving the list, fetched on demand rather than preloaded for
// every row.
router.get(
  '/:id/history',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const data = await loadJobHistoryData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Job not found.' });
    res.json(data);
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
    res.redirect(withReturnTo(`/jobs/${job.id}`, safeReturnTo(req.body.returnTo)));
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
    // Labour is self-explanatory (there's usually just a rate against it),
    // so it's the one category that doesn't force a typed description.
    const description = (req.body.description || '').trim() || (category === 'labour' ? 'Labour' : '');
    const quantity = Number.parseFloat(req.body.quantity);
    const unitCost = Number.parseFloat(req.body.unit_cost);

    if (!description || !Number.isFinite(quantity) || !Number.isFinite(unitCost)) {
      setFlash(req, 'error', 'Please provide a description, quantity, and cost.');
      return res.redirect(withReturnTo(`/jobs/${job.id}`, safeReturnTo(req.body.returnTo)));
    }

    await db
      .prepare(`INSERT INTO job_cost_items (job_id, category, description, quantity, unit_cost, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(job.id, category, description, quantity, unitCost, req.user.id);

    setFlash(req, 'success', 'Cost item added.');
    res.redirect(withReturnTo(`/jobs/${job.id}`, safeReturnTo(req.body.returnTo)));
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
    res.redirect(withReturnTo(`/jobs/${req.params.id}`, safeReturnTo(req.body.returnTo)));
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
    // Load the job's current customer even if they're inactive, so the field
    // is pre-filled when editing rather than appearing blank.
    const currentCustomer = job.customer_id
      ? (customers.find((c) => String(c.id) === String(job.customer_id)) ||
         await db.prepare('SELECT id, name FROM customers WHERE id = ?').get(job.customer_id))
      : null;
    res.render('jobs/form', {
      title: `Edit ${job.title}`,
      job: { ...job, ...deriveFormFields(job), assigneeIds: job.assignees.map((a) => a.id) },
      customers,
      currentCustomer,
      techs,
      techLeave: await loadTechLeaveMap(),
      STATUSES,
      colors: JOB_COLORS,
      categories: JOB_CATEGORIES,
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
    const before = await captureJobSnapshot(job.id);

    const b = req.body;
    const customers = await db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();
    const techs = await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY sort_order, name').all();
    const assigneeIds = parseAssigneeIds(b);
    const returnTo = safeReturnTo(b.returnTo);

    const currentCustomer = b.customer_id
      ? (customers.find((c) => String(c.id) === String(b.customer_id)) ||
         await db.prepare('SELECT id, name FROM customers WHERE id = ?').get(b.customer_id))
      : null;

    if (!b.title || !b.title.trim() || !b.customer_id) {
      return res.status(400).render('jobs/form', {
        title: `Edit ${job.title}`,
        job: { ...job, ...b, assigneeIds },
        customers,
        currentCustomer,
        techs,
        techLeave: await loadTechLeaveMap(),
        STATUSES,
        colors: JOB_COLORS,
        categories: JOB_CATEGORIES,
        error: 'Job title and customer are required.',
        returnTo,
      });
    }

    const schedule = buildSchedule(b);

    const leaveConflict = await findAssigneeLeaveConflict(assigneeIds, schedule.scheduled_start ? schedule.scheduled_start.slice(0, 10) : null);
    if (leaveConflict) {
      return res.status(400).render('jobs/form', {
        title: `Edit ${job.title}`,
        job: { ...job, ...b, assigneeIds },
        customers,
        currentCustomer,
        techs,
        techLeave: await loadTechLeaveMap(),
        STATUSES,
        colors: JOB_COLORS,
        categories: JOB_CATEGORIES,
        error: `${leaveConflict.name} is on ${leaveConflict.label} that day and can't be assigned. Remove them or pick a different date.`,
        returnTo,
      });
    }

    // A cleared date always wins over a stale "scheduled" status left over
    // from before - otherwise ticking Unscheduled without also touching the
    // status dropdown would silently leave the job looking scheduled with
    // no date. Explicit terminal statuses (completed/cancelled) still apply
    // even without a date - a job can be cancelled before it's ever scheduled.
    let newStatus = b.status || job.status;
    if (!schedule.scheduled_start && newStatus === 'scheduled') newStatus = 'unscheduled';

    if (jobIsDone(newStatus) && !jobIsDone(job.status)) {
      const err = await checkCompletionRequirements(job.id);
      if (err) {
        setFlash(req, 'error', err);
        return res.redirect(withReturnTo(`/jobs/${job.id}/edit`, returnTo));
      }
    }

    await db
      .prepare(
        `UPDATE jobs SET
           customer_id = @customer_id, title = @title, description = @description, status = @status,
           scheduled_start = @scheduled_start, scheduled_end = @scheduled_end, all_day = @all_day,
           duration_minutes = @duration_minutes, color = @color, category = @category,
           site_address_street = @site_address_street, site_address_city = @site_address_city,
           site_address_state = @site_address_state, site_address_postcode = @site_address_postcode,
           notes = @notes,
           completed_at = CASE WHEN @status IN ('completed', 'invoiced') AND completed_at IS NULL THEN datetime('now') ELSE completed_at END,
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
        duration_minutes: schedule.duration_minutes,
        color: parseJobColor(b.color),
        category: parseJobCategory(b.category),
        site_address_street: b.site_address_street || null,
        site_address_city: b.site_address_city || null,
        site_address_state: b.site_address_state || null,
        site_address_postcode: b.site_address_postcode || null,
        notes: b.notes || null,
      });

    await setAssignees(job.id, assigneeIds);

    // Schedule follow-up emails when a job is first marked done (completed,
    // or invoiced if that status is set directly without passing through
    // completed first)
    if (jobIsDone(newStatus) && !jobIsDone(job.status)) {
      const customer = await db.prepare('SELECT email FROM customers WHERE id = ?').get(b.customer_id);
      if (customer && customer.email) {
        const addMonths = (n) => {
          const d = new Date();
          d.setMonth(d.getMonth() + n);
          return d.toISOString();
        };
        await db.prepare(`INSERT INTO job_followups (job_id, customer_id, follow_up_type, scheduled_at) VALUES (?, ?, '6month', ?)`).run(job.id, b.customer_id, addMonths(6));
        await db.prepare(`INSERT INTO job_followups (job_id, customer_id, follow_up_type, scheduled_at) VALUES (?, ?, '12month', ?)`).run(job.id, b.customer_id, addMonths(12));
      }
    }

    const after = await captureJobSnapshot(job.id);
    await recordJobHistory(job.id, req.user.id, diffJobSnapshots(before, after));

    setFlash(req, 'success', 'Job updated.');
    res.redirect(returnTo || `/jobs/${job.id}`);
  })
);

router.post(
  '/:id/actual-start',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;
    const before = await captureJobSnapshot(job.id);
    const toIso = (v) => { if (!v || !v.trim()) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
    const actualStart = toIso(req.body.actual_start);
    await db.prepare(`UPDATE jobs SET actual_start = @actualStart, updated_at = datetime('now') WHERE id = @id`).run({ id: job.id, actualStart });
    const after = await captureJobSnapshot(job.id);
    await recordJobHistory(job.id, req.user.id, diffJobSnapshots(before, after));
    setFlash(req, 'success', 'Start time saved.');
    res.redirect(withReturnTo(`/jobs/${job.id}`, safeReturnTo(req.body.returnTo)));
  })
);

router.post(
  '/:id/actual-end',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;
    const before = await captureJobSnapshot(job.id);
    const toIso = (v) => { if (!v || !v.trim()) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
    const actualEnd = toIso(req.body.actual_end);
    await db.prepare(`UPDATE jobs SET actual_end = @actualEnd, updated_at = datetime('now') WHERE id = @id`).run({ id: job.id, actualEnd });
    const after = await captureJobSnapshot(job.id);
    await recordJobHistory(job.id, req.user.id, diffJobSnapshots(before, after));
    setFlash(req, 'success', 'Finish time saved.');
    res.redirect(withReturnTo(`/jobs/${job.id}`, safeReturnTo(req.body.returnTo)));
  })
);

router.post(
  '/:id/status',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;

    const status = req.body.status;
    const returnTo = safeReturnTo(req.body.returnTo);
    if (!STATUSES.includes(status)) {
      return res.status(400).render('error', { message: 'Invalid status.' });
    }

    if (jobIsDone(status) && !jobIsDone(job.status)) {
      const err = await checkCompletionRequirements(job.id);
      if (err) {
        setFlash(req, 'error', err);
        return res.redirect(withReturnTo(`/jobs/${job.id}`, returnTo));
      }
    }

    const before = await captureJobSnapshot(job.id);

    await db
      .prepare(
        `UPDATE jobs SET status = @status,
           completed_at = CASE WHEN @status IN ('completed', 'invoiced') AND completed_at IS NULL THEN datetime('now') ELSE completed_at END,
           updated_at = datetime('now')
         WHERE id = @id`
      )
      .run({ id: job.id, status });

    const after = await captureJobSnapshot(job.id);
    await recordJobHistory(job.id, req.user.id, diffJobSnapshots(before, after));

    setFlash(req, 'success', `Job marked ${status.replace('_', ' ')}.`);
    res.redirect(returnTo || `/jobs/${job.id}`);
  })
);

router.post(
  '/:id/na-flags',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await getJobOr404(req, res);
    if (!job) return;
    const before = await captureJobSnapshot(job.id);
    await db
      .prepare(`UPDATE jobs SET photos_na = ?, stock_na = ?, updated_at = now_utc_text() WHERE id = ?`)
      .run(req.body.photos_na === '1' ? 1 : 0, req.body.stock_na === '1' ? 1 : 0, job.id);
    const after = await captureJobSnapshot(job.id);
    await recordJobHistory(job.id, req.user.id, diffJobSnapshots(before, after));
    res.redirect(withReturnTo(`/jobs/${job.id}`, safeReturnTo(req.body.returnTo)));
  })
);

router.post(
  '/:id/unassign',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const before = await captureJobSnapshot(job.id);
    await setAssignees(job.id, []);
    const after = await captureJobSnapshot(job.id);
    await recordJobHistory(job.id, req.user.id, diffJobSnapshots(before, after));
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
          (customer_id, title, description, status, scheduled_start, scheduled_end, all_day, duration_minutes, color, category,
           site_address_street, site_address_city, site_address_state, site_address_postcode, notes, created_by)
         VALUES
          (@customer_id, @title, @description, @status, @scheduled_start, @scheduled_end, @all_day, @duration_minutes, @color, @category,
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
        duration_minutes: job.duration_minutes,
        color: job.color,
        category: job.category,
        site_address_street: job.site_address_street,
        site_address_city: job.site_address_city,
        site_address_state: job.site_address_state,
        site_address_postcode: job.site_address_postcode,
        notes: job.notes,
        created_by: req.user.id,
      });

    await setAssignees(result.lastInsertRowid, []);
    await autoAllocateAirconStock(result.lastInsertRowid, job.title, req.user.id);

    setFlash(req, 'success', 'Job duplicated into Unassigned shifts.');
    res.redirect(safeReturnTo(req.body.returnTo) || homeRoute(req.user));
  })
);

router.post(
  '/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const job = await db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).render('error', { message: 'Job not found.' });

    if (await hasInvoices([job.id])) {
      setFlash(req, 'error', `"${job.title}" has an invoice raised against it and can't be deleted. Delete the invoice first.`);
      return res.redirect(withReturnTo(`/jobs/${job.id}`, safeReturnTo(req.body.returnTo)));
    }

    await deleteJobsCascade([job.id]);

    setFlash(req, 'success', `Job "${job.title}" deleted.`);
    res.redirect(safeReturnTo(req.body.returnTo) || '/jobs');
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
    res.redirect(withReturnTo(`/jobs/${req.job.id}`, safeReturnTo(req.body.returnTo)));
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
    res.redirect(withReturnTo(`/jobs/${req.job.id}`, safeReturnTo(req.body.returnTo)));
  })
);

module.exports = router;
