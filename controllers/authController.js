const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = new PrismaClient();

exports.registerInstitution = async (req, res) => {
    try {
        const { email, password, companyName, requesterType, licenseId } = req.body;

        if (!email || !password || !companyName || !requesterType || !licenseId) {
            return res.status(400).json({ error: "Missing required registration parameters." });
        }

        if (!['INSURANCE', 'LAWYER'].includes(requesterType)) {
            return res.status(400).json({ error: "Invalid institution type." });
        }

        const userExists = await prisma.institutionalUser.findUnique({
            where: { email: email.toLowerCase() }
        });
        if (userExists) {
            return res.status(409).json({ error: "This corporate email is already registered." });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        await prisma.institutionalUser.create({
            data: {
                email: email.toLowerCase(),
                passwordHash: hashedPassword,
                companyName,
                requesterType,
                licenseId,
                isApproved: false
            }
        });

        res.status(201).json({ message: "Registration submitted. Pending license validation." });

    } catch (error) {
        console.error("AWAS B2B Signup Fault:", error);
        res.status(500).json({ error: "Internal registration error." });
    }
};

exports.loginInstitution = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Missing credentials." });
        }

        const corporateUser = await prisma.institutionalUser.findUnique({
            where: { email: email.toLowerCase() }
        });

        if (!corporateUser) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        const passwordMatch = await bcrypt.compare(password, corporateUser.passwordHash);
        if (!passwordMatch) {
            return res.status(401).json({ error: "Invalid credentials." });
        }

        if (!corporateUser.isApproved) {
            return res.status(403).json({ error: "Account pending PIAM/Bar Council license review." });
        }

        const token = jwt.sign(
            {
                id: corporateUser.id,
                email: corporateUser.email,
                requesterType: corporateUser.requesterType
            },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.status(200).json({
            message: "Authentication successful.",
            token,
            companyName: corporateUser.companyName,
            requesterType: corporateUser.requesterType
        });

    } catch (error) {
        console.error("AWAS B2B Login Fault:", error);
        res.status(500).json({ error: "Internal login error." });
    }
};