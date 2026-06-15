// ==========================================
// FILE: controllers/adminController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const axios = require('axios');

const PAYOUT_THRESHOLD = 49.90;

// ─── HELPER: Get current payout cycle date range ─────────────────────────────
// 1st–14th → pay on 15th (cycleStart=1st, cycleEnd=14th)
// 15th–29th → pay on 30th (cycleStart=15th, cycleEnd=29th)
// 30th–31st → carry to next month 15th (cycleStart=30th prev month, cycleEnd=31st prev month)
function getCurrentCycleDateRange() {
    const now = new Date();
    const day = now.getDate();
    const year = now.getFullYear();
    const month = now.getMonth();

    let cycleStart, cycleEnd;

    if (day <= 14) {
        // Processing on 15th — cover 1st to 14th
        cycleStart = new Date(year, month, 1, 0, 0, 0, 0);
        cycleEnd = new Date(year, month, 14, 23, 59, 59, 999);
    } else if (day <= 29) {
        // Processing on 30th — cover 15th to 29th
        cycleStart = new Date(year, month, 15, 0, 0, 0, 0);
        cycleEnd = new Date(year, month, 29, 23, 59, 59, 999);
    } else {
        // Processing after 29th — 30th/31st carry to next cycle
        // Show earnings from 15th to 29th of current month (for 30th payout)
        cycleStart = new Date(year, month, 15, 0, 0, 0, 0);
        cycleEnd = new Date(year, month, 29, 23, 59, 59, 999);
    }

    return { cycleStart, cycleEnd };
}

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
            videos: { verified: videosVerified, failed: videosFailed },
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
                referralCode: true, referredByCode: true, phone: true,
                email: true, createdAt: true
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
                videoStatus: true, videoHash: true, rawVideoUrl: true,
                videoSealedAt: true, logHash: true, createdAt: true,
                otherVehiclePlate: true, isReportPaid: true
            }
        });
        res.status(200).json({ count: writs.length, writs });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch writs.' });
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

// ALL AFFILIATES — full details including due and not due
exports.getAffiliates = async (req, res) => {
    try {
        const affiliates = await prisma.affiliate.findMany({
            orderBy: { pendingPayout: 'desc' },
            select: {
                id: true, referralCode: true, totalReferrals: true,
                totalEarnings: true, pendingPayout: true, paidOut: true,
                bankName: true, bankAccountNumber: true, bankAccountName: true,
                duitnowNumber: true, isActive: true, joinedAt: true,
                driver: { select: { vehiclePlate: true, phone: true } },
                earnings: {
                    where: { isPaid: false },
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true, referredPlate: true, amount: true,
                        type: true, createdAt: true
                    }
                },
                payouts: {
                    orderBy: { createdAt: 'desc' },
                    take: 5,
                    select: {
                        id: true, amount: true, status: true,
                        method: true, reference: true,
                        cycleStart: true, cycleEnd: true, processedAt: true
                    }
                }
            }
        });

        const affiliatesWithFlag = affiliates.map(a => ({
            affiliateId: a.id,
            referralCode: a.referralCode,
            vehiclePlate: a.driver.vehiclePlate,
            phone: a.driver.phone,
            bankName: a.bankName,
            bankAccountNumber: a.bankAccountNumber,
            bankAccountName: a.bankAccountName,
            duitnowNumber: a.duitnowNumber,
            isActive: a.isActive,
            joinedAt: a.joinedAt,
            stats: {
                totalReferrals: a.totalReferrals,
                totalEarnings: parseFloat(a.totalEarnings),
                pendingPayout: parseFloat(a.pendingPayout),
                paidOut: parseFloat(a.paidOut),
                payoutDue: parseFloat(a.pendingPayout) >= PAYOUT_THRESHOLD
            },
            unpaidEarnings: a.earnings,
            recentPayouts: a.payouts
        }));

        res.status(200).json({ count: affiliates.length, affiliates: affiliatesWithFlag });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch affiliates.' });
    }
};

