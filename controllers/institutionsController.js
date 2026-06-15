// ==========================================
// FILE: controllers/institutionsController.js
// ==========================================
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const axios = require('axios');
const { Resend } = require('resend');
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

const INSTITUTION_FEE = 100.00;
const TOYYIBPAY_BASE_URL = process.env.TOYYIBPAY_BASE_URL || 'https://toyyibpay.com';

// ─── HELPER: Create ToyyibPay Bill ───────────────────────────────────────────
const createToyyibpayBill = async ({ billName, billDescription, billAmount, billExternalReferenceNo, billTo, billEmail, billReturnUrl }) => {
    const params = new URLSearchParams();
    params.append('userSecretKey', process.env.TOYYIBPAY_SECRET_KEY);
    params.append('categoryCode', process.env.TOYYIBPAY_CATEGORY_CODE);
    params.append('billName', billName);
    params.append('billDescription', billDescription);
    params.append('billPriceSetting', '1');
    params.append('billPayorInfo', '1');
    params.append('billAmount', String(Math.round(billAmount * 100)));
    params.append('billReturnUrl', billReturnUrl);
    params.append('billCallbackUrl', `${process.env.BE_URL}/api/payment/webhook`);
    params.append('billExternalReferenceNo', String(billExternalReferenceNo));
    params.append('billTo', billTo || '');
    params.append('billEmail', billEmail || 'noreply@awas.asia');
    params.append('billSplitPayment', '0');
    params.append('billSplitPaymentArgs', '');
    params.append('billPaymentChannel', '0');
    params.append('billDisplayMerchant', '1');
    params.append('billContentEmail', 'Terima kasih. Pembayaran pengesahan writ AWAS anda telah diterima.');
    params.append('billChargeToCustomer', '0');
    params.append('enableDuitNowQR', '1');
    params.append('chargeDuitNowQR', '0');

    const response = await axios.post(
        `${TOYYIBPAY_BASE_URL}/index.php/api/createBill`,
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (!response.data || !response.data[0] || !response.data[0].BillCode) {
        throw new Error(`ToyyibPay createBill failed: ${JSON.stringify(response.data)}`);
    }

    return response.data[0].BillCode;
};

// ─── REQUEST ACCESS ───────────────────────────────────────────────────────────
// Insurer/lawyer submits a verification request for a specific writ.
// Creates VerificationRequest with PENDING status + unique consentToken.
// Sends email to admin notifying new request — admin then triggers consent
// to driver via triggerConsent in adminController.
exports.requestAccess = async (req, res) => {
    try {
        const { logHash, caseReferenceNo } = req.body;
        const { id: institutionalUserId, requesterType } = req.institution;

        if (!logHash || !caseReferenceNo) {
            return res.status(400).json({ error: 'Missing required parameters.' });
        }

        const log = await prisma.accidentLog.findUnique({
            where: { logHash },
            include: { driver: true }
        });
        if (!log) {
            return res.status(404).json({ error: 'No matching AWAS forensic record found.' });
        }

        const institutionalUser = await prisma.institutionalUser.findUnique({
            where: { id: institutionalUserId }
        });

        // Check for duplicate pending request
        const existing = await prisma.verificationRequest.findFirst({
            where: {
                logHash,
                institutionalUserId,
                approvalStatus: 'PENDING'
            }
        });
        if (existing) {
            return res.status(409).json({
                error: 'A pending verification request already exists for this writ.',
                ticketId: existing.id
            });
        }

        const consentToken = crypto.randomUUID();

        const ticket = await prisma.verificationRequest.create({
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

        // Notify admin of new verification request
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: process.env.ADMIN_EMAIL || 'hello@awas.asia',
                subject: `[AWAS] Permintaan Pengesahan Baru — ${institutionalUser.companyName}`,
                html: `
                    <h2>Permintaan Pengesahan Writ Baharu</h2>
                    <p><strong>Syarikat:</strong> ${institutionalUser.companyName}</p>
                    <p><strong>Jenis:</strong> ${requesterType}</p>
                    <p><strong>Nombor Kes:</strong> ${caseReferenceNo}</p>
                    <p><strong>Writ:</strong> ${log.writNumber}</p>
                    <p><strong>Plat Kenderaan:</strong> ${log.vehiclePlate}</p>
                    <p><strong>Ticket ID:</strong> ${ticket.id}</p>
                    <p>Sila log masuk ke Admin AWAS untuk menghantar consent kepada pemandu.</p>
                    <p><a href="${process.env.BE_URL}/admin">Buka Admin AWAS</a></p>
                `
            });
        } catch (emailErr) {
            console.error('AWAS: Admin notification email fault:', emailErr);
            // Non-fatal — ticket already created
        }

        console.log(`AWAS: Verification request ${ticket.id} created by ${institutionalUser.companyName}`);

        return res.status(202).json({
            message: 'Permintaan diterima. Menunggu kelulusan admin dan consent pemandu.',
            ticketId: ticket.id,
            status: 'PENDING'
        });

    } catch (error) {
        console.error('AWAS requestAccess Fault:', error);
        return res.status(500).json({ error: 'Request processing error.' });
    }
};

