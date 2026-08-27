const asyncHandler = require('express-async-handler');
const Exception = require('../models/Exception');
const { generateExceptionId } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// @desc    Get all exceptions (role-scoped)
// @route   GET /api/exceptions
// @access  Private
const getExceptions = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, type, severity, status, startDate, endDate } = req.query;
    if (search) {
        query.$or = [
            { exceptionId: { $regex: search, $options: 'i' } },
            { awb: { $regex: search, $options: 'i' } },
            { title: { $regex: search, $options: 'i' } }
        ];
    }
    if (type && type !== 'ALL') query.type = type;
    if (severity && severity !== 'ALL') query.severity = severity;
    if (status && status !== 'ALL') query.status = status;
    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [exceptions, total] = await Promise.all([
        Exception.find(query)
            .populate('shipmentId', 'awb sender receiver status')
            .populate('createdBy', 'name email')
            .populate('resolvedBy', 'name email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Exception.countDocuments(query)
    ]);

    res.json({
        data: exceptions,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
});

// @desc    Get exception stats
// @route   GET /api/exceptions/stats
// @access  Private
const getExceptionStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, open, investigating, resolved, closed, escalated, critical, high] = await Promise.all([
        Exception.countDocuments(query),
        Exception.countDocuments({ ...query, status: 'OPEN' }),
        Exception.countDocuments({ ...query, status: 'INVESTIGATING' }),
        Exception.countDocuments({ ...query, status: 'RESOLVED' }),
        Exception.countDocuments({ ...query, status: 'CLOSED' }),
        Exception.countDocuments({ ...query, status: 'ESCALATED' }),
        Exception.countDocuments({ ...query, severity: 'CRITICAL' }),
        Exception.countDocuments({ ...query, severity: 'HIGH' })
    ]);

    // By type breakdown
    const typeBreakdown = await Exception.aggregate([
        { $match: query },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
    ]);

    // Financial impact
    const financialAgg = await Exception.aggregate([
        { $match: query },
        { $group: { _id: null, totalClaims: { $sum: '$financialImpact.claimAmount' }, totalApproved: { $sum: '$financialImpact.approvedAmount' }, totalRecovered: { $sum: '$financialImpact.recoveredAmount' } } }
    ]);
    const financial = financialAgg[0] || { totalClaims: 0, totalApproved: 0, totalRecovered: 0 };

    res.json({
        total,
        open,
        investigating,
        resolved,
        closed,
        escalated,
        critical,
        high,
        typeBreakdown: typeBreakdown.map((t) => ({ type: t._id, count: t.count })),
        totalClaims: Number(financial.totalClaims.toFixed(2)),
        totalApproved: Number(financial.totalApproved.toFixed(2)),
        totalRecovered: Number(financial.totalRecovered.toFixed(2))
    });
});

// @desc    Get single exception
// @route   GET /api/exceptions/:id
// @access  Private
const getExceptionById = asyncHandler(async (req, res) => {
    const exception = await Exception.findById(req.params.id)
        .populate('shipmentId')
        .populate('createdBy', 'name email')
        .populate('resolvedBy', 'name email')
        .populate('escalatedTo', 'name email')
        .populate('actions.performedBy', 'name email');
    if (!exception || exception.isDeleted) {
        res.status(404);
        throw new Error('Exception not found');
    }
    res.json(exception);
});

// @desc    Create exception
// @route   POST /api/exceptions
// @access  Private
const createException = asyncHandler(async (req, res) => {
    const { shipmentId, awb, type, severity, category, title, description, reportedBy, location, financialImpact, attachments } = req.body;

    if (!type || !title || !description) {
        res.status(400);
        throw new Error('type, title and description are required');
    }

    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;
    const exceptionId = generateExceptionId();

    const exception = await Exception.create({
        exceptionId,
        shipmentId,
        awb,
        type,
        severity: severity || 'MEDIUM',
        category: category || 'OPERATIONAL',
        title,
        description,
        reportedBy,
        location,
        financialImpact,
        attachments: attachments || [],
        status: 'OPEN',
        partnerId,
        branchId,
        createdBy: req.user._id,
        actions: [{
            action: 'Exception created',
            performedBy: req.user._id,
            remarks: description
        }]
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'exception',
        resourceId: exception._id,
        description: `Exception ${exception.exceptionId} created: ${title}`,
        details: { type, severity, awb }
    });

    res.status(201).json(exception);
});

