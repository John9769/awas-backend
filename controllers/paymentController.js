// ==========================================
// FILE: controllers/paymentController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');
const { creditAffiliateEarning } = require('./affiliateController');

const REGISTRATION_FEE = 29.99;
const WRIT_FEE = 8.00;
const AFFILIATE_CUT = 4.99;
const TOYYIBPAY_BASE_URL = process.env.TOYYIBPAY_BASE_URL || 'https://toyyibpay.com';

// ─── HELPER: Create ToyyibPay Bill ───────────────────────────────────────────
const createToyyibpayBill = async ({ billName, billDescription, billAmount, billExternalReferenceNo, billTo, billEmail, billPhone }) => {
    const params = new URLSearchParams();
    params.append('userSecretKey', process.env.TOYYIBPAY_SECRET_KEY);
    params.append('categoryCode', process.env.TOYYIBPAY_CATEGORY_CODE);
    params.append('billName', billName);
    params.append('billDescription', billDescription);
    params.append('billPriceSetting', '1');         // fixed amount
    params.append('billPayorInfo', '1');             // collect payer info
    params.append('billAmount', String(Math.round(billAmount * 100))); // in cents
    params.append('billReturnUrl', `${process.env.FE_URL}/login.html?payment=success`);
    params.append('billCallbackUrl', `${process.env.BE_URL}/api/payment/webhook`);
    params.append('billExternalReferenceNo', String(billExternalReferenceNo));
    params.append('billTo', billTo || '');
    params.append('billEmail', billEmail || '');
    params.append('billPhone', billPhone || '');
    params.append('billSplitPayment', '0');
    params.append('billSplitPaymentArgs', '');
    params.append('billPaymentChannel', '0');        // FPX only
    params.append('billDisplayMerchant', '1');
    params.append('billContentEmail', 'Terima kasih kerana mendaftar AWAS. Langganan anda kini aktif.');
    params.append('billChargeToCustomer', '0');      // AWAS absorbs RM1 fee

    const response = await axios.post(
        `${TOYYIBPAY_BASE_URL}/index.php/api/createBill`,
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    // ToyyibPay returns array: [{ BillCode: 'xxxx', IsSuccess: '1', ... }]
    if (!response.data || !response.data[0] || !response.data[0].BillCode) {
        throw new Error(`ToyyibPay createBill failed: ${JSON.stringify(response.data)}`);
    }

    return response.data[0].BillCode;
};

// ─── CREATE REGISTRATION BILL ────────────────────────────────────────────────
exports.createRegistrationBill = async (req, res) => {
    try {
        const { vehiclePlate, referralCode } = req.body;

        if (!vehiclePlate) {
            return res.status(400).json({ error: 'Nombor plat diperlukan.' });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Akaun AWAS tidak dijumpai.' });
        }

        // Create pending payment record first to get paymentId
        const payment = await prisma.payment.create({
            data: {
                vehiclePlate: plate,
                amount: REGISTRATION_FEE,
                type: 'REGISTRATION',
                status: 'PENDING',
                referralCode: referralCode || null,
                affiliateCut: referralCode ? AFFILIATE_CUT : null
            }
        });

        // Create ToyyibPay bill using paymentId as external reference
        const billCode = await createToyyibpayBill({
            billName: `AWAS-REG-${plate}`,
            billDescription: `AWAS Annual Protection - ${plate}`,
            billAmount: REGISTRATION_FEE,
            billExternalReferenceNo: payment.id,
            billTo: plate,
            billEmail: '',
            billPhone: driver.phone || ''
        });

        // Update payment record with ToyyibPay bill code and URL
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
            amount: REGISTRATION_FEE
        });

    } catch (err) {
        console.error('Create registration bill fault:', err);
        return res.status(500).json({ error: 'Ralat semasa mencipta bil pembayaran.' });
    }
};

// ─── TOYYIBPAY WEBHOOK ───────────────────────────────────────────────────────
// ToyyibPay POSTs form-encoded data to this endpoint after payment
// status_id: 1 = success, 2 = pending, 3 = failed
exports.handleWebhook = async (req, res) => {
    try {
        const {
            refno,          // billExternalReferenceNo — our paymentId
            status_id,      // 1=success, 2=pending, 3=failed
            billcode,       // ToyyibPay bill code
            amount,         // amount in cents
            transaction_id  // ToyyibPay transaction ID
        } = req.body;

        console.log(`AWAS ToyyibPay Webhook: refno=${refno} status_id=${status_id} billcode=${billcode}`);

        if (!refno || !status_id) {
            return res.status(400).json({ error: 'Missing webhook parameters.' });
        }

        const paymentId = parseInt(refno);
        if (isNaN(paymentId)) {
            return res.status(400).json({ error: 'Invalid reference number.' });
        }

        const payment = await prisma.payment.findUnique({
            where: { id: paymentId }
        });

        if (!payment) {
            console.error(`AWAS Webhook: Payment not found for refno=${refno}`);
            return res.status(404).json({ error: 'Payment not found.' });
        }

        // Handle pending — update bill code if not set, do nothing else
        if (status_id === '2' || status_id === 2) {
            console.log(`AWAS Webhook: Payment pending for paymentId=${paymentId}`);
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
            console.log(`AWAS Webhook: Payment failed for paymentId=${paymentId}`);
            await prisma.payment.update({
                where: { id: paymentId },
                data: { status: 'FAILED' }
            });
            return res.status(200).json({ message: 'Payment failed recorded.' });
        }

        // Handle success (status_id === '1')
        if (status_id === '1' || status_id === 1) {

            // Idempotency — already processed
            if (payment.status === 'PAID') {
                console.log(`AWAS Webhook: Already processed paymentId=${paymentId}`);
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

            // Activate driver subscription — 1 year from now
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

            // Credit affiliate if referral was used
            if (payment.referralCode) {
                await creditAffiliateEarning(
                    payment.vehiclePlate,
                    payment.id,
                    payment.type
                );
            }

            return res.status(200).json({ message: 'Payment processed successfully.' });
        }

        // Unknown status
        console.warn(`AWAS Webhook: Unknown status_id=${status_id}`);
        return res.status(200).json({ message: 'Unknown status ignored.' });

    } catch (err) {
        console.error('AWAS Webhook fault:', err);
        return res.status(500).json({ error: 'Webhook processing error.' });
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

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Akaun AWAS tidak dijumpai.' });
        }

        // Create pending payment record
        const payment = await prisma.payment.create({
            data: {
                vehiclePlate: plate,
                amount: WRIT_FEE,
                type: 'WRIT',
                status: 'PENDING'
            }
        });

        // Create ToyyibPay bill for RM8 writ
        const billCode = await createToyyibpayBill({
            billName: `AWAS-WRIT-${plate}`,
            billDescription: `AWAS Digital Writ Report - ${logHash.substring(0, 8)}`,
            billAmount: WRIT_FEE,
            billExternalReferenceNo: payment.id,
            billTo: plate,
            billEmail: '',
            billPhone: driver.phone || ''
        });

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