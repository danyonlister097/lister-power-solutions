const { Readable } = require('stream');
const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { uploadForm, putFile, copyFile, fetchFile, deleteFile } = require('../lib/formUploads');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

// Drag-and-drop uploads and moves are fetch() calls that want JSON back
// rather than a redirect to a re-rendered page.
const acceptsJson = (req) => (req.get('Accept') || '').includes('application/json');

// '' / missing means "no section"; anything else must be a real section id.
async function parseCategoryId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { id: null };
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id)) return { error: 'Unknown section.' };
  const row = await db.prepare('SELECT id FROM form_categories WHERE id = ?').get(id);
  return row ? { id: row.id } : { error: 'Unknown section.' };
}

function uploadTemplateFile(req, res, next) {
  uploadForm.single('file')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is over the 20MB limit.' : err.message || 'Upload failed.';
      if (acceptsJson(req)) return res.status(400).json({ error: message });
      setFlash(req, 'error', message);
      return res.redirect('/forms');
    }
    next();
  });
}

function uploadCompletedFile(req, res, next) {
  uploadForm.single('file')(req, res, async (err) => {
    if (err) {
      try {
        setFlash(req, 'error', err.message || 'Upload failed.');
        const jobForm = await db.prepare('SELECT job_id, id FROM job_forms WHERE id = ?').get(req.params.id);
        return res.redirect(jobForm ? (jobForm.job_id ? `/jobs/${jobForm.job_id}` : `/forms/job/${jobForm.id}`) : '/forms');
      } catch (dbErr) {
        return next(dbErr);
      }
    }
    next();
  });
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const templates = await db
      .prepare(
        `SELECT form_templates.*,
           (SELECT COUNT(*) FROM job_forms WHERE job_forms.template_id = form_templates.id AND job_forms.job_id IS NOT NULL) AS use_count
         FROM form_templates
         ORDER BY form_templates.name ASC`
      )
      .all();

    const forJob = req.query.forJob ? await db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.query.forJob) : null;

    // Drafts created via the "+" on a template card before they're assigned
    // to a job - only relevant when browsing the general library, not the
    // "pick a form for this job" flow.
    const drafts = forJob
      ? []
      : await db
          .prepare(
            `SELECT job_forms.*, users.name AS created_by_name
             FROM job_forms
             JOIN users ON users.id = job_forms.created_by
             WHERE job_forms.job_id IS NULL
             ORDER BY job_forms.created_at DESC`
          )
          .all();

    const categories = await db.prepare('SELECT id, label FROM form_categories ORDER BY sort_order, label').all();

    res.render('forms/index', { title: 'Forms & Certificates', templates, categories, forJob, drafts });
  })
);

