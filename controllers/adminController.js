// ==========================================
// FILE: controllers/adminController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');

const PAYOUT_THRESHOLD = 49.90;

// DASHBOARD STATS
exports.getDashboard = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        const [
            totalDrivers,
            newDriversToday,
            newDriversMonth,
            totalLogs,
            newLogsToday,
            videosPending,
            videosVerified,
            videosFailed,
            pendingInstitutions,
            totalInstitutions,
            pendingConsents,
            totalPayments,
            totalAffiliate,
            payoutDueCount
        ] = await Promise.all([
            prisma.driver.count(),
            prisma.driver.count({ where: { createdAt: { gte: today } } }),
            prisma.driver.count({ where: { createdAt: { gte: thisMonth } } }),
            prisma.accidentLog.count(),
            prisma.accidentLog.count({ where: { createdAt: { gte: today } } }),
            prisma.accidentLog.count({ where: { videoStatus: 'PENDING' } }),
            prisma.accidentLog.count({ where: { videoStatus: 'VERIFIED' } }),
            prisma.accidentLog.count({ where: { videoStatus: 'FAILED' } }),
            prisma.institutionalUser.count({ where: { isApproved: false } }),
            prisma.institutionalUser.count(),
            prisma.verificationRequest.count({ where: { approvalStatus: 'PENDING' } }),
            prisma.payment.aggregate({ where: { status: 'PAID' }, _sum: { amount: true } }),
            prisma.affiliateEarning.aggregate({ _sum: { amount: true } }),
            prisma.affiliate.count({ where: { pendingPayout: { gte: PAYOUT_THRESHOLD }, isActive: true } })
        ]);

        res.status(200).json({
            totalDrivers, newDriversToday, newDriversMonth,
            totalLogs, newLogsToday,
            videos: { pending: videosPending, verified: videosVerified, failed: videosFailed },
            pendingInstitutions, totalInstitutions, pendingConsents,
            totalRevenue: parseFloat(totalPayments._sum.amount || 0),
            totalAffiliateEarnings: parseFloat(totalAffiliate._sum.amount || 0),
            payoutDueCount
        });

    } catch (error) {
        console.error('AWAS Admin Dashboard Fault:', error);
        res.status(500).json({ error: 'Dashboard fetch error.' });
    }
};

// ALL USERS
exports.getUsers = async (req, res) => {
    try {
        const users = await prisma.driver.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, vehiclePlate: true, vehicleMakeModel: true,
                vehicleType: true, subStatus: true, subExpiresAt: true,
                referralCode: true, referredByCode: true, phone: true, createdAt: true
            }
        });
        res.status(200).json({ count: users.length, users });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users.' });
    }
};

// ALL WRITS
exports.getWrits = async (req, res) => {
    try {
        const writs = await prisma.accidentLog.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, writNumber: true, vehiclePlate: true,
                latitude: true, longitude: true,
                roadCondition: true, weatherCondition: true, injuryStatus: true,
                videoStatus: true, videoHash: true, sealedVideoUrl: true, rawVideoUrl: true,
                videoSealedAt: true, logHash: true, createdAt: true,
                otherVehiclePlate: true, isReportPaid: true
            }
        });
        res.status(200).json({ count: writs.length, writs });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch writs.' });
    }
};

// STREAM SEALED VIDEO
exports.streamVideo = async (req, res) => {
    try {
        const { logHash } = req.params;
        const { key } = req.query;

        if (key !== process.env.ADMIN_KEY) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }

        const log = await prisma.accidentLog.findUnique({
            where: { logHash },
            select: { sealedVideoUrl: true, videoStatus: true }
        });

        if (!log || !log.sealedVideoUrl) {
            return res.status(404).json({ error: 'Sealed video not found.' });
        }

        const rangeHeader = req.headers['range'];
        const axiosConfig = { responseType: 'stream', headers: {} };
        if (rangeHeader) axiosConfig.headers['Range'] = rangeHeader;

        const response = await axios.get(log.sealedVideoUrl, axiosConfig);

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Content-Disposition', `inline; filename="awas-sealed-${logHash.substring(0, 8)}.mp4"`);
        if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        res.setHeader('Accept-Ranges', 'bytes');
        res.status(response.status);
        response.data.pipe(res);

    } catch (error) {
        console.error('AWAS Video Stream Fault:', error);
        res.status(500).json({ error: 'Video stream failed.' });
    }
};

