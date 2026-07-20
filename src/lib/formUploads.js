const multer = require('multer');
const { putFile, copyFile, fetchFile, deleteFile } = require('./uploads');

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
]);

const uploadForm = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Only PDF, Word, Excel, or image files are allowed.'));
    }
    cb(null, true);
  },
});

module.exports = { uploadForm, putFile, copyFile, fetchFile, deleteFile };
