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
const LPR_MAX_PLATE_DISTANCE = 2; // allow up to 2 character differences (font misreads on MY plates)

// Levenshtein distance — how many single-character edits separate two strings
function plateDistance(a, b) {
    a = (a || '').toUpperCase();
    b = (b || '').toUpperCase();
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        }
    }
    return d[m][n];
}

// Small delay helper for spacing out rate-limited API calls
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

        console.log('AWAS LPR RAW RESPONSE:', JSON.stringify(response.data));
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
        // Surface the HTTP status so 429 (rate limit) is distinguishable from a genuine no-read
        const status = e.response?.status;
        console.warn(`AWAS LPR API call failed${status ? ` (status ${status})` : ''}: ${e.message}`);
        return { error: true, status: status || null };
    }
};

// Run LPR — extract frames at 1s, 2s, 3s, then call the API ONE AT A TIME.
// The free tier rate-limits bursts, so firing all 3 at once causes 429s.
// We call sequentially, stop as soon as we get a good read, and back off
// briefly on a 429 before trying the next frame. This usually uses 1 call,
// not 3 — saving quota and respecting the rate limit.
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

    let best = null;
    let sawRateLimit = false;

    for (let i = 0; i < extractedFrames.length; i++) {
        const result = await callPlateRecognizer(extractedFrames[i]);

        // Rate limited — wait and retry the SAME frame once, then move on
        if (result && result.error) {
            if (result.status === 429) {
                sawRateLimit = true;
                console.warn(`AWAS LPR: Rate limited (429) on frame ${i + 1}, backing off 1.5s`);
                await sleep(1500);
                const retry = await callPlateRecognizer(extractedFrames[i]);
                if (retry && !retry.error && retry.plate) {
                    if (!best || retry.confidence > best.confidence) best = retry;
                    if (best && best.confidence >= LPR_CONFIDENCE_THRESHOLD) break;
                }
            }
            // space out the next call regardless
            await sleep(800);
            continue;
        }

        if (result && result.plate) {
            if (!best || result.confidence > best.confidence) best = result;
            // Good enough — stop early, save the remaining API calls
            if (best.confidence >= LPR_CONFIDENCE_THRESHOLD) break;
        }

        // Space out calls to stay under the per-second free-tier limit
        if (i < extractedFrames.length - 1) await sleep(800);
    }

    cleanupFiles(...framePaths);

    if (best && best.plate) {
        console.log(`AWAS LPR: Best read ${best.plate} @ ${best.confidence}`);
    } else {
        console.log(`AWAS LPR: No plate read${sawRateLimit ? ' (rate limited)' : ''}`);
    }

    // Signal rate-limit-only failure separately from genuine no-read
    if (!best && sawRateLimit) return { rateLimited: true };
    return best;
};

// ─── VERIFY & SEAL (THE LPR GATE — single endpoint) ──────────────────────────
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

        const existing = await prisma.accidentLog.findUnique({ where: { logHash } });
        if (existing) {
            return res.status(409).json({ error: "Evidence already sealed." });
        }

        const normalizedClaimedPlate = claimedPlate.toUpperCase().replace(/\s+/g, '');
        const videoBuffer = req.file.buffer;
        const logHashShort = logHash.substring(0, 16);

        // STEP 1: Write video to /tmp for FFmpeg
        rawTempPath = path.join('/tmp', `raw_${logHashShort}.mp4`);
        fs.writeFileSync(rawTempPath, videoBuffer);
        console.log(`AWAS LPR: Running plate check. Claimed plate: ${normalizedClaimedPlate}`);

        // STEP 2: LPR — read the plate physically present in the video
        const lprResult = await runLpr(rawTempPath, logHashShort);
        console.log(`AWAS LPR result: ${JSON.stringify(lprResult)}`);

        // STEP 2a: Distinguish a rate-limit failure from a genuine unreadable plate
        if (lprResult && lprResult.rateLimited) {
            console.warn(`AWAS LPR: Rejected — API rate limited for ${logHash}`);
            cleanupFiles(rawTempPath);
            return res.status(503).json({
                error: "Perkhidmatan pengesahan plat sibuk sebentar. Sila cuba lagi dalam beberapa saat.",
                reason: "RATE_LIMITED"
            });
        }

        // STEP 3: Reject if unreadable / low confidence
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

        // STEP 4: The plate in the video must be a fuzzy match to the LOGIN plate.
        // LPR misreads MY plate fonts (1->I, 5->S, 4->A, 0->O/D), so we allow up to
        // LPR_MAX_PLATE_DISTANCE character differences instead of an exact match.
        const distance = plateDistance(detectedPlate, normalizedClaimedPlate);
        console.log(`AWAS LPR: Distance ${distance} between video=${detectedPlate} and login=${normalizedClaimedPlate}`);

        if (distance > LPR_MAX_PLATE_DISTANCE) {
            console.warn(`AWAS LPR: Rejected — plate mismatch (distance ${distance}). Video=${detectedPlate} Login=${normalizedClaimedPlate}`);
            cleanupFiles(rawTempPath);
            return res.status(422).json({
                error: "Video rejected. Plat dalam video tidak sepadan dengan plat log masuk anda. Hanya video kenderaan anda sendiri diterima.",
                reason: "MISMATCH"
            });
        }

        // The login plate is the source of truth — load THAT driver (must be paid + active)
        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: normalizedClaimedPlate }
        });

        if (!driver) {
            console.warn(`AWAS LPR: Rejected — login plate ${normalizedClaimedPlate} is not a registered AWAS account`);
            cleanupFiles(rawTempPath);
            return res.status(422).json({
                error: "Video rejected. Akaun AWAS tidak dijumpai untuk plat log masuk anda.",
                reason: "NOT_REGISTERED"
            });
        }

        if (driver.subStatus !== 'ACTIVE' || new Date() > driver.subExpiresAt) {
            console.warn(`AWAS LPR: Rejected — driver ${normalizedClaimedPlate} subscription inactive/expired`);
            cleanupFiles(rawTempPath);
            return res.status(403).json({
                error: "Langganan tidak aktif. Sila perbaharui langganan anda.",
                reason: "SUBSCRIPTION_INACTIVE"
            });
        }

        // GATE PASSED
        console.log(`AWAS LPR: GATE PASSED for ${detectedPlate}. Issuing writ and sealing.`);

        const validRoadConditions = ['DRY', 'WET', 'FLOODED', 'UNDER_CONSTRUCTION', 'UNKNOWN'];
        const validWeatherConditions = ['CLEAR', 'RAINY', 'FOGGY', 'HAZY', 'NIGHT', 'UNKNOWN'];
        const validInjuryStatuses = ['NONE', 'MINOR', 'SERIOUS'];

        const videoHash = crypto.createHash('sha256').update(videoBuffer).digest('hex');
        console.log(`AWAS Video Hash: ${videoHash}`);

        const rawUploadResult = await uploadBufferToCloudinary(videoBuffer, {
            resource_type: 'video',
            folder: 'awas/raw',
            public_id: `raw_${logHashShort}`,
            overwrite: true
        });
        const rawVideoUrl = rawUploadResult.secure_url;
        console.log(`AWAS Raw Video URL: ${rawVideoUrl}`);

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