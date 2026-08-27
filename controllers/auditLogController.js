/**
 * auditLogController.js
 * Production-grade Audit Log viewer with filtering, pagination, stats, and export.
 *
 * Endpoints:
 *   - getAuditLogs (paginated, filtered by action/resource/user/date)
 *   - getAuditLogById
 *   - getAuditLogStats (action breakdown, resource breakdown, top users)
 *   - getAuditLogsByResource (all logs for a specific resource)
 *   - getAuditLogsByUser (all logs by a specific user)
 *   - exportAuditLogs (CSV/JSON export)
 *   - deleteOldLogs (retention cleanup)
 */

const AuditLog = require('../models/AuditLog');
const { buildScopeQuery } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// @desc    Get audit logs (paginated, filtered)
// @route   GET /api/audit-logs
// @access  Private
exports.getAuditLogs = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({ data: [], total: 0, page: 1, pages: 1 });

        const {
            page = 1,
            limit = 50,
            search,
            action,
            resource,
            resourceId,
            userId,
            status,
            startDate,
            endDate,
            ipAddress,
            sortBy = 'createdAt',
            sortOrder = 'desc'
        } = req.query;

        const query = { ...scope };

        if (action) query.action = action;
        if (resource) query.resource = resource;
        if (resourceId) query.resourceId = resourceId;
        if (userId) query.userId = userId;
        if (status) query.status = status;
        if (ipAddress) query.ipAddress = { $regex: ipAddress, $options: 'i' };

        if (startDate && endDate) {
            const s = new Date(startDate); s.setHours(0, 0, 0, 0);
            const e = new Date(endDate); e.setHours(23, 59, 59, 999);
            query.createdAt = { $gte: s, $lte: e };
        } else if (startDate) {
            const s = new Date(startDate); s.setHours(0, 0, 0, 0);
            query.createdAt = { $gte: s };
        } else if (endDate) {
            const e = new Date(endDate); e.setHours(23, 59, 59, 999);
            query.createdAt = { $lte: e };
        }

        if (search) {
            query.$or = [
                { description: { $regex: search, $options: 'i' } },
                { userName: { $regex: search, $options: 'i' } },
                { resource: { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const sort = {};
        sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

        const [total, logs] = await Promise.all([
            AuditLog.countDocuments(query),
            AuditLog.find(query)
                .populate('userId', 'name email role')
                .sort(sort)
                .skip(skip)
                .limit(parseInt(limit))
                .lean()
        ]);

        res.json({
            data: logs,
            total,
            page: parseInt(page),
            pages: Math.ceil(total / parseInt(limit))
        });
    } catch (err) {
        console.error('[getAuditLogs] Error:', err);
        res.status(500).json({ message: 'Server error fetching audit logs' });
    }
};

// @desc    Get audit log by ID
// @route   GET /api/audit-logs/:id
// @access  Private
exports.getAuditLogById = async (req, res) => {
    try {
        const log = await AuditLog.findById(req.params.id)
            .populate('userId', 'name email role');

        if (!log) {
            return res.status(404).json({ message: 'Audit log not found' });
        }

        res.json(log);
    } catch (err) {
        console.error('[getAuditLogById] Error:', err);
        res.status(500).json({ message: 'Server error fetching audit log' });
    }
};

// @desc    Get audit log stats
// @route   GET /api/audit-logs/stats
// @access  Private
exports.getAuditLogStats = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({});

        const { startDate, endDate } = req.query;

        const dateMatch = {};
        if (startDate && endDate) {
            const s = new Date(startDate); s.setHours(0, 0, 0, 0);
            const e = new Date(endDate); e.setHours(23, 59, 59, 999);
            dateMatch.createdAt = { $gte: s, $lte: e };
        }

        const query = { ...scope, ...dateMatch };

        const [total, successCount, failureCount, actionBreakdown, resourceBreakdown, topUsers, dailyTrend] = await Promise.all([
            AuditLog.countDocuments(query),
            AuditLog.countDocuments({ ...query, status: 'success' }),
            AuditLog.countDocuments({ ...query, status: 'failure' }),
            AuditLog.aggregate([
                { $match: query },
                { $group: { _id: '$action', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 20 }
            ]),
            AuditLog.aggregate([
                { $match: query },
                { $group: { _id: '$resource', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 20 }
            ]),
            AuditLog.aggregate([
                { $match: query },
                { $group: { _id: { userId: '$userId', userName: '$userName' }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ]),
            AuditLog.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        count: { $sum: 1 },
                        success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
                        failure: { $sum: { $cond: [{ $eq: ['$status', 'failure'] }, 1, 0] } }
                    }
                },
                { $sort: { _id: 1 } },
                { $limit: 30 }
            ])
        ]);

        res.json({
            total,
            successCount,
            failureCount,
            successRate: total > 0 ? ((successCount / total) * 100).toFixed(1) : 0,
            actionBreakdown: actionBreakdown.map(a => ({ action: a._id, count: a.count })),
            resourceBreakdown: resourceBreakdown.map(r => ({ resource: r._id, count: r.count })),
            topUsers: topUsers.map(u => ({
                userId: u._id.userId,
                userName: u._id.userName,
                count: u.count
            })),
            dailyTrend: dailyTrend.map(d => ({
                date: d._id,
                count: d.count,
                success: d.success,
                failure: d.failure
            }))
        });
    } catch (err) {
        console.error('[getAuditLogStats] Error:', err);
        res.status(500).json({ message: 'Server error fetching audit log stats' });
    }
};

