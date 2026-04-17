const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const db      = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router     = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// Ensure upload directory exists with restricted permissions
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o750 });
}

// Allowed MIME types — verified against actual file content magic bytes
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const ALLOWED_EXT  = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

// Magic byte signatures for file type verification
const MAGIC = {
  'image/jpeg':       [Buffer.from([0xFF, 0xD8, 0xFF])],
  'image/png':        [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  'image/webp':       [Buffer.from('RIFF'), Buffer.from('WEBP')],
  'application/pdf':  [Buffer.from('%PDF')],
};

function verifyMagicBytes(filePath, mimeType) {
  try {
    const fd  = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const sigs = MAGIC[mimeType];
    if (!sigs) return false;
    if (mimeType === 'image/webp') {
      return buf.slice(0, 4).equals(sigs[0]) && buf.slice(8, 12).equals(sigs[1]);
    }
    return sigs.some(sig => buf.slice(0, sig.length).equals(sig));
  } catch { return false; }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => {
    // Use random name — never trust original filename
    const randomName = crypto.randomBytes(16).toString('hex');
    cb(null, randomName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
    files: 1,
    fields: 5,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('Only JPG, PNG, WEBP, and PDF files are allowed'));
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Invalid file type'));
    }
    cb(null, true);
  },
});

// Allowed upload types and their DB operations
const UPLOAD_TYPES = {
  saving:         { table: 'savings',    col: 'receipt_url',         ownerCol: 'member_id' },
  repayment:      { table: 'repayments', col: 'receipt_url',         ownerCol: null }, // checked via join
  member_id:      { table: 'members',    col: 'id_document_url',     ownerCol: 'id', adminOnly: true },
  member_receipt: { table: 'members',    col: 'payment_receipt_url', ownerCol: 'id', adminOnly: true },
  member_photo:   { table: 'members',    col: 'photo_url',           ownerCol: 'id', adminOnly: true },
  guarantor:      { table: 'loans',      col: 'guarantor_doc_url',   ownerCol: null, adminOnly: true },
  third_party:    { table: 'loans',      col: 'third_party_doc_url', ownerCol: null, adminOnly: true },
};

router.post('/receipt', authMiddleware, upload.single('file'), async (req, res, next) => {
  let uploadedPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    uploadedPath = req.file.path;

    const { type, record_id } = req.body;

    // Validate type
    if (!type || !UPLOAD_TYPES[type]) {
      fs.unlinkSync(uploadedPath);
      return res.status(400).json({ error: 'Invalid upload type' });
    }

    // Validate record_id — only alphanumeric, dashes, underscores
    if (!record_id || !/^[\w\-]+$/.test(record_id) || record_id.length > 100) {
      fs.unlinkSync(uploadedPath);
      return res.status(400).json({ error: 'Invalid record_id' });
    }

    const config = UPLOAD_TYPES[type];

    // Admin-only upload types
    if (config.adminOnly && req.user.role !== 'admin') {
      fs.unlinkSync(uploadedPath);
      return res.status(403).json({ error: 'Administrator access required for this upload type' });
    }

    // Verify actual file content matches claimed type (magic bytes)
    if (!verifyMagicBytes(uploadedPath, req.file.mimetype)) {
      fs.unlinkSync(uploadedPath);
      return res.status(400).json({ error: 'File content does not match its type. Upload rejected.' });
    }

    // Add proper extension to the random filename
    const ext     = path.extname(req.file.originalname).toLowerCase();
    const newName = req.file.filename + ext;
    const newPath = path.join(UPLOAD_DIR, newName);
    fs.renameSync(uploadedPath, newPath);
    uploadedPath = newPath;

    const url = '/uploads/' + newName;

    // Verify record exists and check ownership
    if (type === 'saving') {
      const row = await db.one('SELECT * FROM savings WHERE id=$1', [record_id]);
      if (!row) { fs.unlinkSync(uploadedPath); return res.status(404).json({ error: 'Saving record not found' }); }
      if (req.user.role === 'member' && row.member_id !== req.user.id) {
        fs.unlinkSync(uploadedPath); return res.status(403).json({ error: 'Access denied' });
      }
      await db.run('UPDATE savings SET receipt_url=$1 WHERE id=$2', [url, record_id]);

    } else if (type === 'repayment') {
      const row = await db.one(
        'SELECT r.*,l.member_id FROM repayments r JOIN loans l ON r.loan_id=l.id WHERE r.id=$1',
        [record_id]
      );
      if (!row) { fs.unlinkSync(uploadedPath); return res.status(404).json({ error: 'Repayment record not found' }); }
      if (req.user.role === 'member' && row.member_id !== req.user.id) {
        fs.unlinkSync(uploadedPath); return res.status(403).json({ error: 'Access denied' });
      }
      await db.run('UPDATE repayments SET receipt_url=$1 WHERE id=$2', [url, record_id]);

    } else {
      // member_id, member_receipt, member_photo, guarantor — all admin-only (checked above)
      const colMap = {
        member_id:      'id_document_url',
        member_receipt: 'payment_receipt_url',
        member_photo:   'photo_url',
      };
      if (type === 'guarantor') {
        const row = await db.one('SELECT * FROM loans WHERE id=$1', [record_id]);
        if (!row) { fs.unlinkSync(uploadedPath); return res.status(404).json({ error: 'Loan not found' }); }
        await db.run('UPDATE loans SET guarantor_doc_url=$1 WHERE id=$2', [url, record_id]);
      } else {
        const row = await db.one('SELECT * FROM members WHERE id=$1', [record_id]);
        if (!row) { fs.unlinkSync(uploadedPath); return res.status(404).json({ error: 'Member not found' }); }
        await db.run(`UPDATE members SET ${colMap[type]}=$1 WHERE id=$2`, [url, record_id]);
      }
    }

    res.json({ url, message: 'File uploaded successfully' });
  } catch(e) {
    // Clean up file on any error
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch {}
    }
    next(e);
  }
});

module.exports = router;
