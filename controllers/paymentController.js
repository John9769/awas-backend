// ==========================================
// FILE: controllers/paymentController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');
const bcrypt = require('bcrypt');
const { formidable } = require('formidable');
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
const createToyyibpayBill = async ({ billName, billDescription, billAmount, billExternalReferenceNo, billTo, billEmail, billPhone, billReturnUrl }) => {
    const params = new URLSearchParams();
    params.append('userSecretKey', process.env.TOYYIBPAY_SECRET_KEY);
    params.append('categoryCode', process.env.TOYYIBPAY_CATEGORY_CODE);
    params.append('billName', billName);
    params.append('billDescription', billDescription);
    params.append('billPriceSetting', '1');
    params.append('billPayorInfo', '1');
    params.append('billAmount', String(Math.round(billAmount * 100)));
    params.append('billReturnUrl', billReturnUrl || `${process.env.FE_URL}/login.html?payment=success`);
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

        const existing = await prisma.driver.findUnique({ where: { vehiclePlate: plate } });
        if (existing && existing.subStatus === 'ACTIVE') {
            return res.status(409).json({ error: 'Plat kenderaan ini sudah berdaftar dan aktif. Sila log masuk.' });
        }

        let validReferralCode = null;
        if (referredByCode) {
            const referrer = await prisma.driver.findUnique({
                where: { referralCode: referredByCode.toUpperCase() }
            });
            if (referrer) validReferralCode = referredByCode.toUpperCase();
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const newReferralCode = await generateUniqueReferralCode();

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

        const billCode = await createToyyibpayBill({
            billName: `AWAS-REG-${plate}`,
            billDescription: `AWAS Annual Protection - ${plate}`,
            billAmount: REGISTRATION_FEE,
            billExternalReferenceNo: payment.id,
            billTo: plate,
            billEmail: cleanEmail,
            billPhone: phone || ''
        });

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
        try {
            if (paymentId) await prisma.payment.delete({ where: { id: paymentId } });
            if (driverCreated) await prisma.driver.delete({ where: { vehiclePlate: plate } });
            console.log(`AWAS: Rolled back driver + payment for ${plate}`);
        } catch (rollbackErr) {
            console.error('AWAS Rollback fault:', rollbackErr);
        }
        return res.status(500).json({ error: 'Ralat semasa mencipta bil pembayaran. Sila cuba lagi.' });
    }
};

// ─── TOYYIBPAY WEBHOOK ───────────────────────────────────────────────────────
// ToyyibPay sends multipart/form-data (confirmed from live logs + official docs).
// formidable parses the raw stream inside the handler, bypassing all global
// middleware stream-consumption issues. Per official docs:
//   order_id = our billExternalReferenceNo = our payment.id
//   status   = 1 success / 2 pending / 3 fail (FPX)
//   status_id = same (DuitNow QR)
//   refno    = ToyyibPay internal ref (not our ID)
exports.handleWebhook = async (req, res) => {
    try {
        // Parse multipart/form-data using formidable
        const form = formidable({});
        const body = await new Promise((resolve, reject) => {
            form.parse(req, (err, fields) => {
                if (err) return reject(err);
                // formidable v3 returns field values as arrays — flatten to strings
                const parsed = {};
                for (const key in fields) {
                    parsed[key] = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
                }
                resolve(parsed);
            });
        });

        console.log('AWAS Webhook Parsed body:', JSON.stringify(body));

        const order_id = body.order_id;
        const status = body.status || body.status_id;
        const billcode = body.billcode;
        const refno = body.refno;

        console.log(`AWAS Webhook: order_id=${order_id} status=${status} billcode=${billcode} refno=${refno}`);

        // Always return 200 to ToyyibPay immediately — prevents retries
        if (!order_id || !status) {
            console.error('AWAS Webhook: missing order_id or status.');
            return res.status(200).json({ message: 'Missing parameters — ignored.' });
        }

        const paymentId = parseInt(order_id);
        if (isNaN(paymentId)) {
            console.error(`AWAS Webhook: invalid order_id=${order_id}`);
            return res.status(200).json({ message: 'Invalid order_id — ignored.' });
        }

        const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
        if (!payment) {
            console.error(`AWAS Webhook: Payment not found for order_id=${order_id}`);
            return res.status(200).json({ message: 'Payment not found — ignored.' });
        }

        // Pending
        if (status === '2' || status === 2) {
            if (!payment.toyyibpayBillCode && billcode) {
                await prisma.payment.update({
                    where: { id: paymentId },
                    data: { toyyibpayBillCode: billcode }
                });
            }
            return res.status(200).json({ message: 'Payment pending.' });
        }

        // Failed
        if (status === '3' || status === 3) {
            await prisma.payment.update({
                where: { id: paymentId },
                data: { status: 'FAILED' }
            });
            return res.status(200).json({ message: 'Payment failed recorded.' });
        }

        // Success
        if (status === '1' || status === 1) {

            // Idempotency
            if (payment.status === 'PAID') {
                return res.status(200).json({ message: 'Already processed.' });
            }

            await prisma.payment.update({
                where: { id: paymentId },
                data: {
                    status: 'PAID',
                    paidAt: new Date(),
                    toyyibpayBillCode: billcode || payment.toyyibpayBillCode
                }
            });

            // REGISTRATION / RENEWAL — activate driver
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

            // WRIT — unlock paywall, user redirected to /writ/:writNumber page
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
                    console.log(`AWAS: Writ unlocked for ${payment.vehiclePlate} writNumber=${log.writNumber}`);
                }
            }

            return res.status(200).json({ message: 'Payment processed successfully.' });
        }

        return res.status(200).json({ message: 'Unknown status — ignored.' });

    } catch (err) {
        console.error('AWAS Webhook fault:', err);
        return res.status(200).json({ message: 'Webhook error logged.' });
    }
};

// ─── CREATE WRIT BILL (RM8) ──────────────────────────────────────────────────
// billReturnUrl uses PATH-based writNumber (not query string).
// ToyyibPay cannot strip path segments — only query strings get mangled.
// User lands on awas.asia/writ/AWAS-MY-2026-000048 after payment.
// That page fetches full writ data from BE if isReportPaid=true.
exports.createWritBill = async (req, res) => {
    try {
        const { vehiclePlate, logHash, writNumber } = req.body;

        if (!vehiclePlate || !logHash || !writNumber) {
            return res.status(400).json({ error: 'Nombor plat, log hash dan nombor writ diperlukan.' });
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

        // Path-based return URL — writNumber in path, not query string
        // e.g. https://awas.asia/writ/AWAS-MY-2026-000048
        const writSlug = writNumber.replace(/\//g, '-');
        const writReturnUrl = `${process.env.FE_URL}/writ/${writSlug}`;

        let billCode;
        try {
            billCode = await createToyyibpayBill({
                billName: `AWAS-WRIT-${plate}`,
                billDescription: `AWAS Digital Writ Report - ${logHash.substring(0, 8)}`,
                billAmount: WRIT_FEE,
                billExternalReferenceNo: payment.id,
                billTo: plate,
                billEmail: driver.email || '',
                billPhone: driver.phone || '',
                billReturnUrl: writReturnUrl
            });
        } catch (toyyibErr) {
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

        console.log(`AWAS: Writ bill created for ${plate} writNumber=${writNumber} returnUrl=${writReturnUrl}`);

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