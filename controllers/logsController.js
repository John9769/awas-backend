// ==========================================
// FILE: controllers/logsController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── HELPERS ────────────────────────────────────────────────────────────────

const uploadBufferToCloudinary = (buffer, options) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            options,
            (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }
        );
        uploadStream.end(buffer);
    });
};

// ─── VERIFY & SEAL ───────────────────────────────────────────────────────────
exports.verifyAndSeal = async (req, res) => {
    console.log('AWAS verifyAndSeal called');

    try {
        const {
            logHash, claimedPlate, latitude, longitude,
            incidentDescription, roadCondition, weatherCondition, injuryStatus,
            otherVehiclePlate, otherVehicleMakeModel, otherVehicleVideoUrl, otherVehicleHash
        } = req.body;

        if (!logHash || !claimedPlate || !latitude || !longitude) {
            return res.status(400).json({ error: "Incomplete accident data." });
        }
        if (!/^[a-f0-9]{64}$/i.test(logHash)) {
            return res.status(400).json({ error: "Invalid hash format. Must be SHA-256." });
        }
        if (otherVehicleHash && !/^[a-f0-9]{64}$/i.test(otherVehicleHash)) {
            return res.status(400).json({ error: "Invalid other vehicle hash format." });
        }
        if (!req.files || !req.files.video || req.files.video.length === 0) {
            return res.status(400).json({ error: "Video file required." });
        }

        const existing = await prisma.accidentLog.findUnique({ where: { logHash } });
        if (existing) {
            return res.status(409).json({ error: "Evidence already sealed." });
        }

        const normalizedPlate = claimedPlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: normalizedPlate }
        });

        if (!driver) {
            return res.status(422).json({
                error: "Akaun AWAS tidak dijumpai untuk plat log masuk anda.",
                reason: "NOT_REGISTERED"
            });
        }

        if (driver.subStatus !== 'ACTIVE' || new Date() > driver.subExpiresAt) {
            return res.status(403).json({
                error: "Langganan tidak aktif. Sila perbaharui langganan anda.",
                reason: "SUBSCRIPTION_INACTIVE"
            });
        }

        const validRoadConditions = ['DRY', 'WET', 'FLOODED', 'UNDER_CONSTRUCTION', 'UNKNOWN'];
        const validWeatherConditions = ['CLEAR', 'RAINY', 'FOGGY', 'HAZY', 'NIGHT', 'UNKNOWN'];
        const validInjuryStatuses = ['NONE', 'MINOR', 'SERIOUS'];

        const logHashShort = logHash.substring(0, 16);
        const videoBuffer = req.files.video[0].buffer;

        const videoHash = crypto.createHash('sha256').update(videoBuffer).digest('hex');
        console.log(`AWAS Video Hash: ${videoHash}`);

        const imageFiles = (req.files.images || []).slice(0, 4);
        const imageHashes = imageFiles.map(f =>
            crypto.createHash('sha256').update(f.buffer).digest('hex')
        );
        console.log(`AWAS Images: ${imageFiles.length} received`);

        const rawUploadResult = await uploadBufferToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: 'awas/raw',
            public_id: `raw_${logHashShort}`,
            overwrite: true
        });
        const rawVideoUrl = rawUploadResult.secure_url;
        console.log(`AWAS Raw Video URL: ${rawVideoUrl}`);

        const imageUrls = [];
        for (let i = 0; i < imageFiles.length; i++) {
            const imgResult = await uploadBufferToCloudinary(imageFiles[i].buffer, {
                resource_type: 'image',
                folder: 'awas/images',
                public_id: `img_${logHashShort}_${i + 1}`,
                overwrite: true
            });
            imageUrls.push(imgResult.secure_url);
            console.log(`AWAS Image ${i + 1} URL: ${imgResult.secure_url}`);
        }

        const accidentRecord = await prisma.accidentLog.create({
            data: {
                logHash,
                vehiclePlate: normalizedPlate,
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                videoUrl: rawVideoUrl,
                rawVideoUrl,
                videoHash,
                imageUrls: imageUrls.length > 0 ? imageUrls : null,
                imageHashes: imageHashes.length > 0 ? imageHashes : null,
                incidentDescription: incidentDescription || null,
                roadCondition: validRoadConditions.includes(roadCondition) ? roadCondition : 'UNKNOWN',
                weatherCondition: validWeatherConditions.includes(weatherCondition) ? weatherCondition : 'UNKNOWN',
                injuryStatus: validInjuryStatuses.includes(injuryStatus) ? injuryStatus : 'NONE',
                otherVehiclePlate: otherVehiclePlate ? otherVehiclePlate.toUpperCase().replace(/\s+/g, '') : null,
                otherVehicleMakeModel: otherVehicleMakeModel || null,
                otherVehicleVideoUrl: otherVehicleVideoUrl || null,
                otherVehicleHash: otherVehicleHash || null,
                isReportPaid: false,
                emergencyAlertSent: false,
                videoStatus: 'VERIFIED',
                videoSealedAt: new Date()
            }
        });

        const year = new Date().getFullYear();
        const writNumber = `AWAS/MY/${year}/${accidentRecord.id.toString().padStart(6, '0')}`;
        await prisma.accidentLog.update({
            where: { id: accidentRecord.id },
            data: { writNumber }
        });

        console.log(`AWAS Writ issued for ${normalizedPlate}: ${writNumber}`);

        return res.status(201).json({
            message: "Writ issued.",
            writNumber,
            hash: logHash,
            videoHash,
            rawVideoUrl,
            imageUrls,
            imageHashes,
            verifiedPlate: normalizedPlate,
            vehicleMakeModel: driver.vehicleMakeModel,
            vehicleType: driver.vehicleType
        });

    } catch (error) {
        try {
            if (req.body && req.body.logHash) {
                await prisma.accidentLog.updateMany({
                    where: { logHash: req.body.logHash },
                    data: { videoStatus: 'FAILED' }
                });
            }
        } catch (e) {}
        if (error.code === 'P2002') {
            return res.status(409).json({ error: "Evidence already sealed." });
        }
        console.error("AWAS verifyAndSeal Fault:", error);
        return res.status(500).json({ error: "Pengesahan video gagal. Cuba lagi." });
    }
};

