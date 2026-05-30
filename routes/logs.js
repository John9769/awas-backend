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

// SINGLE LPR-GATED ENDPOINT:
// Receives the video + claimed plate + incident metadata.
// Runs LPR, verifies against a paid driver account, and ONLY on full pass
// issues the writ and seals the video. No writ is created on rejection.
router.post('/verify-seal', upload.single('video'), logsController.verifyAndSeal);

// Paywall unlock (unchanged)
router.post('/paywall-clear', logsController.clearPaywall);

module.exports = router;