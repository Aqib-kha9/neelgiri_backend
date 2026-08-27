/**
 * auditLogger.js
 * Fire-and-forget audit logging helper. Writes an AuditLog record capturing
 * the actor, action, resource and scope. Never throws — logging failures are
 * swallowed so they never break the primary business operation.
 */

const AuditLog = require('../models/AuditLog');
const { getEffectivePartnerId, getEffectiveBranchId } = require('./scopeHelper');

/**
 * Log an audit event.
 *
 * @param {Object} req  - Express request (used to extract user, ip, headers)
 * @param {Object} opts
 * @param {String} opts.action      - e.g. 'CREATE', 'UPDATE', 'DELETE'
 * @param {String} opts.resource    - e.g. 'driver', 'invoice'
 * @param {String|ObjectId} opts.resourceId
 * @param {String} opts.description
 * @param {Object} opts.details     - arbitrary payload snapshot
 * @param {String} opts.status      - 'success' | 'failure'
 * @param {String} opts.errorMessage
 */
const logAudit = async (req, opts = {}) => {
    try {
        const user = req?.user || null;
        const partnerId = user ? getEffectivePartnerId(user) : null;
        const branchId = user ? getEffectiveBranchId(user) : null;

        await AuditLog.create({
            action: opts.action || 'UNKNOWN',
            resource: opts.resource || 'unknown',
            resourceId: opts.resourceId || null,
            description: opts.description || '',
            details: opts.details || {},
            userId: user?._id || null,
            userName: user?.name || null,
            userRole: user?.role?.name || null,
            ipAddress: req?.ip || req?.connection?.remoteAddress || null,
            userAgent: req?.headers?.['user-agent'] || null,
            method: req?.method || null,
            path: req?.path || req?.originalUrl || null,
            partnerId,
            branchId,
            status: opts.status || 'success',
            errorMessage: opts.errorMessage || undefined
        });
    } catch (err) {
        // Never let audit logging break the request flow
        console.error('[AuditLog] Failed to write audit entry:', err.message);
    }
};

module.exports = { logAudit };