// ─── APPROVE CONSENT (driver taps link) ──────────────────────────────────────
// No login required — consentToken in URL IS the authentication.
// GET /api/institutions/consent/:token/approve
exports.approveConsent = async (req, res) => {
    try {
        const { token } = req.params;

        const ticket = await prisma.verificationRequest.findUnique({
            where: { consentToken: token },
            include: { institutionalUser: true, accidentLog: true }
        });

        if (!ticket) {
            return res.status(404).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
                <h2>❌ Pautan Tidak Sah</h2>
                <p>Token consent tidak dijumpai atau telah tamat tempoh.</p>
                </body></html>
            `);
        }

        if (ticket.approvalStatus !== 'PENDING') {
            return res.status(200).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
                <h2>ℹ️ Sudah Diproses</h2>
                <p>Permintaan ini telah ${ticket.approvalStatus === 'APPROVED' ? 'diluluskan' : 'ditolak'} sebelum ini.</p>
                </body></html>
            `);
        }

        await prisma.verificationRequest.update({
            where: { consentToken: token },
            data: {
                approvalStatus: 'APPROVED',
                driverApprovedAt: new Date()
            }
        });

        // Notify institution that consent obtained
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: ticket.institutionalUser.email,
                subject: `[AWAS] Consent Diperoleh — Sila Teruskan Pembayaran`,
                html: `
                    <h2>✅ Consent Pemandu Diperoleh</h2>
                    <p>Pemandu telah bersetuju untuk memberikan akses kepada bukti kemalangan.</p>
                    <p><strong>Writ:</strong> ${ticket.accidentLog.writNumber}</p>
                    <p><strong>Nombor Kes Anda:</strong> ${ticket.caseReferenceNo}</p>
                    <p><strong>Ticket ID:</strong> ${ticket.id}</p>
                    <p>Sila log masuk ke portal AWAS untuk meneruskan pembayaran RM100 bagi mendapatkan Sijil Pengesahan Rasmi.</p>
                    <p><a href="${process.env.FE_URL}/institution-portal.html">Log Masuk Portal AWAS</a></p>
                `
            });
        } catch (emailErr) {
            console.error('AWAS: Institution consent notification fault:', emailErr);
        }

        // Notify admin
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: process.env.ADMIN_EMAIL || 'hello@awas.asia',
                subject: `[AWAS] Consent Diperoleh — Ticket ${ticket.id}`,
                html: `
                    <p>Pemandu telah bersetuju untuk ticket ${ticket.id}.</p>
                    <p>Writ: ${ticket.accidentLog.writNumber}</p>
                    <p>Syarikat: ${ticket.companyName}</p>
                `
            });
        } catch (emailErr) {
            console.error('AWAS: Admin consent notification fault:', emailErr);
        }

        console.log(`AWAS: Consent APPROVED for ticket ${ticket.id}`);

        return res.status(200).send(`
            <html>
            <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
            <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f1f5f9;">
            <div style="background:white;border-radius:12px;padding:40px;max-width:480px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
            <div style="font-size:3rem;margin-bottom:16px;">✅</div>
            <h2 style="color:#15803d;">Consent Diberikan</h2>
            <p style="color:#64748b;">Terima kasih. Anda telah bersetuju untuk memberikan akses kepada bukti kemalangan anda kepada <strong>${ticket.companyName}</strong>.</p>
            <p style="color:#64748b;font-size:0.85rem;margin-top:16px;">Keputusan ini telah direkodkan dalam pelayan AWAS dan dilindungi oleh PDPA.</p>
            </div>
            </body></html>
        `);

    } catch (error) {
        console.error('AWAS approveConsent Fault:', error);
        return res.status(500).send('<html><body><h2>Ralat Pelayan</h2><p>Sila cuba lagi.</p></body></html>');
    }
};

