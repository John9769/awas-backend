// ==========================================
// FILE: controllers/affiliateController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const AFFILIATE_CUT = 4.99;
const PAYOUT_THRESHOLD = 49.90;

// BECOME AFFILIATE
exports.joinAffiliate = async (req, res) => {
    try {
        const plate = req.institution.plate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            include: { affiliate: true }
        });

        if (!driver) {
            return res.status(404).json({ error: 'Driver not found.' });
        }
        if (driver.subStatus !== 'ACTIVE') {
            return res.status(403).json({ error: 'Your AWAS subscription must be active to become an affiliate.' });
        }
        if (driver.affiliate) {
            return res.status(200).json({
                message: 'Already an affiliate.',
                referralCode: driver.affiliate.referralCode,
                referralLink: `https://awas.asia/register.html?ref=${driver.affiliate.referralCode}`
            });
        }

        const affiliate = await prisma.affiliate.create({
            data: {
                driverId: driver.id,
                referralCode: driver.referralCode
            }
        });

        return res.status(201).json({
            message: 'Selamat datang ke AWAS Affiliate Program!',
            referralCode: affiliate.referralCode,
            referralLink: `https://awas.asia/register.html?ref=${affiliate.referralCode}`,
            commissionPerReferral: `RM${AFFILIATE_CUT}`,
            payoutThreshold: `RM${PAYOUT_THRESHOLD}`,
            note: 'Kongsi pautan anda. Setiap pendaftaran menjana RM4.99 untuk anda — termasuk pembaharuan setiap tahun. Bayaran dibuat setiap 15 dan 30 hab apabila mencapai RM49.90.'
        });

    } catch (err) {
        console.error('Affiliate join fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// GET AFFILIATE DASHBOARD
exports.getDashboard = async (req, res) => {
    try {
        const plate = req.institution.plate.toUpperCase().replace(/\s+/g, '');

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
            return res.status(404).json({ error: 'Not an affiliate yet.', reason: 'NOT_AFFILIATE' });
        }

        const affiliate = driver.affiliate;
        const pending = parseFloat(affiliate.pendingPayout);
        const payoutDue = pending >= PAYOUT_THRESHOLD;

        return res.status(200).json({
            referralCode: affiliate.referralCode,
            referralLink: `https://awas.asia/register.html?ref=${affiliate.referralCode}`,
            stats: {
                totalReferrals: affiliate.totalReferrals,
                totalEarnings: parseFloat(affiliate.totalEarnings),
                pendingPayout: pending,
                paidOut: parseFloat(affiliate.paidOut),
                payoutDue,
                payoutThreshold: PAYOUT_THRESHOLD,
                nextPayoutDates: 'Setiap 15 dan 30 hab bulan'
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
        const plate = req.institution.plate.toUpperCase().replace(/\s+/g, '');
        const { bankName, bankAccountNumber, bankAccountName, duitnowNumber } = req.body;

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

        return res.status(200).json({ message: 'Butiran bank berjaya dikemaskini.' });

    } catch (err) {
        console.error('Bank update fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// CREDIT AFFILIATE EARNING (called internally after payment confirmed)
exports.creditAffiliateEarning = async (vehiclePlate, paymentId, paymentType) => {
    try {
        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate }
        });

        if (!driver || !driver.referredByCode) return;

        const referrerDriver = await prisma.driver.findUnique({
            where: { referralCode: driver.referredByCode },
            include: { affiliate: true }
        });

        if (!referrerDriver || !referrerDriver.affiliate) return;
        if (!referrerDriver.affiliate.isActive) return;

        const affiliate = referrerDriver.affiliate;

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