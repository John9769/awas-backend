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

// ToyyibPay webhook — called by ToyyibPay after payment
router.post('/webhook', paymentController.handleWebhook);

// Get payment status
router.get('/status/:paymentId', paymentController.getPaymentStatus);

module.exports = router;