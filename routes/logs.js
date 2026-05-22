const express = require('express');
const router = express.Router();
const logsController = require('../controllers/logsController');

router.post('/submit', logsController.submitLog);
router.post('/paywall-clear', logsController.clearPaywall);

module.exports = router;
