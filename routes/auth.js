const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.post('/signup', authController.registerInstitution);
router.post('/login', authController.loginInstitution);

module.exports = router;
