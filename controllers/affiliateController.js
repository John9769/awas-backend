// ==========================================
// FILE: controllers/affiliateController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const AFFILIATE_CUT = 4.99;

// BECOME AFFILIATE
// Any active registered driver can become an affiliate
exports.joinAffiliate = async (req, res) => {
    try {
        const { vehiclePlate, bankName, bankAccountNumber, bankAccountName, duitnowNumber } = req.body;

        if (!vehiclePlate) {
            return res.status(400).json({ error: 'Vehicle plate required.' });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        // Check driver exists and is active
        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            include: { affiliate: true }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Driver not found. Please register first.' });
        }
        if (driver.subStatus !== 'ACTIVE') {
            return res.status(403).json({ error: 'Your AWAS subscription must be active to become an affiliate.' });
        }
        if (driver.affiliate) {
            return res.status(200).json({
                message: 'Already an affiliate.',
                referralCode: driver.affiliate.referralCode,
                referralLink: `https://awas-pwa.vercel.app/register.html?ref=${driver.affiliate.referralCode}`
            });
        }

        // Create affiliate record
        const affiliate = await prisma.affiliate.create({
            data: {
                driverId: driver.id,
                referralCode: driver.referralCode,
                bankName: bankName || null,
                bankAccountNumber: bankAccountNumber || null,
                bankAccountName: bankAccountName || null,
                duitnowNumber: duitnowNumber || null
            }
        });

        return res.status(201).json({
            message: 'Selamat datang ke AWAS Affiliate Program!',
            referralCode: affiliate.referralCode,
            referralLink: `https://awas-pwa.vercel.app/register.html?ref=${affiliate.referralCode}`,
            commissionPerReferral: `RM${AFFILIATE_CUT}`,
            note: 'Share your link. Every registration earns you RM4.99 — including renewals every year.'
        });

    } catch (err) {
        console.error('Affiliate join fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// GET AFFILIATE DASHBOARD
exports.getDashboard = async (req, res) => {
    try {
        const { vehiclePlate } = req.params;
        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            include: {
                affiliate: {
                    include: {
                        earnings: {
                            orderBy: { createdAt: 'desc' },
                            take: 20,
                            include: { payment: true }
                        },
                        payouts: {
                            orderBy: { createdAt: 'desc' },
                            take: 10
                        }
                    }
                }
            }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Driver not found.' });
        }
        if (!driver.affiliate) {
            return res.status(404).json({ error: 'Not an affiliate yet. Join the program first.' });
        }

        const affiliate = driver.affiliate;

        return res.status(200).json({
            referralCode: affiliate.referralCode,
            referralLink: `https://awas-pwa.vercel.app/register.html?ref=${affiliate.referralCode}`,
            stats: {
                totalReferrals: affiliate.totalReferrals,
                totalEarnings: parseFloat(affiliate.totalEarnings),
                pendingPayout: parseFloat(affiliate.pendingPayout),
                paidOut: parseFloat(affiliate.paidOut)
            },
            recentEarnings: affiliate.earnings.map(e => ({
                date: e.createdAt,
                referredPlate: e.referredPlate,
                amount: parseFloat(e.amount),
                type: e.type,
                isPaid: e.isPaid
            })),
            payouts: affiliate.payouts.map(p => ({
                date: p.createdAt,
                amount: parseFloat(p.amount),
                status: p.status,
                method: p.method,
                reference: p.reference
            })),
            bankDetails: {
                bankName: affiliate.bankName,
                bankAccountNumber: affiliate.bankAccountNumber,
                bankAccountName: affiliate.bankAccountName,
                duitnowNumber: affiliate.duitnowNumber
            }
        });

    } catch (err) {
        console.error('Affiliate dashboard fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// UPDATE BANK DETAILS
exports.updateBankDetails = async (req, res) => {
    try {
        const { vehiclePlate, bankName, bankAccountNumber, bankAccountName, duitnowNumber } = req.body;
        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            include: { affiliate: true }
        });

        if (!driver || !driver.affiliate) {
            return res.status(404).json({ error: 'Affiliate not found.' });
        }

        await prisma.affiliate.update({
            where: { id: driver.affiliate.id },
            data: { bankName, bankAccountNumber, bankAccountName, duitnowNumber }
        });

        return res.status(200).json({ message: 'Bank details updated successfully.' });

    } catch (err) {
        console.error('Bank update fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// REQUEST PAYOUT
exports.requestPayout = async (req, res) => {
    try {
        const { vehiclePlate } = req.body;
        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            include: { affiliate: true }
        });

        if (!driver || !driver.affiliate) {
            return res.status(404).json({ error: 'Affiliate not found.' });
        }

        const affiliate = driver.affiliate;
        const pending = parseFloat(affiliate.pendingPayout);

        if (pending < 10) {
            return res.status(400).json({
                error: `Minimum payout is RM10. Your pending balance is RM${pending.toFixed(2)}.`
            });
        }
        if (!affiliate.bankAccountNumber && !affiliate.duitnowNumber) {
            return res.status(400).json({
                error: 'Please add your bank account or DuitNow number before requesting payout.'
            });
        }

        // Create payout request
        const payout = await prisma.affillatePayout.create({
            data: {
                affiliateId: affiliate.id,
                amount: pending,
                status: 'PENDING',
                method: affiliate.duitnowNumber ? 'DuitNow' : 'IBG'
            }
        });

        // Reset pending payout
        await prisma.affiliate.update({
            where: { id: affiliate.id },
            data: { pendingPayout: 0 }
        });

        return res.status(201).json({
            message: `Payout request of RM${pending.toFixed(2)} submitted. Processing within 3 working days.`,
            payoutId: payout.id
        });

    } catch (err) {
        console.error('Payout request fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// CREDIT AFFILIATE EARNING (called internally after payment confirmed)
exports.creditAffiliateEarning = async (vehiclePlate, paymentId, paymentType) => {
    try {
        // Find which affiliate referred this driver
        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate }
        });

        if (!driver || !driver.referredByCode) return;

        // Find the affiliate
        const referrerDriver = await prisma.driver.findUnique({
            where: { referralCode: driver.referredByCode },
            include: { affiliate: true }
        });

        if (!referrerDriver || !referrerDriver.affiliate) return;
        if (!referrerDriver.affiliate.isActive) return;

        const affiliate = referrerDriver.affiliate;

        // Create earning record
        await prisma.affiliateEarning.create({
            data: {
                affiliateId: affiliate.id,
                paymentId,
                referredPlate: vehiclePlate,
                amount: AFFILIATE_CUT,
                type: paymentType,
                isPaid: false
            }
        });

        // Update affiliate totals
        await prisma.affiliate.update({
            where: { id: affiliate.id },
            data: {
                totalReferrals: paymentType === 'REGISTRATION' ? { increment: 1 } : undefined,
                totalEarnings: { increment: AFFILIATE_CUT },
                pendingPayout: { increment: AFFILIATE_CUT }
            }
        });

        console.log(`Affiliate earning credited: RM${AFFILIATE_CUT} to ${referrerDriver.vehiclePlate} for referring ${vehiclePlate}`);

    } catch (err) {
        console.error('Credit affiliate earning fault:', err);
    }
};