// ALL PAYMENTS + AFFILIATE EARNINGS
exports.getPayments = async (req, res) => {
    try {
        const payments = await prisma.payment.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, vehiclePlate: true, amount: true,
                type: true, status: true, paidAt: true,
                referralCode: true, affiliateCut: true,
                toyyibpayBillCode: true, createdAt: true
            }
        });

        const earnings = await prisma.affiliateEarning.findMany({
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
                id: true, referredPlate: true, amount: true,
                type: true, isPaid: true, createdAt: true,
                affiliate: { select: { referralCode: true, bankAccountName: true } }
            }
        });

        res.status(200).json({ payments, affiliateEarnings: earnings });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch payments.' });
    }
};

// ALL AFFILIATES
exports.getAffiliates = async (req, res) => {
    try {
        const affiliates = await prisma.affiliate.findMany({
            orderBy: { joinedAt: 'desc' },
            select: {
                id: true, referralCode: true, totalReferrals: true,
                totalEarnings: true, pendingPayout: true, paidOut: true,
                bankName: true, bankAccountNumber: true, bankAccountName: true,
                duitnowNumber: true, isActive: true, joinedAt: true,
                driver: { select: { vehiclePlate: true, phone: true } }
            }
        });

        // Flag payout due
        const affiliatesWithFlag = affiliates.map(a => ({
            ...a,
            totalEarnings: parseFloat(a.totalEarnings),
            pendingPayout: parseFloat(a.pendingPayout),
            paidOut: parseFloat(a.paidOut),
            payoutDue: parseFloat(a.pendingPayout) >= PAYOUT_THRESHOLD
        }));

        res.status(200).json({ count: affiliates.length, affiliates: affiliatesWithFlag });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch affiliates.' });
    }
};

