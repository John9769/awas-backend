// ==========================================
// FILE: controllers/logsController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Upload buffer to Cloudinary
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

// SUBMIT LOG — unchanged, creates the accident record
exports.submitLog = async (req, res) => {
    try {
        const {
            logHash, vehiclePlate, latitude, longitude, videoUrl,
            incidentDescription, roadCondition, weatherCondition, injuryStatus,
            otherVehiclePlate, otherVehicleMakeModel, otherVehicleVideoUrl, otherVehicleHash
        } = req.body;

        if (!logHash || !vehiclePlate || !latitude || !longitude) {
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

        const accidentRecord = await prisma.accidentLog.create({
            data: {
                logHash,
                vehiclePlate: normalizedPlate,
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                videoUrl: videoUrl || 'PENDING_UPLOAD',
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
                videoStatus: 'PENDING'
            }
        });

        const year = new Date().getFullYear();
        const writNumber = `AWAS/MY/${year}/${accidentRecord.id.toString().padStart(6, '0')}`;

        await prisma.accidentLog.update({
            where: { id: accidentRecord.id },
            data: { writNumber }
        });

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

// UPLOAD VIDEO — receives video file, generates SHA-256, FFmpeg seal, Cloudinary store
exports.uploadVideo = async (req, res) => {
    let rawTempPath = null;
    let sealedTempPath = null;

    try {
        const { logHash } = req.body;

        if (!logHash) {
            return res.status(400).json({ error: "logHash required." });
        }

        if (!req.file) {
            return res.status(400).json({ error: "Video file required." });
        }

        // Find the accident log
        const accidentLog = await prisma.accidentLog.findUnique({
            where: { logHash }
        });

        if (!accidentLog) {
            return res.status(404).json({ error: "Accident log not found." });
        }

        if (accidentLog.videoStatus === 'VERIFIED') {
            return res.status(200).json({ message: "Video already sealed.", sealedVideoUrl: accidentLog.sealedVideoUrl });
        }

        // Mark as processing
        await prisma.accidentLog.update({
            where: { logHash },
            data: { videoStatus: 'PROCESSING' }
        });

        const videoBuffer = req.file.buffer;

        // Step 1: Generate SHA-256 from raw video buffer
        const videoHash = crypto.createHash('sha256').update(videoBuffer).digest('hex');
        console.log(`AWAS Video Hash: ${videoHash}`);

        // Step 2: Upload raw video to Cloudinary
        const rawUploadResult = await uploadBufferToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: 'awas/raw',
            public_id: `raw_${logHash.substring(0, 16)}`,
            overwrite: true
        });
        const rawVideoUrl = rawUploadResult.secure_url;
        console.log(`AWAS Raw Video URL: ${rawVideoUrl}`);

        // Step 3: Write raw video to temp file for FFmpeg
        rawTempPath = path.join('/tmp', `raw_${logHash.substring(0, 16)}.mp4`);
        sealedTempPath = path.join('/tmp', `sealed_${logHash.substring(0, 16)}.mp4`);
        fs.writeFileSync(rawTempPath, videoBuffer);

        // Step 4: Run FFmpeg to burn overlay onto video
        const writNumber = accidentLog.writNumber || 'AWAS/MY/PENDING';
        const timestamp = new Date().toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' });
        const overlayText = [
            `AWAS BUKTI TERSEGEL`,
            `Writ: ${writNumber}`,
            `SHA-256: ${videoHash}`,
            `${timestamp} MYT`
        ].join('\n');

        const overlayTextPath = path.join('/tmp', `text_${logHash.substring(0, 16)}.txt`);
        fs.writeFileSync(overlayTextPath, overlayText);

        const ffmpegCmd = [
            'ffmpeg -y',
            `-i "${rawTempPath}"`,
            `-vf "drawtext=textfile='${overlayTextPath}':fontcolor=white:fontsize=14:box=1:boxcolor=black@0.7:boxborderw=8:x=10:y=10:line_spacing=4"`,
            `-codec:a copy`,
            `"${sealedTempPath}"`
        ].join(' ');

        console.log(`AWAS FFmpeg running...`);
        execSync(ffmpegCmd, { timeout: 60000 });
        console.log(`AWAS FFmpeg complete.`);

        // Step 5: Upload sealed video to Cloudinary
        const sealedBuffer = fs.readFileSync(sealedTempPath);
        const sealedUploadResult = await uploadBufferToCloudinary(sealedBuffer, {
            resource_type: 'video',
            folder: 'awas/sealed',
            public_id: `sealed_${logHash.substring(0, 16)}`,
            overwrite: true
        });
        const sealedVideoUrl = sealedUploadResult.secure_url;
        console.log(`AWAS Sealed Video URL: ${sealedVideoUrl}`);

        // Step 6: Update DB
        await prisma.accidentLog.update({
            where: { logHash },
            data: {
                videoHash,
                rawVideoUrl,
                videoUrl: rawVideoUrl,
                sealedVideoUrl,
                videoStatus: 'VERIFIED',
                videoSealedAt: new Date()
            }
        });

        // Cleanup temp files
        if (fs.existsSync(rawTempPath)) fs.unlinkSync(rawTempPath);
        if (fs.existsSync(sealedTempPath)) fs.unlinkSync(sealedTempPath);
        if (fs.existsSync(overlayTextPath)) fs.unlinkSync(overlayTextPath);

        console.log(`AWAS Video sealed successfully for ${logHash}`);

        res.status(200).json({
            message: "Video sealed and verified.",
            videoHash,
            sealedVideoUrl
        });

    } catch (error) {
        // Cleanup temp files on error
        if (rawTempPath && fs.existsSync(rawTempPath)) fs.unlinkSync(rawTempPath);
        if (sealedTempPath && fs.existsSync(sealedTempPath)) fs.unlinkSync(sealedTempPath);

        // Mark as failed
        try {
            if (req.body.logHash) {
                await prisma.accidentLog.update({
                    where: { logHash: req.body.logHash },
                    data: { videoStatus: 'FAILED' }
                });
            }
        } catch (e) {}

        console.error("AWAS Video Upload Fault:", error);
        res.status(500).json({ error: "Video sealing failed." });
    }
};

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