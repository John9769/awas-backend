const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.registerDriver = async (req, res) => {
    try {
        const { vehiclePlate, vehicleMakeModel, vehicleType, mykadLastFour, phone, consentGiven } = req.body;

        if (!consentGiven) {
            return res.status(400).json({ error: "PDPA Consent Mandatory: Authorize data retention to complete registration." });
        }

        if (!vehiclePlate || !vehicleMakeModel || !mykadLastFour) {
            return res.status(400).json({ error: "Missing required profile fields." });
        }

        if (!/^\d{4}$/.test(mykadLastFour)) {
            return res.status(400).json({ error: "Invalid MyKad input. Supply last 4 digits only." });
        }

        if (vehicleType && !['CAR', 'MOTORCYCLE'].includes(vehicleType)) {
            return res.status(400).json({ error: "Invalid vehicle type. Accepted: CAR or MOTORCYCLE." });
        }

        const normalizedPlate = vehiclePlate.toUpperCase().replace(/\s+/g, '');
        const expiryDate = new Date();
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);

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
                subExpiresAt: expiryDate
            }
        });

        res.status(201).json({
            message: "Vehicle profile registered successfully.",
            vehicleType: userProfile.vehicleType,
            expiry: userProfile.subExpiresAt
        });

    } catch (error) {
        console.error("AWAS Driver Registration Fault:", error);
        res.status(500).json({ error: "Internal registry error." });
    }
};