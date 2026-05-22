require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 5000;

// Security headers
app.use(helmet());

// CORS - locked to your domain
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Brute force protection on auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many attempts. Try again in 15 minutes.' }
});

// Routes
const driverRoutes = require('./routes/drivers');
const logRoutes = require('./routes/logs');
const institutionRoutes = require('./routes/institutions');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

app.use('/api/drivers', driverRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/institutions', institutionRoutes);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/admin', adminRoutes);

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