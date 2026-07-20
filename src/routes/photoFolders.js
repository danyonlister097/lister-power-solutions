const { Readable } = require('stream');
const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { upload, putFile, fetchFile, deleteFile } = require('../lib/uploads');
const { setFlash } = require('../lib/flash');
const { asyncHandler } = require('../lib/asyncHandler');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const folders = await db
      .prepare(
        `SELECT photo_folders.*, customers.name AS customer_name,
           (SELECT COUNT(*) FROM photo_folder_images WHERE folder_id = photo_folders.id) AS image_count,
           (SELECT id FROM photo_folder_images WHERE folder_id = photo_folders.id ORDER BY id DESC LIMIT 1) AS cover_image_id
         FROM photo_folders
         LEFT JOIN customers ON customers.id = photo_folders.customer_id
         ORDER BY photo_folders.created_at DESC`
      )
      .all();
    const customers = await db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();

    res.render('chat/folders', { title: 'Photo Folders', folders, customers });
  })
);

router.post(
  '/',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) {
      setFlash(req, 'error', 'Folder name is required.');
      return res.redirect('/chat/folders');
    }
    const customerId = req.body.customer_id || null;

    const result = await db
      .prepare('INSERT INTO photo_folders (name, customer_id, created_by) VALUES (?, ?, ?) RETURNING id')
      .run(name, customerId, req.user.id);

    setFlash(req, 'success', `Folder "${name}" created.`);
    res.redirect(`/chat/folders/${result.lastInsertRowid}`);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const folder = await db
      .prepare(
        `SELECT photo_folders.*, customers.name AS customer_name
         FROM photo_folders LEFT JOIN customers ON customers.id = photo_folders.customer_id
         WHERE photo_folders.id = ?`
      )
      .get(req.params.id);
    if (!folder) return res.status(404).render('error', { message: 'Folder not found.' });

    const images = await db.prepare('SELECT * FROM photo_folder_images WHERE folder_id = ? ORDER BY created_at DESC').all(folder.id);

    res.render('chat/folder', { title: folder.name, folder, images });
  })
);

router.post(
  '/:id/delete',
  requireRole('admin'),
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const folder = await db.prepare('SELECT * FROM photo_folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).render('error', { message: 'Folder not found.' });

    const images = await db.prepare('SELECT filename FROM photo_folder_images WHERE folder_id = ?').all(folder.id);
    await Promise.all(images.map((img) => deleteFile(img.filename)));

    await db.prepare('DELETE FROM photo_folder_images WHERE folder_id = ?').run(folder.id);
    await db.prepare('DELETE FROM photo_folders WHERE id = ?').run(folder.id);

    setFlash(req, 'success', `Folder "${folder.name}" deleted.`);
    res.redirect('/chat/folders');
  })
);

function uploadPhotos(req, res, next) {
  upload.array('photos', 5)(req, res, (err) => {
    if (err) {
      setFlash(req, 'error', err.message || 'Upload failed.');
      return res.redirect(`/chat/folders/${req.params.id}`);
    }
    next();
  });
}

router.post(
  '/:id/images',
  uploadPhotos,
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const folder = await db.prepare('SELECT id FROM photo_folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).render('error', { message: 'Folder not found.' });

    const files = req.files || [];
    const insert = db.prepare(
      `INSERT INTO photo_folder_images (folder_id, filename, original_name, mime_type, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const f of files) {
      const url = await putFile(f);
      await insert.run(folder.id, url, f.originalname, f.mimetype, f.size, req.user.id);
    }

    setFlash(req, 'success', files.length ? `${files.length} photo${files.length > 1 ? 's' : ''} uploaded.` : 'No photos selected.');
    res.redirect(`/chat/folders/${folder.id}`);
  })
);

router.get(
  '/:id/images/:imageId',
  asyncHandler(async (req, res) => {
    const image = await db.prepare('SELECT * FROM photo_folder_images WHERE id = ? AND folder_id = ?').get(req.params.imageId, req.params.id);
    if (!image) return res.status(404).render('error', { message: 'Photo not found.' });

    const stream = await fetchFile(image.filename);
    if (!stream) return res.status(404).render('error', { message: 'File not found.' });
    res.type(image.mime_type);
    Readable.fromWeb(stream).pipe(res);
  })
);

router.post(
  '/:id/images/:imageId/delete',
  verifyCsrf,
  asyncHandler(async (req, res) => {
    const image = await db.prepare('SELECT * FROM photo_folder_images WHERE id = ? AND folder_id = ?').get(req.params.imageId, req.params.id);
    if (!image) return res.status(404).render('error', { message: 'Photo not found.' });
    if (image.uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).render('error', { message: 'You do not have access to this page.' });
    }

    await deleteFile(image.filename);
    await db.prepare('DELETE FROM photo_folder_images WHERE id = ?').run(image.id);

    setFlash(req, 'success', 'Photo removed.');
    res.redirect(`/chat/folders/${req.params.id}`);
  })
);

module.exports = router;
