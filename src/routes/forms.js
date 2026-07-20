const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { uploadForm, UPLOAD_DIR } = require('../lib/formUploads');
const { setFlash } = require('../lib/flash');

const router = express.Router();

function uploadTemplateFile(req, res, next) {
  uploadForm.single('file')(req, res, (err) => {
    if (err) {
      setFlash(req, 'error', err.message || 'Upload failed.');
      return res.redirect('/forms');
    }
    next();
  });
}

function uploadCompletedFile(req, res, next) {
  uploadForm.single('file')(req, res, (err) => {
    if (err) {
      setFlash(req, 'error', err.message || 'Upload failed.');
      const jobForm = db.prepare('SELECT job_id, id FROM job_forms WHERE id = ?').get(req.params.id);
      return res.redirect(jobForm ? (jobForm.job_id ? `/jobs/${jobForm.job_id}` : `/forms/job/${jobForm.id}`) : '/forms');
    }
    next();
  });
}

router.get('/', (req, res) => {
  const templates = db
    .prepare(
      `SELECT form_templates.*,
         (SELECT COUNT(*) FROM job_forms WHERE job_forms.template_id = form_templates.id AND job_forms.job_id IS NOT NULL) AS use_count
       FROM form_templates
       ORDER BY form_templates.name ASC`
    )
    .all();

  const forJob = req.query.forJob ? db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.query.forJob) : null;

  // Drafts created via the "+" on a template card before they're assigned
  // to a job - only relevant when browsing the general library, not the
  // "pick a form for this job" flow.
  const drafts = forJob
    ? []
    : db
        .prepare(
          `SELECT job_forms.*, users.name AS created_by_name
           FROM job_forms
           JOIN users ON users.id = job_forms.created_by
           WHERE job_forms.job_id IS NULL
           ORDER BY job_forms.created_at DESC`
        )
        .all();

  res.render('forms/index', { title: 'Forms & Certificates', templates, forJob, drafts });
});

router.post('/', requireRole('admin'), uploadTemplateFile, verifyCsrf, (req, res) => {
  const name = (req.body.name || '').trim();
  const file = req.file;

  if (!name || !file) {
    if (file) fs.unlink(path.join(UPLOAD_DIR, file.filename), () => {});
    setFlash(req, 'error', 'Template name and file are required.');
    return res.redirect('/forms');
  }

  db.prepare(
    `INSERT INTO form_templates (name, filename, original_name, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name, file.filename, file.originalname, file.mimetype, file.size, req.user.id);

  setFlash(req, 'success', `Template "${name}" uploaded.`);
  res.redirect('/forms');
});

router.get('/:id', (req, res) => {
  const template = db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).render('error', { message: 'Template not found.' });

  const jobs = db
    .prepare(
      `SELECT jobs.id, jobs.title, customers.name AS customer_name
       FROM jobs JOIN customers ON customers.id = jobs.customer_id
       WHERE jobs.status NOT IN ('completed', 'cancelled')
       ORDER BY jobs.created_at DESC`
    )
    .all();

  const history = db
    .prepare(
      `SELECT job_forms.*, jobs.title AS job_title, users.name AS created_by_name
       FROM job_forms
       JOIN jobs ON jobs.id = job_forms.job_id
       JOIN users ON users.id = job_forms.created_by
       WHERE job_forms.template_id = ?
       ORDER BY job_forms.created_at DESC`
    )
    .all(template.id);

  res.render('forms/show', { title: template.name, template, jobs, history, error: null });
});

router.get('/:id/download', (req, res) => {
  const template = db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).render('error', { message: 'Template not found.' });

  res.type(template.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${template.original_name}"`);
  res.sendFile(path.join(UPLOAD_DIR, template.filename));
});

