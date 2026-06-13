require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const qs = require('qs');

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
        // Allow requests with no origin (mobile apps, Postman, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));

// ─── TOYYIBPAY WEBHOOK — RAW BODY PARSER ─────────────────────────────────────
// Registered BEFORE the global JSON/urlencoded parsers and BEFORE the
// payment route mount. ToyyibPay's callback has been observed arriving with
// req.body = {} under express.urlencoded(), regardless of Content-Type.
// This route-specific raw parser captures the exact byte stream ToyyibPay
// sends, then manually parses it as urlencoded form data via `qs`, so the
// webhook handler always receives the real refno/status_id/billcode values.
const paymentController = require('./controllers/paymentController');
app.post(
    '/api/payment/webhook',
    express.raw({ type: '*/*' }),
    (req, res, next) => {
        try {
            const rawString = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
            console.log('AWAS Webhook RAW bytes:', rawString);
            req.body = qs.parse(rawString);
        } catch (parseErr) {
            console.error('AWAS Webhook raw-parse fault:', parseErr);
            req.body = {};
        }
        next();
    },
    paymentController.handleWebhook
);

// JSON body parser
app.use(express.json());

// URL-encoded body parser — required for ToyyibPay webhook callbacks
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
// Note: /api/payment/webhook is already handled above by the raw-body
// route registered before this mount. Express matches the more specific
// route registered first, so the webhook POST never reaches paymentRoutes'
// own /webhook handler — but the rest of paymentRoutes (/register, /writ,
// /status/:id) mount normally here.
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