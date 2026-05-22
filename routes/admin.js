const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuth = require('../middleware/adminAuth');

router.use(adminAuth); // protect all admin routes

router.get('/dashboard', adminController.getDashboard);
router.get('/institutions', adminController.getAllInstitutions);
router.get('/institutions/pending', adminController.getPendingInstitutions);
router.patch('/institutions/:id/approve', adminController.approveInstitution);
router.patch('/institutions/:id/revoke', adminController.revokeInstitution);

module.exports = router;