// Duplicating a template with a job_id attaches it straight to that job
// (the "+ Add form" flow from a job page already knows which job). Without
// one, it's created as an unassigned draft - the user picks a job later,
// when they save it, from its own page. Either way, land on the new form's
// own page next so it can be filled out/completed before returning to the
// job, rather than dumping the user straight back on the job page.
router.post('/:id/duplicate', verifyCsrf, (req, res) => {
  const template = db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).render('error', { message: 'Template not found.' });

  let job = null;
  if (req.body.job_id) {
    job = db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.body.job_id);
    if (!job) {
      setFlash(req, 'error', 'Please choose a valid job.');
      return res.redirect('/forms');
    }
  }

  const ext = path.extname(template.filename);
  const newFilename = `${crypto.randomUUID()}${ext}`;
  fs.copyFileSync(path.join(UPLOAD_DIR, template.filename), path.join(UPLOAD_DIR, newFilename));

  const result = db
    .prepare(
      `INSERT INTO job_forms (job_id, template_id, name, filename, mime_type, size_bytes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(job ? job.id : null, template.id, template.name, newFilename, template.mime_type, template.size_bytes, req.user.id);

  setFlash(
    req,
    'success',
    job ? `"${template.name}" added to ${job.title}. Fill it out and save when done.` : `"${template.name}" created. Assign it to a job when you save it.`
  );
  res.redirect(`/forms/job/${result.lastInsertRowid}`);
});

router.post('/:id/delete', requireRole('admin'), verifyCsrf, (req, res) => {
  const template = db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).render('error', { message: 'Template not found.' });

  db.prepare('UPDATE job_forms SET template_id = NULL WHERE template_id = ?').run(template.id);
  fs.unlink(path.join(UPLOAD_DIR, template.filename), () => {});
  db.prepare('DELETE FROM form_templates WHERE id = ?').run(template.id);

  setFlash(req, 'success', `Template "${template.name}" deleted. Copies already created for jobs are unaffected.`);
  res.redirect('/forms');
});

router.get('/job/:id', (req, res) => {
  const jobForm = db
    .prepare(
      `SELECT job_forms.*, jobs.title AS job_title
       FROM job_forms LEFT JOIN jobs ON jobs.id = job_forms.job_id
       WHERE job_forms.id = ?`
    )
    .get(req.params.id);
  if (!jobForm) return res.status(404).render('error', { message: 'Form not found.' });

  const jobs = jobForm.job_id
    ? []
    : db
        .prepare(
          `SELECT jobs.id, jobs.title, customers.name AS customer_name
           FROM jobs JOIN customers ON customers.id = jobs.customer_id
           WHERE jobs.status NOT IN ('completed', 'cancelled')
           ORDER BY jobs.created_at DESC`
        )
        .all();

  res.render('forms/job-form', { title: jobForm.name, jobForm, jobs, error: null });
});

router.get('/job/:id/download', (req, res) => {
  const jobForm = db.prepare('SELECT * FROM job_forms WHERE id = ?').get(req.params.id);
  if (!jobForm) return res.status(404).render('error', { message: 'Form not found.' });

  res.type(jobForm.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${jobForm.name}"`);
  res.sendFile(path.join(UPLOAD_DIR, jobForm.filename));
});

// Doubles as the "save" action for a draft form: uploading a completed file
// and/or assigning it to a job (only meaningful the first time - once a
// draft has a job it behaves like any other job form).
router.post('/job/:id/upload', uploadCompletedFile, verifyCsrf, (req, res) => {
  const jobForm = db.prepare('SELECT * FROM job_forms WHERE id = ?').get(req.params.id);
  if (!jobForm) return res.status(404).render('error', { message: 'Form not found.' });

  const file = req.file;
  let job = null;
  if (!jobForm.job_id && req.body.job_id) {
    job = db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.body.job_id);
    if (!job) {
      setFlash(req, 'error', 'Please choose a valid job.');
      return res.redirect(`/forms/job/${jobForm.id}`);
    }
  }

  if (!file && !job) {
    setFlash(req, 'error', jobForm.job_id ? 'No file selected.' : 'Upload a file and/or assign this form to a job.');
    return res.redirect(jobForm.job_id ? `/jobs/${jobForm.job_id}` : `/forms/job/${jobForm.id}`);
  }

  if (file) {
    fs.unlink(path.join(UPLOAD_DIR, jobForm.filename), () => {});
  }

  db.prepare(
    `UPDATE job_forms SET
       filename = COALESCE(?, filename), mime_type = COALESCE(?, mime_type), size_bytes = COALESCE(?, size_bytes),
       completed = CASE WHEN ? THEN 1 ELSE completed END,
       job_id = COALESCE(?, job_id),
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    file ? file.filename : null,
    file ? file.mimetype : null,
    file ? file.size : null,
    file ? 1 : 0,
    job ? job.id : null,
    jobForm.id
  );

  const finalJobId = job ? job.id : jobForm.job_id;
  setFlash(req, 'success', `"${jobForm.name}" updated.`);
  res.redirect(finalJobId ? `/jobs/${finalJobId}` : `/forms/job/${jobForm.id}`);
});

router.post('/job/:id/delete', verifyCsrf, (req, res) => {
  const jobForm = db.prepare('SELECT * FROM job_forms WHERE id = ?').get(req.params.id);
  if (!jobForm) return res.status(404).render('error', { message: 'Form not found.' });

  fs.unlink(path.join(UPLOAD_DIR, jobForm.filename), () => {});
  db.prepare('DELETE FROM job_forms WHERE id = ?').run(jobForm.id);

  setFlash(req, 'success', 'Form removed.');
  res.redirect(jobForm.job_id ? `/jobs/${jobForm.job_id}` : '/forms');
});

module.exports = router;
