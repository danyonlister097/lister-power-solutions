const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('../db');
const { requireRole, verifyCsrf } = require('../middleware/auth');
const { upload, UPLOAD_DIR } = require('../lib/uploads');
const { setFlash } = require('../lib/flash');

const router = express.Router();

router.get('/', (req, res) => {
  const folders = db
    .prepare(
      `SELECT photo_folders.*, customers.name AS customer_name,
         (SELECT COUNT(*) FROM photo_folder_images WHERE folder_id = photo_folders.id) AS image_count,
         (SELECT id FROM photo_folder_images WHERE folder_id = photo_folders.id ORDER BY id DESC LIMIT 1) AS cover_image_id
       FROM photo_folders
       LEFT JOIN customers ON customers.id = photo_folders.customer_id
       ORDER BY photo_folders.created_at DESC`
    )
    .all();
  const customers = db.prepare('SELECT id, name FROM customers WHERE active = 1 ORDER BY name').all();

  res.render('chat/folders', { title: 'Photo Folders', folders, customers });
});

router.post('/', requireRole('admin'), verifyCsrf, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    setFlash(req, 'error', 'Folder name is required.');
    return res.redirect('/chat/folders');
  }
  const customerId = req.body.customer_id || null;

  const result = db
    .prepare('INSERT INTO photo_folders (name, customer_id, created_by) VALUES (?, ?, ?)')
    .run(name, customerId, req.user.id);

  setFlash(req, 'success', `Folder "${name}" created.`);
  res.redirect(`/chat/folders/${result.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const folder = db
    .prepare(
      `SELECT photo_folders.*, customers.name AS customer_name
       FROM photo_folders LEFT JOIN customers ON customers.id = photo_folders.customer_id
       WHERE photo_folders.id = ?`
    )
    .get(req.params.id);
  if (!folder) return res.status(404).render('error', { message: 'Folder not found.' });

  const images = db
    .prepare('SELECT * FROM photo_folder_images WHERE folder_id = ? ORDER BY created_at DESC')
    .all(folder.id);

  res.render('chat/folder', { title: folder.name, folder, images });
});

router.post('/:id/delete', requireRole('admin'), verifyCsrf, (req, res) => {
  const folder = db.prepare('SELECT * FROM photo_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).render('error', { message: 'Folder not found.' });

  const images = db.prepare('SELECT filename FROM photo_folder_images WHERE folder_id = ?').all(folder.id);
  images.forEach((img) => fs.unlink(path.join(UPLOAD_DIR, img.filename), () => {}));

  db.prepare('DELETE FROM photo_folder_images WHERE folder_id = ?').run(folder.id);
  db.prepare('DELETE FROM photo_folders WHERE id = ?').run(folder.id);

  setFlash(req, 'success', `Folder "${folder.name}" deleted.`);
  res.redirect('/chat/folders');
});

function uploadPhotos(req, res, next) {
  upload.array('photos', 5)(req, res, (err) => {
    if (err) {
      setFlash(req, 'error', err.message || 'Upload failed.');
      return res.redirect(`/chat/folders/${req.params.id}`);
    }
    next();
  });
}

router.post('/:id/images', uploadPhotos, verifyCsrf, (req, res) => {
  const folder = db.prepare('SELECT id FROM photo_folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).render('error', { message: 'Folder not found.' });

  const files = req.files || [];
  const insert = db.prepare(
    `INSERT INTO photo_folder_images (folder_id, filename, original_name, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const f of files) {
    insert.run(folder.id, f.filename, f.originalname, f.mimetype, f.size, req.user.id);
  }

  setFlash(req, 'success', files.length ? `${files.length} photo${files.length > 1 ? 's' : ''} uploaded.` : 'No photos selected.');
  res.redirect(`/chat/folders/${folder.id}`);
});

router.get('/:id/images/:imageId', (req, res) => {
  const image = db
    .prepare('SELECT * FROM photo_folder_images WHERE id = ? AND folder_id = ?')
    .get(req.params.imageId, req.params.id);
  if (!image) return res.status(404).render('error', { message: 'Photo not found.' });

  res.type(image.mime_type);
  res.sendFile(path.join(UPLOAD_DIR, image.filename));
});

router.post('/:id/images/:imageId/delete', verifyCsrf, (req, res) => {
  const image = db
    .prepare('SELECT * FROM photo_folder_images WHERE id = ? AND folder_id = ?')
    .get(req.params.imageId, req.params.id);
  if (!image) return res.status(404).render('error', { message: 'Photo not found.' });
  if (image.uploaded_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'You do not have access to this page.' });
  }

  fs.unlink(path.join(UPLOAD_DIR, image.filename), () => {});
  db.prepare('DELETE FROM photo_folder_images WHERE id = ?').run(image.id);

  setFlash(req, 'success', 'Photo removed.');
  res.redirect(`/chat/folders/${req.params.id}`);
});

module.exports = router;
