// ==========================================
// FILE: routes/logs.js
// ==========================================
const express = require('express');
const router = express.Router();
const multer = require('multer');
const logsController = require('../controllers/logsController');

// Multer — memory storage, 200MB limit for video files
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }
});

router.post('/submit', logsController.submitLog);
router.post('/upload-video', upload.single('video'), logsController.uploadVideo);
router.post('/paywall-clear', logsController.clearPaywall);

module.exports = router;