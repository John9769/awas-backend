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