router.post(
  '/',
  requireRole('admin'),
  uploadTemplateFile,
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const json = acceptsJson(req);
    const fail = (message) => {
      if (json) return res.status(400).json({ error: message });
      setFlash(req, 'error', message);
      return res.redirect('/forms');
    };

    const name = (req.body.name || '').trim().slice(0, 120);
    const file = req.file;
    if (!name || !file) return fail('Template name and file are required.');

    const category = await parseCategoryId(req.body.category_id);
    if (category.error) return fail(category.error);

    const url = await putFile(file);

    const result = await db
      .prepare(
        `INSERT INTO form_templates (name, filename, original_name, mime_type, size_bytes, uploaded_by, category_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .run(name, url, file.originalname, file.mimetype, file.size, req.user.id, category.id);

    if (json) return res.json({ ok: true, id: result.lastInsertRowid, name });
    setFlash(req, 'success', `Template "${name}" uploaded.`);
    res.redirect('/forms');
  })
);

// Sections are registered before the /:id routes below so "categories"
// isn't swallowed as an :id value.
router.post(
  '/categories',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const label = (req.body.label || '').trim().slice(0, 60);
    if (!label) {
      setFlash(req, 'error', 'Enter a section name.');
      return res.redirect('/forms');
    }

    // The table's UNIQUE is case-sensitive, which would let "swms" sit
    // beside "SWMS" - check ignoring case first, keep the constraint as the
    // backstop for two admins adding the same name at once.
    const existing = await db.prepare('SELECT id FROM form_categories WHERE LOWER(label) = LOWER(?)').get(label);
    if (existing) {
      setFlash(req, 'error', 'A section with that name already exists.');
      return res.redirect('/forms');
    }

    try {
      const row = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM form_categories').get();
      await db.prepare('INSERT INTO form_categories (label, sort_order) VALUES (?, ?)').run(label, Number(row.m) + 10);
      setFlash(req, 'success', `Section "${label}" added.`);
    } catch (err) {
      if (err.code === '23505') {
        setFlash(req, 'error', 'A section with that name already exists.');
      } else {
        throw err;
      }
    }
    res.redirect('/forms');
  })
);

router.post(
  '/categories/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const category = Number.isInteger(Number(req.params.id))
      ? await db.prepare('SELECT id, label FROM form_categories WHERE id = ?').get(req.params.id)
      : null;
    if (!category) {
      setFlash(req, 'error', 'Section not found.');
      return res.redirect('/forms');
    }

    // Its templates aren't deleted - the column's ON DELETE SET NULL drops
    // them back to "Uncategorised".
    await db.prepare('DELETE FROM form_categories WHERE id = ?').run(category.id);
    setFlash(req, 'success', `Section "${category.label}" deleted. Its templates are now uncategorised.`);
    res.redirect('/forms');
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = await db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
    if (!template) return res.status(404).render('error', { message: 'Template not found.' });

    const jobs = await db
      .prepare(
        `SELECT jobs.id, jobs.title, customers.name AS customer_name
         FROM jobs JOIN customers ON customers.id = jobs.customer_id
         WHERE jobs.status NOT IN ('completed', 'cancelled')
         ORDER BY jobs.created_at DESC`
      )
      .all();

    const history = await db
      .prepare(
        `SELECT job_forms.*, jobs.title AS job_title, users.name AS created_by_name
         FROM job_forms
         JOIN jobs ON jobs.id = job_forms.job_id
         JOIN users ON users.id = job_forms.created_by
         WHERE job_forms.template_id = ?
         ORDER BY job_forms.created_at DESC`
      )
      .all(template.id);

    const categories = await db.prepare('SELECT id, label FROM form_categories ORDER BY sort_order, label').all();

    res.render('forms/show', { title: template.name, template, categories, jobs, history, error: null });
  })
);

// Rename a template and/or move it to another section. Each field is only
// touched if the request actually includes it, so dragging a card between
// sections (category only) can't blank its name, and vice versa.
router.post(
  '/:id/update',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const json = acceptsJson(req);
    const template = Number.isInteger(Number(req.params.id))
      ? await db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id)
      : null;
    if (!template) {
      if (json) return res.status(404).json({ error: 'Template not found.' });
      return res.status(404).render('error', { message: 'Template not found.' });
    }

    const fail = (message) => {
      if (json) return res.status(400).json({ error: message });
      setFlash(req, 'error', message);
      return res.redirect(`/forms/${template.id}`);
    };

    let name = template.name;
    if (req.body.name !== undefined) {
      name = String(req.body.name).trim().slice(0, 120);
      if (!name) return fail('Template name cannot be blank.');
    }

    let categoryId = template.category_id;
    if (Object.prototype.hasOwnProperty.call(req.body, 'category_id')) {
      const category = await parseCategoryId(req.body.category_id);
      if (category.error) return fail(category.error);
      categoryId = category.id;
    }

    await db.prepare('UPDATE form_templates SET name = ?, category_id = ? WHERE id = ?').run(name, categoryId, template.id);

    if (json) return res.json({ ok: true });
    setFlash(req, 'success', 'Template updated.');
    res.redirect(`/forms/${template.id}`);
  })
);

router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const template = await db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
    if (!template) return res.status(404).render('error', { message: 'Template not found.' });

    const stream = await fetchFile(template.filename);
    if (!stream) return res.status(404).render('error', { message: 'File not found.' });
    res.type(template.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${template.original_name}"`);
    Readable.fromWeb(stream).pipe(res);
  })
);

