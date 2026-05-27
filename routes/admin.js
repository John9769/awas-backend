// ==========================================
// FILE: routes/admin.js
// ==========================================
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuth = require('../middleware/adminAuth');

router.use(adminAuth);

// Dashboard
router.get('/dashboard', adminController.getDashboard);

// Users
router.get('/users', adminController.getUsers);

// Writs & Videos
router.get('/writs', adminController.getWrits);
router.get('/video/:logHash', adminController.streamVideo);

// Institutions
router.get('/institutions', adminController.getAllInstitutions);
router.get('/institutions/pending', adminController.getPendingInstitutions);
router.patch('/institutions/:id/approve', adminController.approveInstitution);
router.patch('/institutions/:id/revoke', adminController.revokeInstitution);

// Payments
router.get('/payments', adminController.getPayments);

// Affiliates
router.get('/affiliates', adminController.getAffiliates);

// Verification Requests
router.get('/verification-requests', adminController.getVerificationRequests);

module.exports = router;