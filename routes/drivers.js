const express = require('express');
const router = express.Router();
const driversController = require('../controllers/driversController');

router.post('/register', driversController.registerDriver);
router.get('/lookup/:plate', driversController.lookupDriver);

module.exports = router;