// ─── REJECT CONSENT (driver taps link) ───────────────────────────────────────
// GET /api/institutions/consent/:token/reject
exports.rejectConsent = async (req, res) => {
    try {
        const { token } = req.params;

        const ticket = await prisma.verificationRequest.findUnique({
            where: { consentToken: token },
            include: { institutionalUser: true, accidentLog: true }
        });

        if (!ticket) {
            return res.status(404).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
                <h2>❌ Pautan Tidak Sah</h2>
                <p>Token consent tidak dijumpai atau telah tamat tempoh.</p>
                </body></html>
            `);
        }

        if (ticket.approvalStatus !== 'PENDING') {
            return res.status(200).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
                <h2>ℹ️ Sudah Diproses</h2>
                <p>Permintaan ini telah ${ticket.approvalStatus === 'APPROVED' ? 'diluluskan' : 'ditolak'} sebelum ini.</p>
                </body></html>
            `);
        }

        await prisma.verificationRequest.update({
            where: { consentToken: token },
            data: { approvalStatus: 'REJECTED' }
        });

        // Notify institution of rejection
        try {
            await resend.emails.send({
                from: 'AWAS <hello@awas.asia>',
                to: ticket.institutionalUser.email,
                subject: `[AWAS] Permintaan Ditolak — Ticket ${ticket.id}`,
                html: `
                    <h2>❌ Permintaan Ditolak</h2>
                    <p>Pemandu telah menolak permintaan akses untuk writ <strong>${ticket.accidentLog.writNumber}</strong>.</p>
                    <p>Nombor Kes: ${ticket.caseReferenceNo}</p>
                    <p>Jika anda mempunyai pertanyaan, sila hubungi hello@awas.asia.</p>
                `
            });
        } catch (emailErr) {
            console.error('AWAS: Institution rejection notification fault:', emailErr);
        }

        console.log(`AWAS: Consent REJECTED for ticket ${ticket.id}`);

        return res.status(200).send(`
            <html>
            <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
            <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f1f5f9;">
            <div style="background:white;border-radius:12px;padding:40px;max-width:480px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
            <div style="font-size:3rem;margin-bottom:16px;">❌</div>
            <h2 style="color:#dc2626;">Permintaan Ditolak</h2>
            <p style="color:#64748b;">Anda telah menolak permintaan akses daripada <strong>${ticket.companyName}</strong>.</p>
            <p style="color:#64748b;font-size:0.85rem;margin-top:16px;">Keputusan ini telah direkodkan. Tiada maklumat anda akan dikongsi.</p>
            </div>
            </body></html>
        `);

    } catch (error) {
        console.error('AWAS rejectConsent Fault:', error);
        return res.status(500).send('<html><body><h2>Ralat Pelayan</h2><p>Sila cuba lagi.</p></body></html>');
    }
};

// ─── GET MY REQUESTS ──────────────────────────────────────────────────────────
// Institution's own dashboard — list all their verification requests + status.
exports.getMyRequests = async (req, res) => {
    try {
        const { id: institutionalUserId } = req.institution;

        const requests = await prisma.verificationRequest.findMany({
            where: { institutionalUserId },
            orderBy: { createdAt: 'desc' },
            include: {
                accidentLog: {
                    select: {
                        writNumber: true,
                        vehiclePlate: true,
                        createdAt: true
                    }
                },
                certificate: {
                    select: { certNumber: true, issuedAt: true }
                },
                payment: {
                    select: { status: true, amount: true, toyyibpayUrl: true }
                }
            }
        });

        const formatted = requests.map(r => ({
            ticketId: r.id,
            writNumber: r.accidentLog.writNumber,
            vehiclePlate: r.accidentLog.vehiclePlate,
            caseReferenceNo: r.caseReferenceNo,
            approvalStatus: r.approvalStatus,
            isPaymentSettled: r.isPaymentSettled,
            driverApprovedAt: r.driverApprovedAt,
            createdAt: r.createdAt,
            payment: r.payment || null,
            certificate: r.certificate || null
        }));

        return res.status(200).json({ count: requests.length, requests: formatted });

    } catch (error) {
        console.error('AWAS getMyRequests Fault:', error);
        return res.status(500).json({ error: 'Failed to fetch requests.' });
    }
};

