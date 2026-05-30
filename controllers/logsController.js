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

const LPR_CONFIDENCE_THRESHOLD = 0.7;

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
const extractFrame = (videoPath, second, outputPath) => {
    try {
        execSync(
            `ffmpeg -y -ss ${second} -i "${videoPath}" -frames:v 1 -q:v 2 "${outputPath}" 2>/dev/null`,
            { timeout: 15000 }
        );
        return fs.existsSync(outputPath) ? outputPath : null;
    } catch (e) {
        console.warn(`AWAS FFmpeg frame extract failed at ${second}s: ${e.message}`);
        return null;
    }
};

// Send a frame JPEG to Plate Recognizer API
const callPlateRecognizer = async (framePath) => {
    try {
        const form = new FormData();
        form.append('upload', fs.createReadStream(framePath));
        form.append('regions', 'my');

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

// Run LPR — extract frames at 1s, 2s, 3s, take best confidence result
const runLpr = async (videoPath, logHashShort) => {
    const framePaths = [1, 2, 3].map(s =>
        path.join('/tmp', `frame_${logHashShort}_${s}s.jpg`)
    );

    const extractedFrames = [];
    for (let i = 0; i < 3; i++) {
        const fp = extractFrame(videoPath, i + 1, framePaths[i]);
        if (fp) extractedFrames.push(fp);
    }

    console.log(`AWAS LPR: Extracted ${extractedFrames.length} frames`);

    if (extractedFrames.length === 0) {
        cleanupFiles(...framePaths);
        return null;
    }

    try {
        const results = await Promise.all(extractedFrames.map(fp => callPlateRecognizer(fp)));
        cleanupFiles(...framePaths);
        const valid = results.filter(r => r && r.plate);
        console.log(`AWAS LPR: Valid plate results: ${valid.length}`);
        if (valid.length === 0) return null;
        return valid.reduce((a, b) => a.confidence >= b.confidence ? a : b);
    } catch (e) {
        cleanupFiles(...framePaths);
        console.warn(`AWAS LPR runLpr error: ${e.message}`);
        return null;
    }
};

// ─── VERIFY & SEAL (THE LPR GATE — single endpoint) ──────────────────────────
//
// This is the ONE endpoint that enforces the gate. Flow:
//   1. Receive video + claimed plate + GPS + incident metadata
//   2. Run LPR on the video to read the ACTUAL plate from the footage
//   3. Reject if no plate readable, or confidence too low
//   4. Look up the detected plate in the drivers table (paid accounts only)
//   5. Reject if no paid/active driver matches the plate seen in the video
//   6. Reject if the detected plate does not match the plate the user logged in with
//   7. ONLY on full pass: create the AccidentLog, issue the writ, seal the video
//
// No writ is ever issued unless steps 1-6 all pass. Nothing is written to the
// database on rejection. The video itself is the source of truth.

exports.verifyAndSeal = async (req, res) => {
    console.log('AWAS verifyAndSeal called');
    let rawTempPath = null;
    let sealedTempPath = null;
    let overlayTextPath = null;

    try {
        const {
            logHash, claimedPlate, latitude, longitude,
            incidentDescription, roadCondition, weatherCondition, injuryStatus,
            otherVehiclePlate, otherVehicleMakeModel, otherVehicleVideoUrl, otherVehicleHash
        } = req.body;

        // ── Basic input validation ──
        if (!logHash || !claimedPlate || !latitude || !longitude) {
            return res.status(400).json({ error: "Incomplete accident data." });
        }
        if (!/^[a-f0-9]{64}$/i.test(logHash)) {
            return res.status(400).json({ error: "Invalid hash format. Must be SHA-256." });
        }
        if (otherVehicleHash && !/^[a-f0-9]{64}$/i.test(otherVehicleHash)) {
            return res.status(400).json({ error: "Invalid other vehicle hash format." });
        }
        if (!req.file) {
            return res.status(400).json({ error: "Video file required." });
        }

        // Guard against duplicate submission of the same sealed evidence
        const existing = await prisma.accidentLog.findUnique({ where: { logHash } });
        if (existing) {
            return res.status(409).json({ error: "Evidence already sealed." });
        }

        const normalizedClaimedPlate = claimedPlate.toUpperCase().replace(/\s+/g, '');
        const videoBuffer = req.file.buffer;
        const logHashShort = logHash.substring(0, 16);

        // ── STEP 1: Write video to /tmp for FFmpeg ──
        rawTempPath = path.join('/tmp', `raw_${logHashShort}.mp4`);
        fs.writeFileSync(rawTempPath, videoBuffer);
        console.log(`AWAS LPR: Running plate check. Claimed plate: ${normalizedClaimedPlate}`);

        // ── STEP 2: LPR — read the plate physically present in the video ──
        const lprResult = await runLpr(rawTempPath, logHashShort);
        console.log(`AWAS LPR result: ${JSON.stringify(lprResult)}`);

        // ── STEP 3: Reject if unreadable / low confidence ──
        if (!lprResult || !lprResult.plate || lprResult.confidence < LPR_CONFIDENCE_THRESHOLD) {
            console.warn(`AWAS LPR: Rejected — plate unreadable for ${logHash}`);
            cleanupFiles(rawTempPath);
            return res.status(422).json({
                error: "Video rejected. Plat kenderaan tidak dapat dibaca dengan jelas. Pastikan plat kenderaan anda kelihatan jelas dalam video.",
                reason: "UNREADABLE"
            });
        }

        const detectedPlate = lprResult.plate.toUpperCase().replace(/\s+/g, '');
        console.log(`AWAS LPR: Detected ${detectedPlate} confidence ${lprResult.confidence}`);

        // ── STEP 4: The detected plate must belong to a PAID, ACTIVE driver ──
        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: detectedPlate }
        });

        if (!driver) {
            console.warn(`AWAS LPR: Rejected — detected plate ${detectedPlate} is not a registered AWAS account`);
            cleanupFiles(rawTempPath);
            return res.status(422).json({
                error: "Video rejected. Plat kenderaan dalam video bukan akaun AWAS yang berdaftar.",
                reason: "NOT_REGISTERED"
            });
        }

        if (driver.subStatus !== 'ACTIVE' || new Date() > driver.subExpiresAt) {
            console.warn(`AWAS LPR: Rejected — driver ${detectedPlate} subscription inactive/expired`);
            cleanupFiles(rawTempPath);
            return res.status(403).json({
                error: "Langganan tidak aktif. Sila perbaharui langganan anda.",
                reason: "SUBSCRIPTION_INACTIVE"
            });
        }

        // ── STEP 5: The plate seen in the video must match the login plate ──
        // This stops a paid member filming ANOTHER paid member's car and claiming it.
        if (detectedPlate !== normalizedClaimedPlate) {
            console.warn(`AWAS LPR: Rejected — plate mismatch. Video=${detectedPlate} Login=${normalizedClaimedPlate}`);
            cleanupFiles(rawTempPath);
            return res.status(422).json({
                error: "Video rejected. Plat dalam video tidak sepadan dengan plat log masuk anda. Hanya video kenderaan anda sendiri diterima.",
                reason: "MISMATCH"
            });
        }

        // ════════════════════════════════════════════════════════════════════
        // GATE PASSED. The video shows a paid, active driver's own plate.
        // Now — and only now — issue the writ and seal the video.
        // ════════════════════════════════════════════════════════════════════
        console.log(`AWAS LPR: GATE PASSED for ${detectedPlate}. Issuing writ and sealing.`);

        const validRoadConditions = ['DRY', 'WET', 'FLOODED', 'UNDER_CONSTRUCTION', 'UNKNOWN'];
        const validWeatherConditions = ['CLEAR', 'RAINY', 'FOGGY', 'HAZY', 'NIGHT', 'UNKNOWN'];
        const validInjuryStatuses = ['NONE', 'MINOR', 'SERIOUS'];

        const videoHash = crypto.createHash('sha256').update(videoBuffer).digest('hex');
        console.log(`AWAS Video Hash: ${videoHash}`);

        // ── Upload raw video to Cloudinary ──
        const rawUploadResult = await uploadBufferToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: 'awas/raw',
            public_id: `raw_${logHashShort}`,
            overwrite: true
        });
        const rawVideoUrl = rawUploadResult.secure_url;
        console.log(`AWAS Raw Video URL: ${rawVideoUrl}`);

        // ── Create the AccidentLog (writ is born here, AFTER the gate) ──
        const accidentRecord = await prisma.accidentLog.create({
            data: {
                logHash,
                vehiclePlate: detectedPlate,
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                videoUrl: rawVideoUrl,
                rawVideoUrl,
                videoHash,
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
                videoStatus: 'PROCESSING',
                lprStatus: 'MATCHED',
                lprDetectedPlate: detectedPlate
            }
        });

        const year = new Date().getFullYear();
        const writNumber = `AWAS/MY/${year}/${accidentRecord.id.toString().padStart(6, '0')}`;
        await prisma.accidentLog.update({
            where: { id: accidentRecord.id },
            data: { writNumber }
        });

        // ── Burn the forensic overlay into the video and seal it ──
        sealedTempPath = path.join('/tmp', `sealed_${logHashShort}.mp4`);
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

        console.log(`AWAS FFmpeg sealing...`);
        execSync(ffmpegCmd, { timeout: 60000 });
        console.log(`AWAS FFmpeg seal complete.`);

        const sealedBuffer = fs.readFileSync(sealedTempPath);
        const sealedUploadResult = await uploadBufferToCloudinary(sealedBuffer, {
            resource_type: 'video',
            folder: 'awas/sealed',
            public_id: `sealed_${logHashShort}`,
            overwrite: true
        });
        const sealedVideoUrl = sealedUploadResult.secure_url;
        console.log(`AWAS Sealed Video URL: ${sealedVideoUrl}`);

        await prisma.accidentLog.update({
            where: { logHash },
            data: {
                sealedVideoUrl,
                videoStatus: 'VERIFIED',
                videoSealedAt: new Date()
            }
        });

        cleanupFiles(rawTempPath, sealedTempPath, overlayTextPath);
        console.log(`AWAS Writ issued and video sealed for ${detectedPlate}: ${writNumber}`);

        // Success — return everything the FE needs to render the writ
        return res.status(201).json({
            message: "Plate verified. Writ issued and video sealed.",
            writNumber,
            hash: logHash,
            videoHash,
            sealedVideoUrl,
            verifiedPlate: detectedPlate,
            vehicleMakeModel: driver.vehicleMakeModel,
            vehicleType: driver.vehicleType
        });

    } catch (error) {
        cleanupFiles(rawTempPath, sealedTempPath, overlayTextPath);
        // If we created a record but sealing failed mid-way, mark it FAILED
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