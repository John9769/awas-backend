// ==========================================
// FILE: routes/affiliate.js
// ==========================================
const express = require('express');
const router = express.Router();
const affiliateController = require('../controllers/affiliateController');

// Join affiliate program
router.post('/join', affiliateController.joinAffiliate);

// Get affiliate dashboard
router.get('/dashboard/:vehiclePlate', affiliateController.getDashboard);

// Update bank details
router.put('/bank', affiliateController.updateBankDetails);

// Request payout
router.post('/payout', affiliateController.requestPayout);

module.exports = router;