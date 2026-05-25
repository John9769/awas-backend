// ==========================================
// FILE: controllers/paymentController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { creditAffiliateEarning } = require('./affiliateController');

const REGISTRATION_FEE = 29.99;
const WRIT_FEE = 8.00;
const AFFILIATE_CUT = 9.99;

// CREATE REGISTRATION BILL (Billplz)
exports.createRegistrationBill = async (req, res) => {
    try {
        const { vehiclePlate, referralCode } = req.body;
        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Driver not found.' });
        }

        // Create payment record
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

        // TODO: Create Billplz bill here
        // const bill = await createBillplzBill({
        //     collection_id: process.env.BILLPLZ_COLLECTION_ID,
        //     email: driver.phone ? `${driver.phone}@awas.my` : 'user@awas.my',
        //     mobile: driver.phone,
        //     name: driver.vehiclePlate,
        //     amount: Math.round(REGISTRATION_FEE * 100), // in cents
        //     description: `AWAS Annual Protection - ${plate}`,
        //     callback_url: `${process.env.BE_URL}/api/payment/webhook`,
        //     redirect_url: `${process.env.FE_URL}/register.html?payment=success`
        // });

        return res.status(201).json({
            paymentId: payment.id,
            amount: REGISTRATION_FEE,
            message: 'Payment record created. Awaiting Billplz integration.',
            // billplzUrl: bill.url  // uncomment after Billplz setup
        });

    } catch (err) {
        console.error('Create bill fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// BILLPLZ WEBHOOK — called by Billplz after payment confirmed
exports.handleWebhook = async (req, res) => {
    try {
        const { id, paid, paid_at } = req.body;

        if (!paid || paid !== 'true') {
            return res.status(200).json({ message: 'Payment not confirmed yet.' });
        }

        // Find payment by Billplz bill ID
        const payment = await prisma.payment.findUnique({
            where: { billplzBillId: id }
        });

        if (!payment) {
            return res.status(404).json({ error: 'Payment not found.' });
        }

        if (payment.status === 'PAID') {
            return res.status(200).json({ message: 'Already processed.' });
        }

        // Mark payment as paid
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                status: 'PAID',
                paidAt: new Date(paid_at)
            }
        });

        // Activate driver subscription
        const expiryDate = new Date();
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);

        await prisma.driver.update({
            where: { vehiclePlate: payment.vehiclePlate },
            data: {
                subStatus: 'ACTIVE',
                subExpiresAt: expiryDate
            }
        });

        // Credit affiliate if referral was used
        if (payment.referralCode) {
            await creditAffiliateEarning(
                payment.vehiclePlate,
                payment.id,
                payment.type
            );
        }

        return res.status(200).json({ message: 'Payment processed successfully.' });

    } catch (err) {
        console.error('Webhook fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// CREATE WRIT PAYMENT BILL (RM8)
exports.createWritBill = async (req, res) => {
    try {
        const { vehiclePlate } = req.body;
        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Driver not found.' });
        }

        const payment = await prisma.payment.create({
            data: {
                vehiclePlate: plate,
                amount: WRIT_FEE,
                type: 'WRIT',
                status: 'PENDING'
            }
        });

        // TODO: Create Billplz bill for RM8
        // No affiliate cut for writ payments

        return res.status(201).json({
            paymentId: payment.id,
            amount: WRIT_FEE,
            message: 'Writ payment record created. Awaiting Billplz integration.'
        });

    } catch (err) {
        console.error('Writ bill fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// GET PAYMENT STATUS
exports.getPaymentStatus = async (req, res) => {
    try {
        const { paymentId } = req.params;

        const payment = await prisma.payment.findUnique({
            where: { id: parseInt(paymentId) }
        });

        if (!payment) {
            return res.status(404).json({ error: 'Payment not found.' });
        }

        return res.status(200).json({
            status: payment.status,
            amount: parseFloat(payment.amount),
            type: payment.type,
            paidAt: payment.paidAt
        });

    } catch (err) {
        console.error('Payment status fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};