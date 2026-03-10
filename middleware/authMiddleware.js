const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        try {
            token = req.headers.authorization.split(' ')[1];

            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            console.log(`🔐 [Auth] Token valid for User ID: ${decoded.id}`);

            req.user = await User.findById(decoded.id).select('-password').populate({
                path: 'role',
                populate: { path: 'permissions' }
            });

            console.log(`👤 [Auth] User: ${req.user?.name}, Role: ${req.user?.role?.name}, Branch: ${req.user?.branchId}`);

            if (req.user && req.user.isPaused) {
                return res.status(403).json({
                    message: 'Your account has been paused by administrator',
                    isPaused: true
                });
            }

            next();
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Not authorized, no token' });
    }
};

module.exports = { protect };
