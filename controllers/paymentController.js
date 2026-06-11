// ==========================================
// FILE: controllers/paymentController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');
const bcrypt = require('bcrypt');
const { creditAffiliateEarning } = require('./affiliateController');

const REGISTRATION_FEE = 29.99;
const WRIT_FEE = 8.00;
const AFFILIATE_CUT = 4.99;
const TOYYIBPAY_BASE_URL = process.env.TOYYIBPAY_BASE_URL || 'https://toyyibpay.com';
const FALLBACK_EMAIL = 'noreply@awas.asia';

// ─── HELPER: Generate unique 8-char referral code ────────────────────────────
async function generateUniqueReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code, exists;
    do {
        code = 'AWAS';
        for (let i = 0; i < 4; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        exists = await prisma.driver.findUnique({ where: { referralCode: code } });
    } while (exists);
    return code;
}

// ─── HELPER: Create ToyyibPay Bill ───────────────────────────────────────────
// billEmail is MANDATORY for ToyyibPay when billPayorInfo=1.
// Empty OR missing billEmail = createBill fails ("billEmail parameter is empty").
// Always pass a valid email; caller falls back to noreply@awas.asia if none.
const createToyyibpayBill = async ({ billName, billDescription, billAmount, billExternalReferenceNo, billTo, billEmail, billPhone }) => {
    const params = new URLSearchParams();
    params.append('userSecretKey', process.env.TOYYIBPAY_SECRET_KEY);
    params.append('categoryCode', process.env.TOYYIBPAY_CATEGORY_CODE);
    params.append('billName', billName);
    params.append('billDescription', billDescription);
    params.append('billPriceSetting', '1');
    params.append('billPayorInfo', '1');
    params.append('billAmount', String(Math.round(billAmount * 100)));
    params.append('billReturnUrl', `${process.env.FE_URL}/login.html?payment=success`);
    params.append('billCallbackUrl', `${process.env.BE_URL}/api/payment/webhook`);
    params.append('billExternalReferenceNo', String(billExternalReferenceNo));
    params.append('billTo', billTo || '');
    params.append('billEmail', billEmail && billEmail.trim() ? billEmail.trim() : FALLBACK_EMAIL);
    if (billPhone) params.append('billPhone', billPhone);
    params.append('billSplitPayment', '0');
    params.append('billSplitPaymentArgs', '');
    params.append('billPaymentChannel', '0');
    params.append('billDisplayMerchant', '1');
    params.append('billContentEmail', 'Terima kasih kerana mendaftar AWAS. Langganan anda kini aktif.');
    params.append('billChargeToCustomer', '0');
    params.append('enableDuitNowQR', '1');
    params.append('chargeDuitNowQR', '0');

    const response = await axios.post(
        `${TOYYIBPAY_BASE_URL}/index.php/api/createBill`,
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (!response.data || !response.data[0] || !response.data[0].BillCode) {
        throw new Error(`ToyyibPay createBill failed: ${JSON.stringify(response.data)}`);
    }

    return response.data[0].BillCode;
};

// ─── CREATE REGISTRATION BILL ─────────────────────────────────────────────────
// This is the SINGLE endpoint for registration.
// Driver is created here. If ToyyibPay fails, driver + payment are rolled back.
// No orphaned records possible.
exports.createRegistrationBill = async (req, res) => {
    const plate = (req.body.vehiclePlate || '').toUpperCase().replace(/\s+/g, '');
    let driverCreated = false;
    let paymentId = null;

    try {
        const {
            vehicleMakeModel,
            vehicleType,
            mykadLastFour,
            phone,
            email,
            password,
            consentGiven,
            referredByCode
        } = req.body;

        // ── Validate all inputs ───────────────────────────────────────────
        if (!consentGiven) {
            return res.status(400).json({ error: 'PDPA Consent Mandatory.' });
        }
        if (!plate || !vehicleMakeModel || !mykadLastFour || !phone || !email || !password) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }
        if (!/^\d{4}$/.test(mykadLastFour)) {
            return res.status(400).json({ error: 'Invalid MyKad input. Last 4 digits only.' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Alamat emel tidak sah.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Kata laluan diperlukan (minimum 6 aksara).' });
        }
        if (vehicleType && !['CAR', 'MOTORCYCLE', 'LORRY', 'BUS', 'VAN'].includes(vehicleType)) {
            return res.status(400).json({ error: 'Invalid vehicle type.' });
        }

        const cleanEmail = email.trim().toLowerCase();

        // ── Check if plate already registered and active ──────────────────
        const existing = await prisma.driver.findUnique({ where: { vehiclePlate: plate } });
        if (existing && existing.subStatus === 'ACTIVE') {
            return res.status(409).json({ error: 'Plat kenderaan ini sudah berdaftar dan aktif. Sila log masuk.' });
        }

        // ── Validate referral code ────────────────────────────────────────
        let validReferralCode = null;
        if (referredByCode) {
            const referrer = await prisma.driver.findUnique({
                where: { referralCode: referredByCode.toUpperCase() }
            });
            if (referrer) validReferralCode = referredByCode.toUpperCase();
        }

        // ── Hash password ─────────────────────────────────────────────────
        const passwordHash = await bcrypt.hash(password, 12);

        // ── Generate unique referral code ─────────────────────────────────
        const newReferralCode = await generateUniqueReferralCode();

        // ── STEP 1: Create driver as EXPIRED ──────────────────────────────
        // If driver already exists (previous failed attempt) — update record
        await prisma.driver.upsert({
            where: { vehiclePlate: plate },
            update: {
                vehicleMakeModel,
                vehicleType: vehicleType || 'CAR',
                mykadLastFour,
                phone,
                email: cleanEmail,
                passwordHash,
                subStatus: 'EXPIRED',
                subExpiresAt: new Date()
            },
            create: {
                vehiclePlate: plate,
                vehicleMakeModel,
                vehicleType: vehicleType || 'CAR',
                mykadLastFour,
                phone,
                email: cleanEmail,
                passwordHash,
                subStatus: 'EXPIRED',
                subExpiresAt: new Date(),
                referralCode: newReferralCode,
                referredByCode: validReferralCode
            }
        });
        driverCreated = true;

        // ── STEP 2: Create payment record ─────────────────────────────────
        const payment = await prisma.payment.create({
            data: {
                vehiclePlate: plate,
                amount: REGISTRATION_FEE,
                type: 'REGISTRATION',
                status: 'PENDING',
                referralCode: validReferralCode || null,
                affiliateCut: validReferralCode ? AFFILIATE_CUT : null
            }
        });
        paymentId = payment.id;

        // ── STEP 3: Create ToyyibPay bill ─────────────────────────────────
        // If this fails, we roll back driver + payment in the catch block
        const billCode = await createToyyibpayBill({
            billName: `AWAS-REG-${plate}`,
            billDescription: `AWAS Annual Protection - ${plate}`,
            billAmount: REGISTRATION_FEE,
            billExternalReferenceNo: payment.id,
            billTo: plate,
            billEmail: cleanEmail,
            billPhone: phone || ''
        });

        // ── STEP 4: Update payment with bill code ─────────────────────────
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                toyyibpayBillCode: billCode,
                toyyibpayUrl: `${TOYYIBPAY_BASE_URL}/${billCode}`
            }
        });

        console.log(`AWAS: Registration bill created for ${plate}. BillCode: ${billCode}`);

        return res.status(201).json({
            paymentId: payment.id,
            billCode,
            paymentUrl: `${TOYYIBPAY_BASE_URL}/${billCode}`,
            amount: REGISTRATION_FEE
        });

    } catch (err) {
        console.error('Create registration bill fault:', err);

        // ── ROLLBACK: If ToyyibPay failed, clean up driver + payment ──────
        try {
            if (paymentId) {
                await prisma.payment.delete({ where: { id: paymentId } });
            }
            if (driverCreated) {
                await prisma.driver.delete({ where: { vehiclePlate: plate } });
            }
            console.log(`AWAS: Rolled back driver + payment for ${plate}`);
        } catch (rollbackErr) {
            console.error('AWAS Rollback fault:', rollbackErr);
        }

        return res.status(500).json({ error: 'Ralat semasa mencipta bil pembayaran. Sila cuba lagi.' });
    }
};

