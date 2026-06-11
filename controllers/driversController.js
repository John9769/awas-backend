// ==========================================
// FILE: controllers/driversController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cloudinaryV2 = require('cloudinary').v2;
const prisma = new PrismaClient();

// Configure Cloudinary once at module load
cloudinaryV2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// NOTE: registerDriver removed.
// Registration is now handled entirely by paymentController.createRegistrationBill
// Driver record is created atomically with ToyyibPay bill.
// If ToyyibPay fails, driver record is rolled back — no orphaned records.

// LOGIN DRIVER
exports.loginDriver = async (req, res) => {
    try {
        const { vehiclePlate, password } = req.body;

        if (!vehiclePlate || !password) {
            return res.status(400).json({ error: "Nombor plat dan kata laluan diperlukan." });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');
        const driver = await prisma.driver.findUnique({ where: { vehiclePlate: plate } });

        if (!driver) {
            return res.status(401).json({ error: "Nombor plat atau kata laluan salah." });
        }
        if (!driver.passwordHash) {
            return res.status(409).json({ error: "Akaun ini belum mempunyai kata laluan. Sila tetapkan melalui 'Lupa Kata Laluan'.", reason: "NO_PASSWORD" });
        }

        const passwordMatch = await bcrypt.compare(password, driver.passwordHash);
        if (!passwordMatch) {
            return res.status(401).json({ error: "Nombor plat atau kata laluan salah." });
        }
        if (driver.subStatus !== 'ACTIVE' || new Date() > driver.subExpiresAt) {
            return res.status(403).json({ error: "Langganan AWAS anda belum aktif atau telah tamat. Sila bayar untuk mengaktifkan.", reason: "SUBSCRIPTION_INACTIVE" });
        }

        const token = jwt.sign(
            { plate: driver.vehiclePlate, id: driver.id },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        return res.status(200).json({
            message: "Log masuk berjaya.",
            token,
            vehiclePlate: driver.vehiclePlate,
            vehicleMakeModel: driver.vehicleMakeModel,
            vehicleType: driver.vehicleType,
            mykadLastFour: driver.mykadLastFour,
            phone: driver.phone || null,
            email: driver.email || null,
            subExpiresAt: driver.subExpiresAt,
            referralCode: driver.referralCode
        });

    } catch (err) {
        console.error('AWAS Driver Login Fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// RESET PASSWORD
exports.resetPassword = async (req, res) => {
    try {
        const { vehiclePlate, mykadLastFour, newPassword } = req.body;

        if (!vehiclePlate || !mykadLastFour || !newPassword) {
            return res.status(400).json({ error: "Semua medan diperlukan." });
        }
        if (!/^\d{4}$/.test(mykadLastFour)) {
            return res.status(400).json({ error: "MyKad 4 digit terakhir tidak sah." });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: "Kata laluan baru minimum 6 aksara." });
        }

        const plate = vehiclePlate.toUpperCase().replace(/\s+/g, '');
        const driver = await prisma.driver.findUnique({ where: { vehiclePlate: plate } });

        if (!driver || driver.mykadLastFour !== mykadLastFour) {
            return res.status(401).json({ error: "Nombor plat atau MyKad tidak sepadan." });
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await prisma.driver.update({ where: { vehiclePlate: plate }, data: { passwordHash } });

        return res.status(200).json({ message: "Kata laluan berjaya ditetapkan semula. Sila log masuk." });

    } catch (err) {
        console.error('AWAS Reset Password Fault:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
};

// LOOKUP DRIVER BY PLATE
exports.lookupDriver = async (req, res) => {
    try {
        const plate = req.params.plate.toUpperCase().replace(/\s+/g, '');
        const driver = await prisma.driver.findUnique({
            where: { vehiclePlate: plate },
            select: {
                vehiclePlate: true, vehicleMakeModel: true, vehicleType: true,
                mykadLastFour: true, subStatus: true, subExpiresAt: true, referralCode: true
            }
        });

        if (!driver) return res.status(404).json({ error: 'No AWAS Record Found for this vehicle.' });
        if (driver.subStatus !== 'ACTIVE') return res.status(403).json({ error: 'AWAS subscription expired. Please renew.' });

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
                accidentLogs: true,
                affiliate: { include: { earnings: true, payouts: true } }
            }
        });

        if (!driver) return res.status(401).json({ error: 'Maklumat pengesahan tidak sepadan. Sila cuba lagi.' });
        if (!driver.passwordHash) return res.status(401).json({ error: 'Maklumat pengesahan tidak sepadan. Sila cuba lagi.' });

        const passwordMatch = await bcrypt.compare(password, driver.passwordHash);
        if (!passwordMatch || driver.mykadLastFour !== mykadLastFour) {
            return res.status(401).json({ error: 'Maklumat pengesahan tidak sepadan. Sila cuba lagi.' });
        }

        // ── STEP 1: Delete Cloudinary files ─────────────────────────────
        for (const log of driver.accidentLogs) {
            if (log.videoUrl && log.videoUrl !== '[DELETED]') {
                try {
                    const urlParts = log.videoUrl.split('/');
                    const fileWithExt = urlParts[urlParts.length - 1];
                    const publicId = `awas/raw/${fileWithExt.split('.')[0]}`;
                    await cloudinaryV2.uploader.destroy(publicId, { resource_type: 'video' });
                } catch (e) {
                    console.warn(`Cloudinary video delete warn:`, e.message);
                }
            }
            if (log.imageUrls && Array.isArray(log.imageUrls)) {
                for (const imgUrl of log.imageUrls) {
                    try {
                        const urlParts = imgUrl.split('/');
                        const fileWithExt = urlParts[urlParts.length - 1];
                        const publicId = `awas/images/${fileWithExt.split('.')[0]}`;
                        await cloudinaryV2.uploader.destroy(publicId, { resource_type: 'image' });
                    } catch (e) {
                        console.warn(`Cloudinary image delete warn:`, e.message);
                    }
                }
            }
        }

        // ── STEP 2: Anonymise AccidentLogs ───────────────────────────────
        if (driver.accidentLogs.length > 0) {
            await prisma.accidentLog.updateMany({
                where: { vehiclePlate: plate },
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

        // ── STEP 3: Anonymise affiliate bank details ──────────────────────
        if (driver.affiliate) {
            await prisma.affiliate.update({
                where: { id: driver.affiliate.id },
                data: { bankName: null, bankAccountNumber: null, bankAccountName: null, duitnowNumber: null }
            });
        }

        // ── STEP 4: Delete affiliate, payments, driver ───────────────────
        if (driver.affiliate) {
            await prisma.affiliateEarning.deleteMany({ where: { affiliateId: driver.affiliate.id } });
            await prisma.affiliatePayout.deleteMany({ where: { affiliateId: driver.affiliate.id } });
            await prisma.affiliate.delete({ where: { id: driver.affiliate.id } });
        }

        await prisma.payment.deleteMany({ where: { vehiclePlate: plate } });
        await prisma.driver.delete({ where: { vehiclePlate: plate } });

        console.log(`AWAS Account Deleted: ${plate}`);

        return res.status(200).json({
            message: 'Akaun anda telah berjaya dipadam. Semua data peribadi telah dikemaskini. Terima kasih kerana menggunakan AWAS.'
        });

    } catch (err) {
        console.error('AWAS Delete Account Fault:', err);
        return res.status(500).json({ error: 'Ralat pelayan. Sila cuba lagi atau hubungi hello@awas.asia.' });
    }
};