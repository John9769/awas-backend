require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

// Security headers
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false
}));

// CORS
const allowedOrigins = [
    'https://awas.asia',
    'https://www.awas.asia',
    'https://awas-pwa.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));

// ─── TOYYIBPAY WEBHOOK — MULTER MULTIPART PARSER ─────────────────────────────
// ToyyibPay sends callback as multipart/form-data (confirmed from live logs).
// express.urlencoded() cannot parse multipart — body arrives as {}.
// multer().none() parses multipart/form-data fields with no file uploads,
// populating req.body correctly with refno, status, order_id, billcode, etc.
// Registered BEFORE global body parsers and payment route mount so this
// route-specific parser fires first.
const webhookParser = multer().none();
const paymentController = require('./controllers/paymentController');
app.post('/api/payment/webhook', webhookParser, paymentController.handleWebhook);

// JSON body parser
app.use(express.json());

// URL-encoded body parser
app.use(express.urlencoded({ extended: true }));

// Routes
const driverRoutes = require('./routes/drivers');
const logRoutes = require('./routes/logs');
const institutionRoutes = require('./routes/institutions');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const affiliateRoutes = require('./routes/affiliate');
const paymentRoutes = require('./routes/payment');
const mapRoutes = require('./routes/maps');

app.use('/api/drivers', driverRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/institutions', institutionRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/affiliate', affiliateRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/maps', mapRoutes);

// Admin cockpit
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Health check
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "AWAS Core Engine Active" });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('AWAS Unhandled Error:', err);
    res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
    console.log(`AWAS Backend listening on port ${PORT}`);
});

process.on('SIGTERM', async () => {
    process.exit(0);
});