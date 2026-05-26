// ==========================================
// FILE: controllers/mapsController.js
// ==========================================
const https = require('https');

exports.getStaticMap = (req, res) => {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
        return res.status(400).json({ error: 'lat and lng required.' });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Map service not configured.' });
    }

    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=16&size=560x200&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${apiKey}`;

    https.get(mapUrl, (mapRes) => {
        const chunks = [];

        mapRes.on('data', (chunk) => chunks.push(chunk));

        mapRes.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const contentType = mapRes.headers['content-type'] || 'image/png';
            const base64 = buffer.toString('base64');
            const dataUri = `data:${contentType};base64,${base64}`;

            return res.status(200).json({ mapBase64: dataUri });
        });

    }).on('error', (err) => {
        console.error('Map fetch error:', err);
        return res.status(500).json({ error: 'Failed to fetch map.' });
    });
};