// ─── TOYYIBPAY WEBHOOK ───────────────────────────────────────────────────────
// status_id: 1 = success, 2 = pending, 3 = failed
exports.handleWebhook = async (req, res) => {
    try {
        // ToyyibPay posts form-encoded data. Read defensively so an empty or
        // unparsed body never crashes the handler.
        // (Previous bug: destructuring refno from undefined req.body threw a
        // TypeError, which killed activation for paid drivers.)
        const body = (req.body && typeof req.body === 'object') ? req.body : {};

        // Log the raw body so we can see EXACTLY what ToyyibPay sends.
        console.log('AWAS Webhook RAW body:', JSON.stringify(body));

        const refno = body.refno;
        const status_id = body.status_id;
        const billcode = body.billcode;

        console.log(`AWAS ToyyibPay Webhook: refno=${refno} status_id=${status_id} billcode=${billcode}`);

        // Always answer 200 to ToyyibPay so it does not keep retrying,
        // even when we can't act on the payload.
        if (!refno || !status_id) {
            console.error('AWAS Webhook: missing refno or status_id in body.');
            return res.status(200).json({ message: 'Missing webhook parameters — ignored.' });
        }

        const paymentId = parseInt(refno);
        if (isNaN(paymentId)) {
            console.error(`AWAS Webhook: invalid refno=${refno}`);
            return res.status(200).json({ message: 'Invalid reference number — ignored.' });
        }

        const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

        if (!payment) {
            console.error(`AWAS Webhook: Payment not found for refno=${refno}`);
            return res.status(200).json({ message: 'Payment not found — ignored.' });
        }

        // Handle pending
        if (status_id === '2' || status_id === 2) {
            if (!payment.toyyibpayBillCode && billcode) {
                await prisma.payment.update({
                    where: { id: paymentId },
                    data: { toyyibpayBillCode: billcode }
                });
            }
            return res.status(200).json({ message: 'Payment pending.' });
        }

        // Handle failed
        if (status_id === '3' || status_id === 3) {
            await prisma.payment.update({
                where: { id: paymentId },
                data: { status: 'FAILED' }
            });
            return res.status(200).json({ message: 'Payment failed recorded.' });
        }

        // Handle success
        if (status_id === '1' || status_id === 1) {

            // Idempotency
            if (payment.status === 'PAID') {
                return res.status(200).json({ message: 'Already processed.' });
            }

            // Mark payment as paid
            await prisma.payment.update({
                where: { id: paymentId },
                data: {
                    status: 'PAID',
                    paidAt: new Date(),
                    toyyibpayBillCode: billcode || payment.toyyibpayBillCode
                }
            });

            // Handle REGISTRATION / RENEWAL — activate driver
            if (payment.type === 'REGISTRATION' || payment.type === 'RENEWAL') {
                const expiryDate = new Date();
                expiryDate.setFullYear(expiryDate.getFullYear() + 1);

                await prisma.driver.update({
                    where: { vehiclePlate: payment.vehiclePlate },
                    data: {
                        subStatus: 'ACTIVE',
                        subExpiresAt: expiryDate
                    }
                });

                console.log(`AWAS: Driver ${payment.vehiclePlate} activated. Expires ${expiryDate}`);

                if (payment.referralCode) {
                    await creditAffiliateEarning(
                        payment.vehiclePlate,
                        payment.id,
                        payment.type
                    );
                }
            }

            // Handle WRIT — unlock PDF paywall
            if (payment.type === 'WRIT') {
                const log = await prisma.accidentLog.findFirst({
                    where: {
                        vehiclePlate: payment.vehiclePlate,
                        isReportPaid: false
                    },
                    orderBy: { createdAt: 'desc' }
                });

                if (log) {
                    await prisma.accidentLog.update({
                        where: { id: log.id },
                        data: { isReportPaid: true }
                    });
                    console.log(`AWAS: Writ paywall cleared for ${payment.vehiclePlate} logId=${log.id}`);
                }
            }

            return res.status(200).json({ message: 'Payment processed successfully.' });
        }

        return res.status(200).json({ message: 'Unknown status ignored.' });

    } catch (err) {
        console.error('AWAS Webhook fault:', err);
        // Still answer 200 so ToyyibPay does not hammer retries on a server error.
        return res.status(200).json({ message: 'Webhook error logged.' });
    }
};

