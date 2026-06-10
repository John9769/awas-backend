// ==========================================
// FILE: routes/admin.js
// ==========================================
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuth = require('../middleware/adminAuth');

// All routes protected by adminAuth
router.use(adminAuth);

router.get('/dashboard', adminController.getDashboard);
router.get('/users', adminController.getUsers);
router.get('/writs', adminController.getWrits);
router.get('/payments', adminController.getPayments);
router.get('/affiliates', adminController.getAffiliates);
router.get('/payout-due', adminController.getPayoutDue);
router.post('/payout-done', adminController.markPayoutDone);
router.get('/institutions', adminController.getAllInstitutions);
router.get('/institutions/pending', adminController.getPendingInstitutions);
router.patch('/institutions/:id/approve', adminController.approveInstitution);
router.patch('/institutions/:id/revoke', adminController.revokeInstitution);
router.get('/verification-requests', adminController.getVerificationRequests);

module.exports = router;