// ─── CREATE INSTITUTION BILL (RM100) ─────────────────────────────────────────
// Called by institution after driver consent obtained (approvalStatus=APPROVED).
// Creates RM100 ToyyibPay bill linked to the VerificationRequest.
// Return URL: institution-portal.html so they land back on their dashboard.
exports.createInstitutionBill = async (req, res) => {
    try {
        const { ticketId } = req.body;
        const { id: institutionalUserId } = req.institution;

        if (!ticketId) {
            return res.status(400).json({ error: 'Ticket ID diperlukan.' });
        }

        const ticket = await prisma.verificationRequest.findUnique({
            where: { id: parseInt(ticketId) },
            include: {
                accidentLog: true,
                institutionalUser: true,
                payment: true
            }
        });

        if (!ticket) {
            return res.status(404).json({ error: 'Ticket tidak dijumpai.' });
        }

        if (ticket.institutionalUserId !== institutionalUserId) {
            return res.status(403).json({ error: 'Akses ditolak.' });
        }

        if (ticket.approvalStatus !== 'APPROVED') {
            return res.status(400).json({ error: `Consent belum diperoleh. Status: ${ticket.approvalStatus}` });
        }

        if (ticket.isPaymentSettled) {
            return res.status(409).json({ error: 'Pembayaran sudah diselesaikan untuk ticket ini.' });
        }

        if (ticket.payment) {
            return res.status(409).json({
                error: 'Bil sudah wujud.',
                paymentUrl: ticket.payment.toyyibpayUrl
            });
        }

        const payment = await prisma.payment.create({
            data: {
                institutionalUserId,
                amount: INSTITUTION_FEE,
                type: 'INSTITUTION',
                status: 'PENDING',
                verificationRequestId: ticket.id
            }
        });

        const returnUrl = `${process.env.FE_URL}/institution-portal.html?verified=1&ticket=${ticket.id}`;

        let billCode;
        try {
            billCode = await createToyyibpayBill({
                billName: `AWAS-CERT-${ticket.id}`,
                billDescription: `AWAS Verification Certificate - ${ticket.accidentLog.writNumber}`,
                billAmount: INSTITUTION_FEE,
                billExternalReferenceNo: payment.id,
                billTo: ticket.institutionalUser.companyName,
                billEmail: ticket.institutionalUser.email,
                billReturnUrl: returnUrl
            });
        } catch (toyyibErr) {
            await prisma.payment.delete({ where: { id: payment.id } });
            console.error('AWAS: Institution bill ToyyibPay fault:', toyyibErr);
            return res.status(500).json({ error: 'Ralat semasa mencipta bil. Sila cuba lagi.' });
        }

        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                toyyibpayBillCode: billCode,
                toyyibpayUrl: `${TOYYIBPAY_BASE_URL}/${billCode}`
            }
        });

        console.log(`AWAS: Institution bill created for ticket ${ticket.id} paymentId=${payment.id}`);

        return res.status(201).json({
            paymentId: payment.id,
            billCode,
            paymentUrl: `${TOYYIBPAY_BASE_URL}/${billCode}`,
            amount: INSTITUTION_FEE
        });

    } catch (error) {
        console.error('AWAS createInstitutionBill Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa mencipta bil.' });
    }
};

// ─── GET CERTIFICATE ──────────────────────────────────────────────────────────
// Fetches certificate by certNumber for cert.html page.
// Public endpoint — certNumber in URL is enough, no login required.
// The certificate itself contains no sensitive data beyond what's
// already on the writ — it certifies AWAS has verified the evidence.
exports.getCertificate = async (req, res) => {
    try {
        const { certNumber } = req.params;

        if (!certNumber) {
            return res.status(400).json({ error: 'Cert number diperlukan.' });
        }

        const cert = await prisma.verificationCertificate.findUnique({
            where: { certNumber },
            include: {
                verificationRequest: {
                    include: {
                        accidentLog: true,
                        institutionalUser: true
                    }
                }
            }
        });

        if (!cert) {
            return res.status(404).json({ error: 'Sijil tidak dijumpai.' });
        }

        const req2 = cert.verificationRequest;
        const log = req2.accidentLog;
        const institution = req2.institutionalUser;

        return res.status(200).json({
            certNumber: cert.certNumber,
            certHash: cert.certHash,
            issuedAt: cert.issuedAt,
            verificationRequest: {
                ticketId: req2.id,
                caseReferenceNo: req2.caseReferenceNo,
                companyName: req2.companyName,
                requesterType: req2.requesterType,
                driverApprovedAt: req2.driverApprovedAt
            },
            accidentLog: {
                writNumber: log.writNumber,
                vehiclePlate: log.vehiclePlate,
                logHash: log.logHash,
                videoHash: log.videoHash,
                imageHashes: log.imageHashes || [],
                rawVideoUrl: log.rawVideoUrl,
                imageUrls: log.imageUrls || [],
                latitude: log.latitude,
                longitude: log.longitude,
                incidentDescription: log.incidentDescription,
                roadCondition: log.roadCondition,
                weatherCondition: log.weatherCondition,
                injuryStatus: log.injuryStatus,
                videoSealedAt: log.videoSealedAt,
                createdAt: log.createdAt
            }
        });

    } catch (error) {
        console.error('AWAS getCertificate Fault:', error);
        return res.status(500).json({ error: 'Ralat semasa mengambil sijil.' });
    }
};