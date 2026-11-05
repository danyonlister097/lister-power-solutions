const db = require('../db');

// Shared by every route that touches a job (jobs.js, inventory.js, forms.js)
// so photo/stock/costing/form actions all land in the same job_history table
// the job page's admin-only History card reads - not just the field-level
// edits jobs.js diffs itself via captureJobSnapshot/diffJobSnapshots.
async function recordJobHistory(jobId, userId, changes) {
  if (!changes || !changes.length) return;
  await db.prepare('INSERT INTO job_history (job_id, user_id, changes) VALUES (?, ?, ?)').run(jobId, userId || null, JSON.stringify(changes));
}

// One-line event (a photo uploaded, stock allocated, a form attached) rather
// than a before/after field edit - stored with no `from` key so the History
// view renders it as "field: detail" instead of "field: (none) -> detail".
async function logJobEvent(jobId, userId, field, detail) {
  await recordJobHistory(jobId, userId, [{ field, to: detail }]);
}

module.exports = { recordJobHistory, logJobEvent };
