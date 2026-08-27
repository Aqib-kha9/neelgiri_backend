const roleCheck = (roles) => {
    const allowedRoles = Array.isArray(roles) ? roles : [roles];

    return (req, res, next) => {
        const roleName = req.user?.role?.name || req.user?.role;

        if (!roleName || !allowedRoles.includes(roleName)) {
            return res.status(403).json({
                message: `User role ${roleName || 'unknown'} is not authorized to access this route`
            });
        }

        next();
    };
};

module.exports = { roleCheck };
