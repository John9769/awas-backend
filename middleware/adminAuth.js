module.exports = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'] || req.query.key;

    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid admin key.' });
    }

    next();
};