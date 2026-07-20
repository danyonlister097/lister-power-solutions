const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { put, copy, del } = require('@vercel/blob');
const config = require('../config');

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Only image files (JPEG, PNG, WEBP, HEIC) are allowed.'));
    }
    cb(null, true);
  },
});

// Uploads one multer (memoryStorage) file to Vercel Blob and returns its
// URL - stored as the "filename" column across job_attachments,
// photo_folder_images, form_templates, and job_forms. The URL is never
// handed to the browser directly (see fetchFile) - routes stay behind the
// app's own auth/authorization instead of relying on the blob's own access
// mode, which has no per-request permission concept.
async function putFile(file) {
  const ext = path.extname(file.originalname).slice(0, 10);
  const pathname = `${crypto.randomUUID()}${ext}`;
  const blob = await put(pathname, file.buffer, {
    access: 'public',
    addRandomSuffix: false,
    contentType: file.mimetype,
    token: config.blob.token,
  });
  return blob.url;
}

// Server-side duplicate of an existing blob (no download/re-upload through
// this process) - used when duplicating a form template into its own
// independent copy for a job.
async function copyFile(sourceUrl, originalName) {
  const ext = path.extname(originalName || '').slice(0, 10);
  const pathname = `${crypto.randomUUID()}${ext}`;
  const blob = await copy(sourceUrl, pathname, {
    access: 'public',
    addRandomSuffix: false,
    token: config.blob.token,
  });
  return blob.url;
}

// Streams a stored blob back out, for routes that proxy a file through the
// app instead of exposing the underlying blob URL - see putFile above.
async function fetchFile(url) {
  const blobRes = await fetch(url);
  if (!blobRes.ok || !blobRes.body) return null;
  return blobRes.body;
}

async function deleteFile(url) {
  if (!url) return;
  await del(url, { token: config.blob.token }).catch(() => {});
}

module.exports = { upload, putFile, copyFile, fetchFile, deleteFile };
