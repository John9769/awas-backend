// ==========================================
// FILE: routes/payment.js
// ==========================================
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// Create registration bill
router.post('/register', paymentController.createRegistrationBill);

// Create writ bill
router.post('/writ', paymentController.createWritBill);

// Billplz webhook
router.post('/webhook', paymentController.handleWebhook);

// Get payment status
router.get('/status/:paymentId', paymentController.getPaymentStatus);

module.exports = router;