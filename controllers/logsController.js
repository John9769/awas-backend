const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.submitLog = async (req, res) => {
    try {
        const { logHash, vehiclePlate, latitude, longitude, videoUrl } = req.body;

        if (!logHash || !vehiclePlate || !latitude || !longitude || !videoUrl) {
            return res.status(400).json({ error: "Incomplete accident data." });
        }

        if (!/^[a-f0-9]{64}$/i.test(logHash)) {
            return res.status(400).json({ error: "Invalid hash format. Must be SHA-256." });
        }

        const normalizedPlate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: normalizedPlate }
        });

        if (!driver || driver.subStatus !== 'ACTIVE' || new Date() > driver.subExpiresAt) {
            return res.status(403).json({ error: "Subscription inactive. Renewal required." });
        }

        const accidentRecord = await prisma.accidentLog.create({
            data: {
                logHash,
                vehiclePlate: normalizedPlate,
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                videoUrl,
                isReportPaid: false
            }
        });

        res.status(201).json({
            message: "Accident evidence sealed and hashed.",
            hash: accidentRecord.logHash
        });

    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: "Duplicate entry: Evidence already sealed." });
        }
        console.error("AWAS Log Ingress Fault:", error);
        res.status(500).json({ error: "Log storage error." });
    }
};

exports.clearPaywall = async (req, res) => {
    try {
        const { logHash } = req.body;

        if (!logHash) return res.status(400).json({ error: "Missing log hash." });

        // TODO Phase 2: Verify Billplz payment webhook signature here before unlocking

        const updatedLog = await prisma.accidentLog.update({
            where: { logHash },
            data: { isReportPaid: true }
        });

        res.status(200).json({
            message: "Report unlocked successfully.",
            unlocked: updatedLog.isReportPaid
        });

    } catch (error) {
        console.error("AWAS Paywall Fault:", error);
        res.status(500).json({ error: "Paywall processing error." });
    }
};