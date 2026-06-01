// ==========================================
// FILE: routes/logs.js
// ==========================================
const express = require('express');
const router = express.Router();
const multer = require('multer');
const logsController = require('../controllers/logsController');

// Multer — memory storage
// video: 1 file, max 200MB
// images: up to 4 files, max 10MB each
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }
});

const evidenceUpload = upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'images', maxCount: 4 }
]);

router.post('/verify-seal', evidenceUpload, logsController.verifyAndSeal);
router.post('/paywall-clear', logsController.clearPaywall);

module.exports = router;