// PAYOUT DUE LIST — admin uses this to action iRakyat payments
// Shows only affiliates who hit RM49.90 threshold
// Contains all bank details needed for iRakyat transfer in one view
exports.getPayoutDue = async (req, res) => {
    try {
        const affiliatesDue = await prisma.affiliate.findMany({
            where: {
                pendingPayout: { gte: PAYOUT_THRESHOLD },
                isActive: true
            },
            orderBy: { pendingPayout: 'desc' },
            select: {
                id: true, referralCode: true,
                totalReferrals: true, pendingPayout: true,
                bankName: true, bankAccountNumber: true,
                bankAccountName: true, duitnowNumber: true,
                joinedAt: true,
                driver: { select: { vehiclePlate: true, phone: true } },
                earnings: {
                    where: { isPaid: false },
                    select: {
                        id: true, referredPlate: true,
                        amount: true, type: true, createdAt: true
                    }
                }
            }
        });

        const payoutList = affiliatesDue.map(a => ({
            affiliateId: a.id,
            referralCode: a.referralCode,
            vehiclePlate: a.driver.vehiclePlate,
            phone: a.driver.phone,
            totalReferrals: a.totalReferrals,
            amountDue: parseFloat(a.pendingPayout),
            bankName: a.bankName,
            bankAccountNumber: a.bankAccountNumber,
            bankAccountName: a.bankAccountName,
            duitnowNumber: a.duitnowNumber,
            unpaidEarnings: a.earnings,
            joinedAt: a.joinedAt
        }));

        res.status(200).json({
            count: payoutList.length,
            totalPayoutAmount: payoutList.reduce((sum, a) => sum + a.amountDue, 0).toFixed(2),
            payoutDates: 'Every 15th and 30th of the month',
            payouts: payoutList
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch payout due list.' });
    }
};

// MARK PAYOUT DONE — admin calls this after iRakyat transfer completed
exports.markPayoutDone = async (req, res) => {
    try {
        const { affiliateId, reference } = req.body;

        if (!affiliateId) {
            return res.status(400).json({ error: 'affiliateId required.' });
        }

        const affiliate = await prisma.affiliate.findUnique({
            where: { id: parseInt(affiliateId) }
        });

        if (!affiliate) {
            return res.status(404).json({ error: 'Affiliate not found.' });
        }

        const payoutAmount = parseFloat(affiliate.pendingPayout);

        if (payoutAmount < PAYOUT_THRESHOLD) {
            return res.status(400).json({ error: `Pending payout RM${payoutAmount} below threshold RM${PAYOUT_THRESHOLD}.` });
        }

        // Create payout record
        await prisma.affiliatePayout.create({
            data: {
                affiliateId: parseInt(affiliateId),
                amount: payoutAmount,
                status: 'PAID',
                method: affiliate.duitnowNumber ? 'DuitNow' : 'IBG',
                reference: reference || null,
                processedAt: new Date()
            }
        });

        // Mark all unpaid earnings as paid
        await prisma.affiliateEarning.updateMany({
            where: { affiliateId: parseInt(affiliateId), isPaid: false },
            data: { isPaid: true }
        });

        // Reset pending payout, increment paidOut
        await prisma.affiliate.update({
            where: { id: parseInt(affiliateId) },
            data: {
                pendingPayout: 0,
                paidOut: { increment: payoutAmount }
            }
        });

        console.log(`AWAS Admin: Payout RM${payoutAmount} marked done for affiliate ${affiliateId}`);

        return res.status(200).json({
            message: `Payout RM${payoutAmount.toFixed(2)} marked as paid for affiliate ${affiliateId}.`,
            reference: reference || null
        });

    } catch (error) {
        console.error('Mark payout done fault:', error);
        res.status(500).json({ error: 'Failed to mark payout done.' });
    }
};

// INSTITUTIONS
exports.getPendingInstitutions = async (req, res) => {
    try {
        const pending = await prisma.institutionalUser.findMany({
            where: { isApproved: false },
            select: { id: true, email: true, companyName: true, requesterType: true, licenseId: true, createdAt: true }
        });
        res.status(200).json({ count: pending.length, institutions: pending });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pending institutions.' });
    }
};

exports.getAllInstitutions = async (req, res) => {
    try {
        const all = await prisma.institutionalUser.findMany({
            select: { id: true, email: true, companyName: true, requesterType: true, licenseId: true, isApproved: true, createdAt: true }
        });
        res.status(200).json({ count: all.length, institutions: all });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch institutions.' });
    }
};

exports.approveInstitution = async (req, res) => {
    try {
        const { id } = req.params;
        const user = await prisma.institutionalUser.findUnique({ where: { id: parseInt(id) } });
        if (!user) return res.status(404).json({ error: 'Institution not found.' });
        if (user.isApproved) return res.status(409).json({ error: 'Already approved.' });
        const approved = await prisma.institutionalUser.update({ where: { id: parseInt(id) }, data: { isApproved: true } });
        res.status(200).json({ message: `${approved.companyName} approved.`, id: approved.id, isApproved: approved.isApproved });
    } catch (error) {
        res.status(500).json({ error: 'Approval processing error.' });
    }
};

exports.revokeInstitution = async (req, res) => {
    try {
        const { id } = req.params;
        const revoked = await prisma.institutionalUser.update({ where: { id: parseInt(id) }, data: { isApproved: false } });
        res.status(200).json({ message: `${revoked.companyName} access revoked.` });
    } catch (error) {
        res.status(500).json({ error: 'Revoke processing error.' });
    }
};

// VERIFICATION REQUESTS
exports.getVerificationRequests = async (req, res) => {
    try {
        const requests = await prisma.verificationRequest.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, logHash: true, companyName: true,
                requesterType: true, caseReferenceNo: true,
                approvalStatus: true, driverApprovedAt: true,
                isPaymentSettled: true, createdAt: true,
                accidentLog: { select: { writNumber: true, vehiclePlate: true, sealedVideoUrl: true } }
            }
        });
        res.status(200).json({ count: requests.length, requests });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch verification requests.' });
    }
};