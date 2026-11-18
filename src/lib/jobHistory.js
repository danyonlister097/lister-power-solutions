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
//
// Pass `merge` to fold repeat events into the same history row instead of
// flooding it with near-duplicates. Two real cases need this: a tech
// uploading a dozen photos (the browser compresses and POSTs them one at a
// time, each its own request, for per-file progress/retry - so the usual
// "log once per request" already in the attachments route still logs once
// per photo), and allocating several stock items within a couple of
// minutes. If this same user's most recent history row on this job with
// the same merge.key is still within merge.windowMinutes, it's updated in
// place (bumping its timestamp, and its count via merge.countBy/label if
// given) instead of a new row being inserted; otherwise a fresh row is
// inserted, carrying the merge key forward for the next call to find.
//   merge.key            - identifies what's being merged, e.g. "photos:before:added"
//   merge.windowMinutes  - how long a row stays open to merge into (default 3)
//   merge.countBy        - how much to add to the row's running count, if any
//   merge.label(count)   - regenerates the row's `to` text from the new count
async function logJobEvent(jobId, userId, field, detail, merge) {
  if (merge) {
    const windowMinutes = merge.windowMinutes || 3;
    const recentRows = await db
      .prepare(
        `SELECT * FROM job_history
         WHERE job_id = ? AND user_id = ?
           AND created_at >= to_char((now() AT TIME ZONE 'UTC') - (? || ' minutes')::interval, 'YYYY-MM-DD HH24:MI:SS')
         ORDER BY created_at DESC`
      )
      .all(jobId, userId, windowMinutes);
    const match = recentRows.find((row) => {
      const changes = JSON.parse(row.changes);
      return changes.length === 1 && changes[0].mergeKey === merge.key;
    });
    if (match) {
      const changes = JSON.parse(match.changes);
      if (merge.countBy) {
        changes[0].count = (changes[0].count || 1) + merge.countBy;
        changes[0].to = merge.label(changes[0].count);
      }
      await db.prepare("UPDATE job_history SET changes = ?, created_at = datetime('now') WHERE id = ?").run(JSON.stringify(changes), match.id);
      return;
    }
  }

  const entry = { field, to: detail };
  if (merge) {
    entry.mergeKey = merge.key;
    if (merge.countBy) entry.count = merge.countBy;
  }
  await recordJobHistory(jobId, userId, [entry]);
}

module.exports = { recordJobHistory, logJobEvent };
