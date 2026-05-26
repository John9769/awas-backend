// ==========================================
// FILE: routes/maps.js
// ==========================================
const express = require('express');
const router = express.Router();
const { getStaticMap } = require('../controllers/mapsController');

router.get('/static', getStaticMap);

module.exports = router;