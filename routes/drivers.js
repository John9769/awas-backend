// ==========================================
// FILE: routes/drivers.js — UPDATED
// ==========================================
const express = require('express');
const router = express.Router();
const driversController = require('../controllers/driversController');

// Register driver
router.post('/register', driversController.registerDriver);

// Lookup driver by plate (for login)
router.get('/lookup/:plate', driversController.lookupDriver);

// Validate referral code
router.get('/referral/:code', driversController.validateReferralCode);

module.exports = router;