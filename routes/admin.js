const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuth = require('../middleware/adminAuth');

// Video route — BEFORE adminAuth (browser video tag cannot send headers)
router.get('/video/:logHash', adminController.streamVideo);

// All other routes protected by adminAuth header check
router.use(adminAuth);

router.get('/dashboard', adminController.getDashboard);
router.get('/users', adminController.getUsers);
router.get('/writs', adminController.getWrits);
router.get('/institutions', adminController.getAllInstitutions);
router.get('/institutions/pending', adminController.getPendingInstitutions);
router.patch('/institutions/:id/approve', adminController.approveInstitution);
router.patch('/institutions/:id/revoke', adminController.revokeInstitution);
router.get('/payments', adminController.getPayments);
router.get('/affiliates', adminController.getAffiliates);
router.get('/verification-requests', adminController.getVerificationRequests);

module.exports = router;