// @desc    Get audit logs by resource
// @route   GET /api/audit-logs/resource/:resource/:resourceId
// @access  Private
exports.getAuditLogsByResource = async (req, res) => {
    try {
        const { resource, resourceId } = req.params;
        const { limit = 50 } = req.query;

        const logs = await AuditLog.find({ resource, resourceId })
            .populate('userId', 'name email role')
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .lean();

        res.json({
            data: logs,
            total: logs.length
        });
    } catch (err) {
        console.error('[getAuditLogsByResource] Error:', err);
        res.status(500).json({ message: 'Server error fetching resource audit logs' });
    }
};

// @desc    Get audit logs by user
// @route   GET /api/audit-logs/user/:userId
// @access  Private
exports.getAuditLogsByUser = async (req, res) => {
    try {
        const { userId } = req.params;
        const { page = 1, limit = 50 } = req.query;

        const query = { userId };
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [total, logs] = await Promise.all([
            AuditLog.countDocuments(query),
            AuditLog.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean()
        ]);

        res.json({
            data: logs,
            total,
            page: parseInt(page),
            pages: Math.ceil(total / parseInt(limit))
        });
    } catch (err) {
        console.error('[getAuditLogsByUser] Error:', err);
        res.status(500).json({ message: 'Server error fetching user audit logs' });
    }
};

// @desc    Export audit logs (CSV or JSON)
// @route   GET /api/audit-logs/export
// @access  Private
exports.exportAuditLogs = async (req, res) => {
    try {
        const scope = buildScopeQuery(req.user);
        if (scope === null) return res.json({ data: [] });

        const { format = 'json', action, resource, startDate, endDate } = req.query;

        const query = { ...scope };
        if (action) query.action = action;
        if (resource) query.resource = resource;

        if (startDate && endDate) {
            const s = new Date(startDate); s.setHours(0, 0, 0, 0);
            const e = new Date(endDate); e.setHours(23, 59, 59, 999);
            query.createdAt = { $gte: s, $lte: e };
        }

        const logs = await AuditLog.find(query)
            .populate('userId', 'name email')
            .sort({ createdAt: -1 })
            .limit(10000)
            .lean();

        if (format === 'csv') {
            const header = 'Timestamp,User,Role,Action,Resource,ResourceId,Status,IPAddress,Method,Path,Description\n';
            const rows = logs.map(l => {
                return [
                    l.createdAt?.toISOString() || '',
                    `"${l.userName || ''}"`,
                    `"${l.userRole || ''}"`,
                    l.action || '',
                    l.resource || '',
                    l.resourceId || '',
                    l.status || '',
                    l.ipAddress || '',
                    l.method || '',
                    `"${l.path || ''}"`,
                    `"${(l.description || '').replace(/"/g, '""')}"`
                ].join(',');
            }).join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
            return res.send(header + rows);
        }

        res.json({ data: logs, total: logs.length });
    } catch (err) {
        console.error('[exportAuditLogs] Error:', err);
        res.status(500).json({ message: 'Server error exporting audit logs' });
    }
};

// @desc    Delete old audit logs (retention cleanup)
// @route   DELETE /api/audit-logs/cleanup
// @access  Private (super_admin only)
exports.deleteOldLogs = async (req, res) => {
    try {
        const { retentionDays = 90 } = req.body;

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - parseInt(retentionDays));

        const result = await AuditLog.deleteMany({
            createdAt: { $lt: cutoffDate }
        });

        await logAudit(req, {
            action: 'CLEANUP',
            resource: 'audit_log',
            description: `Deleted ${result.deletedCount} audit logs older than ${retentionDays} days`,
            details: { retentionDays, deletedCount: result.deletedCount, cutoffDate }
        });

        res.json({
            message: `Deleted ${result.deletedCount} audit logs older than ${retentionDays} days`,
            deletedCount: result.deletedCount
        });
    } catch (err) {
        console.error('[deleteOldLogs] Error:', err);
        res.status(500).json({ message: 'Server error cleaning up audit logs' });
    }
};

