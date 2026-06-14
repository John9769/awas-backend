// ==========================================
// FILE: routes/payment.js
// ==========================================
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// Create registration bill (ToyyibPay)
router.post('/register', paymentController.createRegistrationBill);

// Create writ bill (ToyyibPay)
router.post('/writ', paymentController.createWritBill);

// Get payment status
router.get('/status/:paymentId', paymentController.getPaymentStatus);

// NOTE: /webhook is NOT here — registered directly in server.js before
// global body parsers so formidable can read the raw stream cleanly.

module.exports = router;