// Duplicating a template with a job_id attaches it straight to that job -
// the "+ Add form" flow from a job page already knows which job, so it goes
// straight back there where the new form is now listed, ready to open and
// fill in. Without a job_id (browsing the general template library), it's
// created as an unassigned draft and lands on the new form's own page
// instead, since there's no job page yet to return to.
router.post(
  '/:id/duplicate',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const wantsJson = req.get('Accept') === 'application/json';
    const template = await db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
    if (!template) {
      if (wantsJson) return res.status(404).json({ error: 'Template not found.' });
      return res.status(404).render('error', { message: 'Template not found.' });
    }

    let job = null;
    if (req.body.job_id) {
      job = await db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.body.job_id);
      if (!job) {
        if (wantsJson) return res.status(400).json({ error: 'Please choose a valid job.' });
        setFlash(req, 'error', 'Please choose a valid job.');
        return res.redirect('/forms');
      }
    }

    const newUrl = await copyFile(template.filename, template.original_name);

    const result = await db
      .prepare(
        `INSERT INTO job_forms (job_id, template_id, name, filename, mime_type, size_bytes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .run(job ? job.id : null, template.id, template.name, newUrl, template.mime_type, template.size_bytes, req.user.id);

    setFlash(
      req,
      'success',
      job ? `"${template.name}" added to ${job.title}. Open it to fill in, then upload the completed version.` : `"${template.name}" created. Assign it to a job when you save it.`
    );

    const redirectUrl = job ? `/jobs/${job.id}` : `/forms/job/${result.lastInsertRowid}`;
    if (wantsJson) {
      return res.json({ ok: true, formId: result.lastInsertRowid, downloadUrl: `/forms/job/${result.lastInsertRowid}/download`, redirectUrl });
    }
    res.redirect(redirectUrl);
  })
);

router.post(
  '/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const template = await db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
    if (!template) return res.status(404).render('error', { message: 'Template not found.' });

    await db.prepare('UPDATE job_forms SET template_id = NULL WHERE template_id = ?').run(template.id);
    await deleteFile(template.filename);
    await db.prepare('DELETE FROM form_templates WHERE id = ?').run(template.id);

    setFlash(req, 'success', `Template "${template.name}" deleted. Copies already created for jobs are unaffected.`);
    res.redirect('/forms');
  })
);

router.get(
  '/job/:id',
  asyncHandler(async (req, res) => {
    const jobForm = await db
      .prepare(
        `SELECT job_forms.*, jobs.title AS job_title
         FROM job_forms LEFT JOIN jobs ON jobs.id = job_forms.job_id
         WHERE job_forms.id = ?`
      )
      .get(req.params.id);
    if (!jobForm) return res.status(404).render('error', { message: 'Form not found.' });

    const jobs = jobForm.job_id
      ? []
      : await db
          .prepare(
            `SELECT jobs.id, jobs.title, customers.name AS customer_name
             FROM jobs JOIN customers ON customers.id = jobs.customer_id
             WHERE jobs.status NOT IN ('completed', 'cancelled')
             ORDER BY jobs.created_at DESC`
          )
          .all();

    res.render('forms/job-form', { title: jobForm.name, jobForm, jobs, error: null });
  })
);

router.get(
  '/job/:id/download',
  asyncHandler(async (req, res) => {
    const jobForm = await db.prepare('SELECT * FROM job_forms WHERE id = ?').get(req.params.id);
    if (!jobForm) return res.status(404).render('error', { message: 'Form not found.' });

    const stream = await fetchFile(jobForm.filename);
    if (!stream) return res.status(404).render('error', { message: 'File not found.' });
    res.type(jobForm.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${jobForm.name}"`);
    Readable.fromWeb(stream).pipe(res);
  })
);

// Doubles as the "save" action for a draft form: uploading a completed file
// and/or assigning it to a job (only meaningful the first time - once a
// draft has a job it behaves like any other job form).
router.post(
  '/job/:id/upload',
  uploadCompletedFile,
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const jobForm = await db.prepare('SELECT * FROM job_forms WHERE id = ?').get(req.params.id);
    if (!jobForm) return res.status(404).render('error', { message: 'Form not found.' });

    const file = req.file;
    let job = null;
    if (!jobForm.job_id && req.body.job_id) {
      job = await db.prepare('SELECT id, title FROM jobs WHERE id = ?').get(req.body.job_id);
      if (!job) {
        setFlash(req, 'error', 'Please choose a valid job.');
        return res.redirect(`/forms/job/${jobForm.id}`);
      }
    }

    if (!file && !job) {
      setFlash(req, 'error', jobForm.job_id ? 'No file selected.' : 'Upload a file and/or assign this form to a job.');
      return res.redirect(jobForm.job_id ? `/jobs/${jobForm.job_id}` : `/forms/job/${jobForm.id}`);
    }

    let newUrl = null;
    if (file) {
      newUrl = await putFile(file);
      await deleteFile(jobForm.filename);
    }

    await db
      .prepare(
        `UPDATE job_forms SET
           filename = COALESCE(?, filename), mime_type = COALESCE(?, mime_type), size_bytes = COALESCE(?, size_bytes),
           completed = CASE WHEN ? THEN 1 ELSE completed END,
           job_id = COALESCE(?, job_id),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(newUrl, file ? file.mimetype : null, file ? file.size : null, file ? 1 : 0, job ? job.id : null, jobForm.id);

    const finalJobId = job ? job.id : jobForm.job_id;
    setFlash(req, 'success', `"${jobForm.name}" updated.`);
    res.redirect(finalJobId ? `/jobs/${finalJobId}` : `/forms/job/${jobForm.id}`);
  })
);

router.post(
  '/job/:id/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const jobForm = await db.prepare('SELECT * FROM job_forms WHERE id = ?').get(req.params.id);
    if (!jobForm) return res.status(404).render('error', { message: 'Form not found.' });

    await deleteFile(jobForm.filename);
    await db.prepare('DELETE FROM job_forms WHERE id = ?').run(jobForm.id);

    setFlash(req, 'success', 'Form removed.');
    res.redirect(jobForm.job_id ? `/jobs/${jobForm.job_id}` : '/forms');
  })
);

module.exports = router;
