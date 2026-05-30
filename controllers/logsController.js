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
const axios = require('axios');
const FormData = require('form-data');

// Configure Cloudinary
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

const cleanupFiles = (...filePaths) => {
    for (const fp of filePaths) {
        try {
            if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch (e) {
            console.warn(`AWAS Cleanup warning: could not delete ${fp}`);
        }
    }
};

// Extract a single JPEG frame from video at given second mark using FFmpeg
// Returns the frame file path, or null if extraction failed
const extractFrame = (videoPath, second, outputPath) => {
    try {
        execSync(
            `ffmpeg -y -ss ${second} -i "${videoPath}" -frames:v 1 -q:v 2 "${outputPath}" 2>/dev/null`,
            { timeout: 15000 }
        );
        return fs.existsSync(outputPath) ? outputPath : null;
    } catch (e) {
        return null;
    }
};

// Send a frame JPEG to Plate Recognizer API
// Returns { plate: string, confidence: number } or null if API call failed
const callPlateRecognizer = async (framePath) => {
    try {
        const form = new FormData();
        form.append('upload', fs.createReadStream(framePath));
        form.append('regions', 'my'); // Malaysia region hint

        const response = await axios.post(
            'https://api.platerecognizer.com/v1/plate-reader/',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': `Token ${process.env.PLATE_RECOGNIZER_API_KEY}`
                },
                timeout: 15000
            }
        );

        const results = response.data?.results;
        if (!results || results.length === 0) return null;

        // Pick result with highest plate confidence
        const best = results.reduce((a, b) => {
            return (a.plate?.confidence || 0) >= (b.plate?.confidence || 0) ? a : b;
        });

        return {
            plate: best.plate?.chars?.toUpperCase().replace(/\s+/g, '') || null,
            confidence: best.plate?.confidence || 0
        };
    } catch (e) {
        console.warn(`AWAS LPR API call failed: ${e.message}`);
        return null;
    }
};

// Run LPR against video — tries frames at 1s, 2s, 3s, takes best confidence result
// Returns { plate, confidence } or null if all frames failed
const runLpr = (videoPath, logHashShort) => {
    const framePaths = [1, 2, 3].map(s =>
        path.join('/tmp', `frame_${logHashShort}_${s}s.jpg`)
    );

    const extractedFrames = [];
    for (let i = 0; i < 3; i++) {
        const fp = extractFrame(videoPath, i + 1, framePaths[i]);
        if (fp) extractedFrames.push(fp);
    }

    if (extractedFrames.length === 0) {
        cleanupFiles(...framePaths);
        return Promise.resolve(null);
    }

    // Call LPR on all extracted frames in parallel, take best result
    return Promise.all(extractedFrames.map(fp => callPlateRecognizer(fp)))
        .then(results => {
            cleanupFiles(...framePaths);
            const valid = results.filter(r => r && r.plate);
            if (valid.length === 0) return null;
            return valid.reduce((a, b) => a.confidence >= b.confidence ? a : b);
        })
        .catch(() => {
            cleanupFiles(...framePaths);
            return null;
        });
};

// ─── SUBMIT LOG ─────────────────────────────────────────────────────────────

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

// ─── UPLOAD VIDEO ────────────────────────────────────────────────────────────
//
// LPR-first pipeline:
//   1. Write video to /tmp
//   2. Extract frames at 1s/2s/3s — send to Plate Recognizer API
//   3. If unreadable (no plate / confidence < 0.7) → hard reject, videoStatus FAILED
//   4. If mismatch (detected plate ≠ registered plate) → hard reject, videoStatus FAILED
//   5. If matched → proceed: SHA-256 → upload raw to Cloudinary → FFmpeg seal → upload sealed
//   6. Nothing touches Cloudinary until plate is confirmed matched