// ─── GET WRIT BY NUMBER ───────────────────────────────────────────────────────
// Called by writ.html after ToyyibPay returns user to /writ/AWAS-MY-2026-000048.
// URL path uses dashes because ToyyibPay cannot handle slashes in billReturnUrl
// path segments. DB stores slashes — convert before querying.
// Security: full hashes only returned when isReportPaid === true.
exports.getWritByNumber = async (req, res) => {
    try {
        const { writNumber } = req.params;

        if (!writNumber) {
            return res.status(400).json({ error: "Writ number diperlukan." });
        }

        // Convert dash-based URL param back to slash-based DB format
        // AWAS-MY-2026-000048 → AWAS/MY/2026/000048
        const normalizedWritNumber = writNumber.replace(/-/g, '/');

        const log = await prisma.accidentLog.findFirst({
            where: { writNumber: normalizedWritNumber }
        });

        if (!log) {
            return res.status(404).json({ error: "Writ tidak dijumpai." });
        }

        if (!log.isReportPaid) {
            return res.status(200).json({ isReportPaid: false });
        }

        return res.status(200).json({
            isReportPaid: true,
            writNumber: log.writNumber,
            logHash: log.logHash,
            videoHash: log.videoHash,
            imageHashes: log.imageHashes || [],
            latitude: log.latitude,
            longitude: log.longitude,
            incidentDescription: log.incidentDescription,
            roadCondition: log.roadCondition,
            weatherCondition: log.weatherCondition,
            injuryStatus: log.injuryStatus,
            otherVehiclePlate: log.otherVehiclePlate,
            otherVehicleMakeModel: log.otherVehicleMakeModel,
            vehiclePlate: log.vehiclePlate,
            createdAt: log.createdAt
        });

    } catch (error) {
        console.error("AWAS getWritByNumber Fault:", error);
        return res.status(500).json({ error: "Ralat semasa mengambil writ." });
    }
};

// ─── CLEAR PAYWALL ───────────────────────────────────────────────────────────
exports.clearPaywall = async (req, res) => {
    try {
        const { logHash } = req.body;
        if (!logHash) return res.status(400).json({ error: "Missing log hash." });

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