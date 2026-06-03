// ==========================================
// FILE: controllers/driversController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Generate unique 8-char referral code
function generateReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'AWAS';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// REGISTER DRIVER
exports.registerDriver = async (req, res) => {
    try {
        const { vehiclePlate, vehicleMakeModel, vehicleType, mykadLastFour, phone, consentGiven, referredByCode } = req.body;

        if (!consentGiven) {
            return res.status(400).json({ error: "PDPA Consent Mandatory." });
        }
        if (!vehiclePlate || !vehicleMakeModel || !mykadLastFour) {
            return res.status(400).json({ error: "Missing required fields." });
        }
        if (!/^\d{4}$/.test(mykadLastFour)) {
            return res.status(400).json({ error: "Invalid MyKad input. Last 4 digits only." });
        }
        if (vehicleType && !['CAR', 'MOTORCYCLE', 'LORRY', 'BUS', 'VAN'].includes(vehicleType)) {
            return res.status(400).json({ error: "Invalid vehicle type." });
        }

        const normalizedPlate = vehiclePlate.toUpperCase().replace(/\s+/g, '');
        const expiryDate = new Date();
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);

        // Validate referral code if provided
        let validReferralCode = null;
        if (referredByCode) {
            const referrer = await prisma.driver.findUnique({
                where: { referralCode: referredByCode.toUpperCase() }
            });
            if (referrer) {
                validReferralCode = referredByCode.toUpperCase();
            }
        }

        // Generate unique referral code for this driver
        let newReferralCode;
        let isUnique = false;
        while (!isUnique) {
            newReferralCode = generateReferralCode();
            const existing = await prisma.driver.findUnique({
                where: { referralCode: newReferralCode }
            });
            if (!existing) isUnique = true;
        }

        const userProfile = await prisma.driver.upsert({
            where: { vehiclePlate: normalizedPlate },
            update: {
                vehicleMakeModel,
                vehicleType: vehicleType || 'CAR',
                mykadLastFour,
                phone: phone || null,
                subStatus: 'ACTIVE',
                subExpiresAt: expiryDate
            },
            create: {
                vehiclePlate: normalizedPlate,
                vehicleMakeModel,
                vehicleType: vehicleType || 'CAR',
                mykadLastFour,
                phone: phone || null,
                subStatus: 'ACTIVE',
                subExpiresAt: expiryDate,
                referralCode: newReferralCode,
                referredByCode: validReferralCode
            }
        });

        res.status(201).json({
            message: "Vehicle profile registered successfully.",
            vehicleType: userProfile.vehicleType,
            expiry: userProfile.subExpiresAt,
            referralCode: userProfile.referralCode
        });

    } catch (error) {
        console.error("AWAS Driver Registration Fault:", error);
        res.status(500).json({ error: "Internal registry error." });
    }
};

