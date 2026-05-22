const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// GET all pending institutions
exports.getPendingInstitutions = async (req, res) => {
    try {
        const pending = await prisma.institutionalUser.findMany({
            where: { isApproved: false },
            select: {
                id: true,
                email: true,
                companyName: true,
                requesterType: true,
                licenseId: true,
                createdAt: true
            }
        });

        res.status(200).json({ count: pending.length, institutions: pending });

    } catch (error) {
        console.error('AWAS Admin Fetch Fault:', error);
        res.status(500).json({ error: 'Failed to fetch pending institutions.' });
    }
};

// GET all institutions
exports.getAllInstitutions = async (req, res) => {
    try {
        const all = await prisma.institutionalUser.findMany({
            select: {
                id: true,
                email: true,
                companyName: true,
                requesterType: true,
                licenseId: true,
                isApproved: true,
                createdAt: true
            }
        });

        res.status(200).json({ count: all.length, institutions: all });

    } catch (error) {
        console.error('AWAS Admin Fetch Fault:', error);
        res.status(500).json({ error: 'Failed to fetch institutions.' });
    }
};

// PATCH approve institution
exports.approveInstitution = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await prisma.institutionalUser.findUnique({
            where: { id: parseInt(id) }
        });

        if (!user) return res.status(404).json({ error: 'Institution not found.' });
        if (user.isApproved) return res.status(409).json({ error: 'Already approved.' });

        const approved = await prisma.institutionalUser.update({
            where: { id: parseInt(id) },
            data: { isApproved: true }
        });

        res.status(200).json({
            message: `${approved.companyName} approved successfully.`,
            id: approved.id,
            isApproved: approved.isApproved
        });

    } catch (error) {
        console.error('AWAS Admin Approve Fault:', error);
        res.status(500).json({ error: 'Approval processing error.' });
    }
};

// PATCH reject/revoke institution
exports.revokeInstitution = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await prisma.institutionalUser.findUnique({
            where: { id: parseInt(id) }
        });

        if (!user) return res.status(404).json({ error: 'Institution not found.' });

        const revoked = await prisma.institutionalUser.update({
            where: { id: parseInt(id) },
            data: { isApproved: false }
        });

        res.status(200).json({
            message: `${revoked.companyName} access revoked.`,
            id: revoked.id,
            isApproved: revoked.isApproved
        });

    } catch (error) {
        console.error('AWAS Admin Revoke Fault:', error);
        res.status(500).json({ error: 'Revoke processing error.' });
    }
};

// GET dashboard summary
exports.getDashboard = async (req, res) => {
    try {
        const [totalDrivers, totalLogs, pendingInstitutions, totalInstitutions] = await Promise.all([
            prisma.driver.count(),
            prisma.accidentLog.count(),
            prisma.institutionalUser.count({ where: { isApproved: false } }),
            prisma.institutionalUser.count()
        ]);

        res.status(200).json({
            totalDrivers,
            totalLogs,
            pendingInstitutions,
            totalInstitutions
        });

    } catch (error) {
        console.error('AWAS Admin Dashboard Fault:', error);
        res.status(500).json({ error: 'Dashboard fetch error.' });
    }
};