const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

exports.requestAccess = async (req, res) => {
    try {
        const { logHash, caseReferenceNo } = req.body;
        const { id: institutionalUserId, requesterType } = req.institution; // from JWT

        if (!logHash || !caseReferenceNo) {
            return res.status(400).json({ error: "Missing required parameters." });
        }

        const logExists = await prisma.accidentLog.findUnique({ where: { logHash } });
        if (!logExists) {
            return res.status(404).json({ error: "No matching AWAS forensic record found." });
        }

        const institutionalUser = await prisma.institutionalUser.findUnique({
            where: { id: institutionalUserId }
        });

        const consentToken = crypto.randomUUID();

        const verificationTicket = await prisma.verificationRequest.create({
            data: {
                logHash,
                institutionalUserId,
                requesterType,
                companyName: institutionalUser.companyName,
                caseReferenceNo,
                approvalStatus: 'PENDING',
                consentToken
            }
        });

        // TODO Phase 2: Send WhatsApp to driver via UltraMsg with consent link
        // GET driver phone from accidentLog → driver.phone
        console.log(`[AWAS CONSENT] Ticket ${verificationTicket.id} | Token: ${consentToken}`);

        res.status(202).json({
            message: "Request queued. Awaiting driver consent.",
            ticketId: verificationTicket.id,
            status: "PENDING"
        });

    } catch (error) {
        console.error("AWAS B2B Request Fault:", error);
        res.status(500).json({ error: "Request processing error." });
    }
};

exports.driverAuthorize = async (req, res) => {
    try {
        const { consentToken, approve } = req.body;

        if (!consentToken) {
            return res.status(400).json({ error: "Missing consent token." });
        }

        const ticket = await prisma.verificationRequest.findUnique({
            where: { consentToken }
        });

        if (!ticket) {
            return res.status(404).json({ error: "Invalid consent token." });
        }

        if (ticket.approvalStatus !== 'PENDING') {
            return res.status(409).json({ error: `Request already ${ticket.approvalStatus}.` });
        }

        const targetStatus = approve ? 'APPROVED' : 'REJECTED';
        const approvalTimestamp = approve ? new Date() : null;

        const updatedTicket = await prisma.verificationRequest.update({
            where: { consentToken },
            data: {
                approvalStatus: targetStatus,
                driverApprovedAt: approvalTimestamp
            }
        });

        res.status(200).json({
            message: `Consent ${targetStatus}.`,
            status: updatedTicket.approvalStatus
        });

    } catch (error) {
        console.error("AWAS Consent Fault:", error);
        res.status(500).json({ error: "Consent update error." });
    }
};

exports.unlockEvidence = async (req, res) => {
    try {
        const { ticketId } = req.body;
        const { id: institutionalUserId } = req.institution; // from JWT

        if (!ticketId) return res.status(400).json({ error: "Missing ticket ID." });

        const ticket = await prisma.verificationRequest.findUnique({
            where: { id: parseInt(ticketId) },
            include: {
                accidentLog: {
                    include: { driver: true }
                }
            }
        });

        if (!ticket) return res.status(404).json({ error: "Ticket not found." });

        if (ticket.institutionalUserId !== institutionalUserId) {
            return res.status(403).json({ error: "Access Denied: Ticket does not belong to your account." });
        }

        if (ticket.approvalStatus !== 'APPROVED') {
            return res.status(403).json({ error: `Access Denied: Status is ${ticket.approvalStatus}.` });
        }

        // TODO Phase 2: Verify Billplz payment before settling

        const settledTicket = await prisma.verificationRequest.update({
            where: { id: parseInt(ticketId) },
            data: { isPaymentSettled: true }
        });

        const accessRate = ticket.requesterType === 'INSURANCE' ? 'RM 50.00' : 'RM 100.00';

        res.status(200).json({
            meta: {
                billingRate: accessRate,
                transactionSettled: settledTicket.isPaymentSettled,
                consentSignedAt: ticket.driverApprovedAt
            },
            evidenceBundle: {
                signatureHash: ticket.accidentLog.logHash,
                geotag: {
                    latitude: ticket.accidentLog.latitude,
                    longitude: ticket.accidentLog.longitude
                },
                forensicAssetUrl: ticket.accidentLog.videoUrl,
                driverMetadata: {
                    vehiclePlate: ticket.accidentLog.driver.vehiclePlate,
                    vehicleModel: ticket.accidentLog.driver.vehicleMakeModel,
                    mykadLastFour: ticket.accidentLog.driver.mykadLastFour
                }
            }
        });

    } catch (error) {
        console.error("AWAS Evidence Unlock Fault:", error);
        res.status(500).json({ error: "Evidence delivery error." });
    }
};