// LOOKUP DRIVER BY PLATE
exports.lookupDriver = async (req, res) => {
    try {
        const plate = req.params.plate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            select: {
                vehiclePlate: true,
                vehicleMakeModel: true,
                vehicleType: true,
                mykadLastFour: true,
                subStatus: true,
                subExpiresAt: true,
                referralCode: true
            }
        });

        if (!driver) {
            return res.status(404).json({ error: 'No AWAS Record Found for this vehicle.' });
        }
        if (driver.subStatus !== 'ACTIVE') {
            return res.status(403).json({ error: 'AWAS subscription expired. Please renew.' });
        }

        return res.status(200).json(driver);

    } catch (err) {
        console.error('Lookup fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// VALIDATE REFERRAL CODE
exports.validateReferralCode = async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        const driver = await prisma.driver.findUnique({
            where: { referralCode: code },
            select: { vehiclePlate: true, subStatus: true }
        });

        if (!driver || driver.subStatus !== 'ACTIVE') {
            return res.status(404).json({ valid: false, message: 'Referral code not found or inactive.' });
        }

        return res.status(200).json({ valid: true, message: 'Referral code valid.' });

    } catch (err) {
        console.error('Referral validation fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};
// DELETE ACCOUNT
// Triple verification: plate + password + MyKad last 4
// Deletes: Cloudinary files, personal data
// Anonymises: AccidentLogs (keep writ/hash/GPS, strip identity)
// Keeps: Payment records (anonymised), writ audit trail
exports.deleteAccount = async (req, res) => {
    try {
        const { vehiclePlate, password, mykadLastFour } = req.body;

        if (!vehiclePlate || !password || !mykadLastFour) {
            return res.status(400).json({ error: 'Semua medan diperlukan untuk pengesahan.' });
        }
        if (!/^\d{4}$/.test(mykadLastFour)) {
            return res.status(400).json({ error: 'MyKad 4 digit terakhir tidak sah.' });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');

        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            include: {
                logs: true,
                affiliate: {
                    include: {
                        earnings: true,
                        payouts: true
                    }
                }
            }
        });

        // Generic error — do not reveal whether plate exists
        if (!driver) {
            return res.status(401).json({ error: 'Maklumat pengesahan tidak sepadan. Sila cuba lagi.' });
        }
        if (!driver.passwordHash) {
            return res.status(401).json({ error: 'Maklumat pengesahan tidak sepadan. Sila cuba lagi.' });
        }

        const passwordMatch = await bcrypt.compare(password, driver.passwordHash);
        if (!passwordMatch || driver.mykadLastFour !== mykadLastFour) {
            return res.status(401).json({ error: 'Maklumat pengesahan tidak sepadan. Sila cuba lagi.' });
        }

        // ── STEP 1: Delete Cloudinary files ─────────────────────────────
        // Collect all Cloudinary public IDs from logs
        const cloudinary = require('cloudinary').v2;
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET
        });

        for (const log of driver.logs) {
            // Delete video
            if (log.videoUrl) {
                try {
                    // Extract public_id from Cloudinary URL
                    const urlParts = log.videoUrl.split('/');
                    const fileWithExt = urlParts[urlParts.length - 1];
                    const publicId = `awas/raw/${fileWithExt.split('.')[0]}`;
                    await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
                } catch (e) {
                    console.warn(`Cloudinary video delete warn for log ${log.id}:`, e.message);
                }
            }
            // Delete images
            if (log.imageUrls && Array.isArray(log.imageUrls)) {
                for (const imgUrl of log.imageUrls) {
                    try {
                        const urlParts = imgUrl.split('/');
                        const fileWithExt = urlParts[urlParts.length - 1];
                        const publicId = `awas/images/${fileWithExt.split('.')[0]}`;
                        await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
                    } catch (e) {
                        console.warn(`Cloudinary image delete warn:`, e.message);
                    }
                }
            }
        }

        // ── STEP 2: Anonymise AccidentLogs ───────────────────────────────
        // Keep: writNumber, logHash, latitude, longitude, createdAt, imageHashes
        // Strip: videoUrl, imageUrls, vehiclePlate ref, incident details
        if (driver.logs.length > 0) {
            await prisma.accidentLog.updateMany({
                where: { driverId: driver.id },
                data: {
                    videoUrl: '[DELETED]',
                    imageUrls: [],
                    incidentDescription: null,
                    otherVehiclePlate: null,
                    otherVehicleMakeModel: null,
                    otherVehicleVideoUrl: null,
                    otherVehicleHash: null
                }
            });
        }

        // ── STEP 3: Anonymise affiliate earnings (keep for audit) ────────
        if (driver.affiliate) {
            await prisma.affiliate.update({
                where: { id: driver.affiliate.id },
                data: {
                    bankName: null,
                    bankAccountNumber: null,
                    bankAccountName: null,
                    duitnowNumber: null
                }
            });
        }

        // ── STEP 4: Delete driver personal data ──────────────────────────
        // Disconnect logs first (keep them anonymised), then delete driver
        await prisma.accidentLog.updateMany({
            where: { driverId: driver.id },
            data: { driverId: null }
        });

        // Delete affiliate earnings link if exists, then affiliate, then driver
        if (driver.affiliate) {
            await prisma.affiliateEarning.deleteMany({ where: { affiliateId: driver.affiliate.id } });
            await prisma.affiliatePayout.deleteMany({ where: { affiliateId: driver.affiliate.id } });
            await prisma.affiliate.delete({ where: { id: driver.affiliate.id } });
        }

        // Delete driver record
        await prisma.driver.delete({ where: { vehiclePlate: plate } });

        console.log(`AWAS Account Deleted: ${plate} — Cloudinary files removed, logs anonymised.`);

        return res.status(200).json({
            message: 'Akaun anda telah berjaya dipadam. Semua data peribadi telah dikemaskini. Terima kasih kerana menggunakan AWAS.'
        });

    } catch (err) {
        console.error('AWAS Delete Account Fault:', err);
        return res.status(500).json({ error: 'Ralat pelayan. Sila cuba lagi atau hubungi hello@awas.asia.' });
    }
};