// PAYOUT DUE LIST — affiliates qualifying for current payment cycle
// Filters earnings by current cycle date range
// 1st–14th → processes on 15th
// 15th–29th → processes on 30th
// 30th–31st → carry to next month 15th
exports.getPayoutDue = async (req, res) => {
    try {
        const { cycleStart, cycleEnd } = getCurrentCycleDateRange();

        // Get all active affiliates
        const allAffiliates = await prisma.affiliate.findMany({
            where: { isActive: true },
            select: {
                id: true, referralCode: true, totalReferrals: true,
                pendingPayout: true,
                bankName: true, bankAccountNumber: true,
                bankAccountName: true, duitnowNumber: true,
                joinedAt: true,
                driver: { select: { vehiclePlate: true, phone: true } },
                earnings: {
                    where: {
                        isPaid: false,
                        createdAt: {
                            gte: cycleStart,
                            lte: cycleEnd
                        }
                    },
                    select: {
                        id: true, referredPlate: true,
                        amount: true, type: true, createdAt: true
                    }
                }
            }
        });

        // Calculate cycle earnings per affiliate
        // Qualify only if total pendingPayout >= threshold (includes carry-forward)
        const payoutList = allAffiliates
            .filter(a => parseFloat(a.pendingPayout) >= PAYOUT_THRESHOLD)
            .map(a => ({
                affiliateId: a.id,
                referralCode: a.referralCode,
                vehiclePlate: a.driver.vehiclePlate,
                phone: a.driver.phone,
                totalReferrals: a.totalReferrals,
                amountDue: parseFloat(a.pendingPayout),
                cycleEarnings: a.earnings.reduce((sum, e) => sum + parseFloat(e.amount), 0),
                bankName: a.bankName,
                bankAccountNumber: a.bankAccountNumber,
                bankAccountName: a.bankAccountName,
                duitnowNumber: a.duitnowNumber,
                cycleUnpaidEarnings: a.earnings,
                joinedAt: a.joinedAt
            }))
            .sort((a, b) => b.amountDue - a.amountDue);

        res.status(200).json({
            count: payoutList.length,
            cycleStart,
            cycleEnd,
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

        const { cycleStart, cycleEnd } = getCurrentCycleDateRange();

        // Create payout record with cycle dates
        await prisma.affiliatePayout.create({
            data: {
                affiliateId: parseInt(affiliateId),
                amount: payoutAmount,
                status: 'PAID',
                method: affiliate.duitnowNumber ? 'DuitNow' : 'IBG',
                reference: reference || null,
                cycleStart,
                cycleEnd,
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

        console.log(`AWAS Admin: Payout RM${payoutAmount} marked done for affiliate ${affiliateId}. Cycle: ${cycleStart.toDateString()} - ${cycleEnd.toDateString()}`);

        return res.status(200).json({
            message: `Payout RM${payoutAmount.toFixed(2)} marked as paid for affiliate ${affiliateId}.`,
            reference: reference || null,
            cycleStart,
            cycleEnd
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
                accidentLog: { select: { writNumber: true, vehiclePlate: true, rawVideoUrl: true } }
            }
        });
        res.status(200).json({ count: requests.length, requests });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch verification requests.' });
    }
};

// TRIGGER CONSENT — admin sends consent email to driver
exports.triggerConsent = async (req, res) => {
    try {
        const { ticketId } = req.body;

        if (!ticketId) {
            return res.status(400).json({ error: 'ticketId required.' });
        }

        const ticket = await prisma.verificationRequest.findUnique({
            where: { id: parseInt(ticketId) },
            include: {
                accidentLog: {
                    include: { driver: true }
                },
                institutionalUser: true
            }
        });

        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found.' });
        }

        if (ticket.approvalStatus !== 'PENDING') {
            return res.status(409).json({ error: `Ticket already ${ticket.approvalStatus}.` });
        }

        if (!ticket.consentToken) {
            return res.status(400).json({ error: 'No consent token on this ticket.' });
        }

        const driver = ticket.accidentLog.driver;

        if (!driver.email) {
            return res.status(400).json({ error: 'Driver has no email address on record.' });
        }

        const approveUrl = `${process.env.BE_URL}/api/institutions/consent/${ticket.consentToken}/approve`;
        const rejectUrl = `${process.env.BE_URL}/api/institutions/consent/${ticket.consentToken}/reject`;

        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);

        await resend.emails.send({
            from: 'AWAS <hello@awas.asia>',
            to: driver.email,
            subject: `[AWAS] Permintaan Akses Bukti Kemalangan Anda`,
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
                <h2 style="color:#0f172a;">Permintaan Akses Bukti Kemalangan</h2>
                <p>Syarikat berikut meminta akses kepada bukti kemalangan anda dalam sistem AWAS:</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                    <tr><td style="padding:8px;color:#64748b;font-weight:600;">Syarikat</td><td style="padding:8px;">${ticket.companyName}</td></tr>
                    <tr><td style="padding:8px;color:#64748b;font-weight:600;">Jenis</td><td style="padding:8px;">${ticket.requesterType === 'INSURANCE' ? 'Syarikat Insurans' : 'Peguam'}</td></tr>
                    <tr><td style="padding:8px;color:#64748b;font-weight:600;">Nombor Kes</td><td style="padding:8px;">${ticket.caseReferenceNo}</td></tr>
                    <tr><td style="padding:8px;color:#64748b;font-weight:600;">Writ</td><td style="padding:8px;">${ticket.accidentLog.writNumber}</td></tr>
                </table>
                <p>Mereka ingin mengesahkan keaslian video dan gambar bukti anda. Sila pilih:</p>
                <div style="margin:24px 0;">
                    <a href="${approveUrl}" style="background:#16a34a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin-right:12px;">✅ SAYA BERSETUJU</a>
                    <a href="${rejectUrl}" style="background:#dc2626;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">❌ SAYA TIDAK BERSETUJU</a>
                </div>
                <p style="font-size:0.8rem;color:#64748b;">Keputusan anda akan direkodkan dalam pelayan AWAS dan dilindungi oleh Akta Perlindungan Data Peribadi (PDPA). Jika anda tidak membuat sebarang pilihan, permintaan ini akan tamat tempoh dalam 7 hari.</p>
                </div>
            `
        });

        console.log(`AWAS Admin: Consent email sent to ${driver.email} for ticket ${ticketId}`);

        return res.status(200).json({
            message: `Consent email dihantar kepada ${driver.email}.`,
            ticketId: ticket.id
        });

    } catch (error) {
        console.error('AWAS triggerConsent Fault:', error);
        return res.status(500).json({ error: 'Failed to send consent email.' });
    }
};