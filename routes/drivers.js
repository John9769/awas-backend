// ==========================================
// FILE: routes/drivers.js
// ==========================================
const express = require('express');
const router = express.Router();
const driversController = require('../controllers/driversController');

// NOTE: /register route removed.
// Registration is handled by POST /api/payment/register

// Lookup driver by plate
router.get('/lookup/:plate', driversController.lookupDriver);

// Driver login (plate + password)
router.post('/login', driversController.loginDriver);

// Reset password (plate + MyKad last-4)
router.post('/reset-password', driversController.resetPassword);

// Validate referral code
router.get('/referral/:code', driversController.validateReferralCode);

// Delete account (triple verification: plate + password + MyKad last 4)
router.delete('/account', driversController.deleteAccount);

module.exports = router;