// @desc    Update exception
// @route   PUT /api/exceptions/:id
// @access  Private
const updateException = asyncHandler(async (req, res) => {
    const exception = await Exception.findById(req.params.id);
    if (!exception || exception.isDeleted) {
        res.status(404);
        throw new Error('Exception not found');
    }

    Object.assign(exception, req.body);
    await exception.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'exception',
        resourceId: exception._id,
        description: `Exception ${exception.exceptionId} updated`,
        details: req.body
    });

    res.json(exception);
});

// @desc    Resolve exception
// @route   PUT /api/exceptions/:id/resolve
// @access  Private
const resolveException = asyncHandler(async (req, res) => {
    const { resolution, approvedAmount } = req.body;

    if (!resolution) {
        res.status(400);
        throw new Error('resolution is required');
    }

    const exception = await Exception.findById(req.params.id);
    if (!exception || exception.isDeleted) {
        res.status(404);
        throw new Error('Exception not found');
    }

    exception.status = 'RESOLVED';
    exception.resolution = resolution;
    exception.resolvedBy = req.user._id;
    exception.resolvedAt = new Date();
    if (approvedAmount != null) {
        exception.financialImpact.approvedAmount = Number(approvedAmount);
    }
    exception.actions.push({
        action: 'Exception resolved',
        performedBy: req.user._id,
        remarks: resolution
    });

    await exception.save();

    await logAudit(req, {
        action: 'RESOLVE',
        resource: 'exception',
        resourceId: exception._id,
        description: `Exception ${exception.exceptionId} resolved`,
        details: { resolution, approvedAmount }
    });

    res.json(exception);
});

// @desc    Escalate exception
// @route   PUT /api/exceptions/:id/escalate
// @access  Private
const escalateException = asyncHandler(async (req, res) => {
    const { escalatedTo, escalationReason } = req.body;

    if (!escalatedTo || !escalationReason) {
        res.status(400);
        throw new Error('escalatedTo and escalationReason are required');
    }

    const exception = await Exception.findById(req.params.id);
    if (!exception || exception.isDeleted) {
        res.status(404);
        throw new Error('Exception not found');
    }

    exception.status = 'ESCALATED';
    exception.escalatedTo = escalatedTo;
    exception.escalatedAt = new Date();
    exception.escalationReason = escalationReason;
    exception.actions.push({
        action: 'Exception escalated',
        performedBy: req.user._id,
        remarks: escalationReason
    });

    await exception.save();

    await logAudit(req, {
        action: 'ESCALATE',
        resource: 'exception',
        resourceId: exception._id,
        description: `Exception ${exception.exceptionId} escalated`,
        details: { escalatedTo, escalationReason }
    });

    res.json(exception);
});

// @desc    Close exception
// @route   PUT /api/exceptions/:id/close
// @access  Private
const closeException = asyncHandler(async (req, res) => {
    const { remarks } = req.body;

    const exception = await Exception.findById(req.params.id);
    if (!exception || exception.isDeleted) {
        res.status(404);
        throw new Error('Exception not found');
    }
    if (exception.status !== 'RESOLVED') {
        res.status(400);
        throw new Error('Only resolved exceptions can be closed');
    }

    exception.status = 'CLOSED';
    exception.actions.push({
        action: 'Exception closed',
        performedBy: req.user._id,
        remarks: remarks || 'Closed'
    });

    await exception.save();

    await logAudit(req, {
        action: 'CLOSE',
        resource: 'exception',
        resourceId: exception._id,
        description: `Exception ${exception.exceptionId} closed`
    });

    res.json(exception);
});

// @desc    Add action/comment to exception
// @route   POST /api/exceptions/:id/actions
// @access  Private
const addAction = asyncHandler(async (req, res) => {
    const { action, remarks } = req.body;

    if (!action) {
        res.status(400);
        throw new Error('action is required');
    }

    const exception = await Exception.findById(req.params.id);
    if (!exception || exception.isDeleted) {
        res.status(404);
        throw new Error('Exception not found');
    }

    exception.actions.push({
        action,
        performedBy: req.user._id,
        remarks
    });

    await exception.save();

    res.json(exception);
});

// @desc    Soft delete exception
// @route   DELETE /api/exceptions/:id
// @access  Private
const deleteException = asyncHandler(async (req, res) => {
    const exception = await Exception.findById(req.params.id);
    if (!exception) {
        res.status(404);
        throw new Error('Exception not found');
    }

    exception.isDeleted = true;
    await exception.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'exception',
        resourceId: exception._id,
        description: `Exception ${exception.exceptionId} deleted`
    });

    res.json({ message: 'Exception removed' });
});

module.exports = {
    getExceptions,
    getExceptionStats,
    getExceptionById,
    createException,
    updateException,
    resolveException,
    escalateException,
    closeException,
    addAction,
    deleteException
};
