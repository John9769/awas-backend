// ==========================================
// FILE: routes/affiliate.js
// ==========================================
const express = require('express');
const router = express.Router();
const affiliateController = require('../controllers/affiliateController');
const auth = require('../middleware/auth');

// All routes require valid driver JWT
router.post('/join', auth, affiliateController.joinAffiliate);
router.get('/dashboard', auth, affiliateController.getDashboard);
router.put('/bank', auth, affiliateController.updateBankDetails);
router.post('/payout', auth, affiliateController.requestPayout);

module.exports = router;