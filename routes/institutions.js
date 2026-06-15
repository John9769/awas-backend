// ==========================================
// FILE: routes/institutions.js
// ==========================================
const express = require('express');
const router = express.Router();
const institutionsController = require('../controllers/institutionsController');
const authMiddleware = require('../middleware/auth');

// Public — no auth needed
router.get('/consent/:token/approve', institutionsController.approveConsent);
router.get('/consent/:token/reject', institutionsController.rejectConsent);
router.get('/certificate/:certNumber', institutionsController.getCertificate);

// Protected — institution JWT required
router.post('/request-access', authMiddleware, institutionsController.requestAccess);
router.get('/my-requests', authMiddleware, institutionsController.getMyRequests);
router.post('/create-bill', authMiddleware, institutionsController.createInstitutionBill);

module.exports = router;