// ─── CREATE WRIT BILL (RM8) ──────────────────────────────────────────────────
exports.createWritBill = async (req, res) => {
    try {
        const { vehiclePlate, logHash } = req.body;

        if (!vehiclePlate || !logHash) {
            return res.status(400).json({ error: 'Nombor plat dan log hash diperlukan.' });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({ where: { vehiclePlate: plate } });

        if (!driver) {
            return res.status(404).json({ error: 'Akaun AWAS tidak dijumpai.' });
        }

        const payment = await prisma.payment.create({
            data: {
                vehiclePlate: plate,
                amount: WRIT_FEE,
                type: 'WRIT',
                status: 'PENDING'
            }
        });

        let billCode;
        try {
            billCode = await createToyyibpayBill({
                billName: `AWAS-WRIT-${plate}`,
                billDescription: `AWAS Digital Writ Report - ${logHash.substring(0, 8)}`,
                billAmount: WRIT_FEE,
                billExternalReferenceNo: payment.id,
                billTo: plate,
                billEmail: driver.email || '',
                billPhone: driver.phone || ''
            });
        } catch (toyyibErr) {
            // Rollback payment record if ToyyibPay fails
            await prisma.payment.delete({ where: { id: payment.id } });
            console.error('Create writ bill ToyyibPay fault:', toyyibErr);
            return res.status(500).json({ error: 'Ralat semasa mencipta bil writ. Sila cuba lagi.' });
        }

        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                toyyibpayBillCode: billCode,
                toyyibpayUrl: `${TOYYIBPAY_BASE_URL}/${billCode}`
            }
        });

        return res.status(201).json({
            paymentId: payment.id,
            billCode,
            paymentUrl: `${TOYYIBPAY_BASE_URL}/${billCode}`,
            amount: WRIT_FEE
        });

    } catch (err) {
        console.error('Create writ bill fault:', err);
        return res.status(500).json({ error: 'Ralat semasa mencipta bil writ.' });
    }
};

// ─── GET PAYMENT STATUS ──────────────────────────────────────────────────────
exports.getPaymentStatus = async (req, res) => {
    try {
        const { paymentId } = req.params;

        const payment = await prisma.payment.findUnique({
            where: { id: parseInt(paymentId) }
        });

        if (!payment) {
            return res.status(404).json({ error: 'Rekod pembayaran tidak dijumpai.' });
        }

        return res.status(200).json({
            status: payment.status,
            amount: parseFloat(payment.amount),
            type: payment.type,
            paidAt: payment.paidAt,
            toyyibpayUrl: payment.toyyibpayUrl
        });

    } catch (err) {
        console.error('Payment status fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};