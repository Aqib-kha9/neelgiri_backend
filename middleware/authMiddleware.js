const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }

    const token = authorization.slice(7).trim();
    if (!token) {
        return res.status(401).json({ message: 'Not authorized, no token' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password').populate({
            path: 'role',
            populate: { path: 'permissions' }
        });

        if (!user) {
            return res.status(401).json({ message: 'Not authorized, user no longer exists' });
        }

        if (user.isInactive || user.status === 'inactive') {
            return res.status(403).json({ message: 'Your account is inactive' });
        }

        if (user.isPaused) {
            return res.status(403).json({
                message: 'Your account has been paused by administrator',
                isPaused: true
            });
        }

        req.user = user;
        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Not authorized, token failed' });
    }
};

module.exports = { protect };
