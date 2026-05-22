const express = require('express');
const router = express.Router();
const institutionsController = require('../controllers/institutionsController');
const authMiddleware = require('../middleware/auth');

router.post('/request-access', authMiddleware, institutionsController.requestAccess);
router.patch('/driver-authorize', institutionsController.driverAuthorize); // no JWT — driver uses consent token
router.post('/unlock-evidence', authMiddleware, institutionsController.unlockEvidence);

module.exports = router;