exports.uploadVideo = async (req, res) => {
    const LPR_CONFIDENCE_THRESHOLD = 0.7;
    let rawTempPath = null;
    let sealedTempPath = null;
    let overlayTextPath = null;

    try {
        const { logHash } = req.body;

        if (!logHash) {
            return res.status(400).json({ error: "logHash required." });
        }

        if (!req.file) {
            return res.status(400).json({ error: "Video file required." });
        }

        const accidentLog = await prisma.accidentLog.findUnique({
            where: { logHash }
        });

        if (!accidentLog) {
            return res.status(404).json({ error: "Accident log not found." });
        }

        if (accidentLog.videoStatus === 'VERIFIED') {
            return res.status(200).json({
                message: "Video already sealed.",
                sealedVideoUrl: accidentLog.sealedVideoUrl
            });
        }

        await prisma.accidentLog.update({
            where: { logHash },
            data: { videoStatus: 'PROCESSING' }
        });

        const videoBuffer = req.file.buffer;
        const logHashShort = logHash.substring(0, 16);
        const registeredPlate = accidentLog.vehiclePlate.toUpperCase().replace(/\s+/g, '');

        // ── STEP 1: Write video to /tmp for FFmpeg frame extraction ──
        rawTempPath = path.join('/tmp', `raw_${logHashShort}.mp4`);
        fs.writeFileSync(rawTempPath, videoBuffer);

        // ── STEP 2: LPR check — MUST pass before anything goes to Cloudinary ──
        console.log(`AWAS LPR: Running plate check for ${registeredPlate}`);
        const lprResult = await runLpr(rawTempPath, logHashShort);

        if (!lprResult || !lprResult.plate || lprResult.confidence < LPR_CONFIDENCE_THRESHOLD) {
            // Plate unreadable — hard reject
            console.warn(`AWAS LPR: Plate unreadable or low confidence for ${logHash}`);
            cleanupFiles(rawTempPath);
            await prisma.accidentLog.update({
                where: { logHash },
                data: {
                    videoStatus: 'FAILED',
                    lprStatus: 'UNREADABLE',
                    lprDetectedPlate: lprResult?.plate || null
                }
            });
            return res.status(422).json({
                error: "Video rejected. Plate number could not be read from video. Ensure your vehicle plate is clearly visible."
            });
        }

        const detectedPlate = lprResult.plate.toUpperCase().replace(/\s+/g, '');
        console.log(`AWAS LPR: Detected ${detectedPlate} (confidence ${lprResult.confidence}) vs registered ${registeredPlate}`);

        if (detectedPlate !== registeredPlate) {
            // Plate mismatch — hard reject
            console.warn(`AWAS LPR: Plate mismatch. Detected: ${detectedPlate}, Registered: ${registeredPlate}`);
            cleanupFiles(rawTempPath);
            await prisma.accidentLog.update({
                where: { logHash },
                data: {
                    videoStatus: 'FAILED',
                    lprStatus: 'MISMATCH',
                    lprDetectedPlate: detectedPlate
                }
            });
            return res.status(422).json({
                error: "Video rejected. Plate number in video does not match your registered vehicle. Only your own vehicle video is accepted."
            });
        }

        // ── STEP 3: Plate matched — proceed with sealing ──
        console.log(`AWAS LPR: Plate matched. Proceeding to seal.`);

        // SHA-256 from raw buffer
        const videoHash = crypto.createHash('sha256').update(videoBuffer).digest('hex');
        console.log(`AWAS Video Hash: ${videoHash}`);

        // Upload raw video to Cloudinary
        const rawUploadResult = await uploadBufferToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: 'awas/raw',
            public_id: `raw_${logHashShort}`,
            overwrite: true
        });
        const rawVideoUrl = rawUploadResult.secure_url;
        console.log(`AWAS Raw Video URL: ${rawVideoUrl}`);

        // FFmpeg seal — burn overlay
        sealedTempPath = path.join('/tmp', `sealed_${logHashShort}.mp4`);
        const writNumber = accidentLog.writNumber || 'AWAS/MY/PENDING';
        const timestamp = new Date().toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' });
        const overlayText = [
            `AWAS BUKTI TERSEDIA`,
            `Writ: ${writNumber}`,
            `SHA-256: ${videoHash.substring(0, 32)}`,
            `${videoHash.substring(32, 64)}`,
            `${timestamp} MYT`
        ].join('\n');

        overlayTextPath = path.join('/tmp', `text_${logHashShort}.txt`);
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

        // Upload sealed video to Cloudinary
        const sealedBuffer = fs.readFileSync(sealedTempPath);
        const sealedUploadResult = await uploadBufferToCloudinary(sealedBuffer, {
            resource_type: 'video',
            folder: 'awas/sealed',
            public_id: `sealed_${logHashShort}`,
            overwrite: true
        });
        const sealedVideoUrl = sealedUploadResult.secure_url;
        console.log(`AWAS Sealed Video URL: ${sealedVideoUrl}`);

        // Update DB — verified
        await prisma.accidentLog.update({
            where: { logHash },
            data: {
                videoHash,
                rawVideoUrl,
                videoUrl: rawVideoUrl,
                sealedVideoUrl,
                videoStatus: 'VERIFIED',
                videoSealedAt: new Date(),
                lprStatus: 'MATCHED',
                lprDetectedPlate: detectedPlate
            }
        });

        cleanupFiles(rawTempPath, sealedTempPath, overlayTextPath);
        console.log(`AWAS Video sealed successfully for ${logHash}`);

        res.status(200).json({
            message: "Video sealed and verified.",
            videoHash,
            sealedVideoUrl
        });

    } catch (error) {
        cleanupFiles(rawTempPath, sealedTempPath, overlayTextPath);
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