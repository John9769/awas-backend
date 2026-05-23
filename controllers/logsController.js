const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.submitLog = async (req, res) => {
    try {
        const {
            logHash, vehiclePlate, latitude, longitude, videoUrl,
            incidentDescription, roadCondition, weatherCondition, injuryStatus,
            otherVehiclePlate, otherVehicleMakeModel, otherVehicleVideoUrl, otherVehicleHash
        } = req.body;

        if (!logHash || !vehiclePlate || !latitude || !longitude || !videoUrl) {
            return res.status(400).json({ error: "Incomplete accident data." });
        }

        if (!/^[a-f0-9]{64}$/i.test(logHash)) {
            return res.status(400).json({ error: "Invalid hash format. Must be SHA-256." });
        }

        if (otherVehicleHash && !/^[a-f0-9]{64}$/i.test(otherVehicleHash)) {
            return res.status(400).json({ error: "Invalid other vehicle hash format." });
        }

        const validRoadConditions = ['DRY', 'WET', 'FLOODED', 'UNDER_CONSTRUCTION', 'UNKNOWN'];
        const validWeatherConditions = ['CLEAR', 'RAINY', 'FOGGY', 'HAZY', 'NIGHT', 'UNKNOWN'];
        const validInjuryStatuses = ['NONE', 'MINOR', 'SERIOUS'];

        const normalizedPlate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: normalizedPlate }
        });

        if (!driver || driver.subStatus !== 'ACTIVE' || new Date() > driver.subExpiresAt) {
            return res.status(403).json({ error: "Subscription inactive. Renewal required." });
        }

        // Create accident log
        const accidentRecord = await prisma.accidentLog.create({
            data: {
                logHash,
                vehiclePlate: normalizedPlate,
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                videoUrl,
                incidentDescription: incidentDescription || null,
                roadCondition: validRoadConditions.includes(roadCondition) ? roadCondition : 'UNKNOWN',
                weatherCondition: validWeatherConditions.includes(weatherCondition) ? weatherCondition : 'UNKNOWN',
                injuryStatus: validInjuryStatuses.includes(injuryStatus) ? injuryStatus : 'NONE',
                otherVehiclePlate: otherVehiclePlate ? otherVehiclePlate.toUpperCase().replace(/\s+/g, '') : null,
                otherVehicleMakeModel: otherVehicleMakeModel || null,
                otherVehicleVideoUrl: otherVehicleVideoUrl || null,
                otherVehicleHash: otherVehicleHash || null,
                isReportPaid: false,
                emergencyAlertSent: false
            }
        });

        // Generate Writ Number from ID
        const year = new Date().getFullYear();
        const writNumber = `AWAS/MY/${year}/${accidentRecord.id.toString().padStart(6, '0')}`;

        await prisma.accidentLog.update({
            where: { id: accidentRecord.id },
            data: { writNumber }
        });

        // TODO Phase 2: Send emergency WhatsApp to driver.phone via Twilio
        // if (driver.phone) {
        //     await sendWhatsAppAlert(driver.phone, writNumber, latitude, longitude);
        //     await prisma.accidentLog.update({ where: { id: accidentRecord.id }, data: { emergencyAlertSent: true } });
        // }

        res.status(201).json({
            message: "Accident evidence sealed and hashed.",
            hash: accidentRecord.logHash,
            writNumber
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

        // TODO Phase 2: Verify payment webhook signature before unlocking

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