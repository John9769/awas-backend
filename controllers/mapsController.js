// ==========================================
// FILE: controllers/mapsController.js
// ==========================================
const axios = require('axios');

exports.getStaticMap = async (req, res) => {
    try {
        const { lat, lng } = req.query;

        if (!lat || !lng) {
            return res.status(400).json({ error: 'lat and lng required.' });
        }

        const apiKey = process.env.GOOGLE_MAPS_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Map service not configured.' });
        }

        const googleUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=600x300&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${apiKey}`;
        console.log('AWAS Map URL:', googleUrl);

        const response = await axios.get(googleUrl, { responseType: 'arraybuffer' });

        console.log('AWAS Map Status:', response.status);
        console.log('AWAS Map Content-Type:', response.headers['content-type']);
        console.log('AWAS Map Buffer Size:', response.data.byteLength);

        res.setHeader('Content-Type', response.headers['content-type']);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(response.data);

    } catch (error) {
        console.error('AWAS Map Proxy Error:', error.message);

        if (error.response && error.response.data) {
            const errorText = Buffer.from(error.response.data).toString('utf-8');
            console.error('Google API Error Detail:', errorText);
        }

        res.status(500).send('Failed to fetch map.');
    }
};