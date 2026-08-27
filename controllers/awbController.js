const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const AwbSeries = require('../models/AwbSeries');
const Branch = require('../models/Branch');
const Customer = require('../models/Customer');
const Partner = require('../models/Partner');
const { generateAwbSeriesCode } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');
const { consumeAllocatedAwb } = require('../services/awbService');

const MANAGER_ROLES = ['super_admin', 'partner_admin', 'partner', 'branch_admin', 'branch'];

const getRoleName = (user) => user && user.role && user.role.name;

const requireManager = (req) => {
    if (!MANAGER_ROLES.includes(getRoleName(req.user))) {
        const error = new Error('You are not authorized to manage AWB series');
        error.statusCode = 403;
        throw error;
    }
};

const getScopedQuery = (req) => {
    const scope = buildScopeQuery(req.user);
    if (scope === null) {
        const error = new Error('No AWB data scope is available for this user');
        error.statusCode = 403;
        throw error;
    }
    return { ...scope, isDeleted: { $ne: true } };
};

const findScopedSeries = async (req, id, populate = false) => {
    if (!mongoose.isValidObjectId(id)) return null;
    let query = AwbSeries.findOne({ _id: id, ...getScopedQuery(req) });
    if (populate) {
        query = query
            .populate('createdBy', 'name email')
            .populate('allocations.allocatedBy', 'name email');
    }
    return query;
};

const parseRange = (startNumber, endNumber) => {
    const start = Number(startNumber);
    const end = Number(endNumber);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        const error = new Error('startNumber and endNumber must be safe integers and endNumber must be greater than or equal to startNumber');
        error.statusCode = 400;
        throw error;
    }
    return { start, end };
};

const resolveAllocationTarget = async (req, type, rawId) => {
    const id = String(rawId || '').trim();
    if (!['branch', 'customer', 'partner'].includes(type) || !id) {
        const error = new Error('A valid allocatedToType and allocatedToId are required');
        error.statusCode = 400;
        throw error;
    }

    let target;
    if (type === 'branch') {
        const branchQuery = mongoose.isValidObjectId(id)
            ? { $or: [{ _id: id }, { code: id.toUpperCase() }] }
            : { code: id.toUpperCase() };
        target = await Branch.findOne(branchQuery).select('name code partnerId isActive');
        if (!target || !target.isActive) {
            const error = new Error('Active branch not found');
            error.statusCode = 404;
            throw error;
        }

        const roleName = getRoleName(req.user);
        if (['branch_admin', 'branch'].includes(roleName) && String(req.user.branchId) !== String(target._id)) {
            const error = new Error('You can allocate AWBs only to your assigned branch');
            error.statusCode = 403;
            throw error;
        }
        if (['partner_admin', 'partner'].includes(roleName) && String(target.partnerId || '') !== String(req.user._id)) {
            const error = new Error('You can allocate AWBs only to branches owned by your partner account');
            error.statusCode = 403;
            throw error;
        }

        return { id: target._id, name: target.name, code: target.code, partnerId: target.partnerId || null };
    }

    if (!mongoose.isValidObjectId(id)) {
        const error = new Error(`${type} allocation requires a valid entity id`);
        error.statusCode = 400;
        throw error;
    }

    if (type === 'customer') {
        target = await Customer.findById(id).select('name code partnerId branchId status');
        if (!target || target.status !== 'active') {
            const error = new Error('Active customer not found');
            error.statusCode = 404;
            throw error;
        }
    } else {
        target = await Partner.findById(id).select('companyName partnerCode userId partnerId status isDeleted');
        if (!target || target.isDeleted || target.status !== 'ACTIVE') {
            const error = new Error('Active partner not found');
            error.statusCode = 404;
            throw error;
        }
    }

    const roleName = getRoleName(req.user);
    if (roleName !== 'super_admin') {
        const ownerId = type === 'customer' ? target.partnerId : (target.userId || target.partnerId);
        if (String(ownerId || '') !== String(req.user._id)) {
            const error = new Error(`You cannot allocate AWBs to this ${type}`);
            error.statusCode = 403;
            throw error;
        }
    }

    return type === 'customer'
        ? { id: target._id, name: target.name, code: target.code, partnerId: target.partnerId || null, branchId: target.branchId || null }
        : { id: target._id, name: target.companyName, code: target.partnerCode, partnerId: target.userId || target.partnerId || null };
};

const serializeAllocation = (series, allocation) => {
    const capacity = allocation.endNumber - allocation.startNumber + 1;
    const used = allocation.consumedCount || 0;
    return {
        id: allocation._id
            ? String(allocation._id)
            : `${series._id}:${allocation.startNumber}:${allocation.endNumber}:${allocation.allocatedToId}`,
        seriesId: String(series._id),
        seriesCode: series.code,
        seriesName: series.name,
        prefix: series.prefix,
        numberWidth: series.numberWidth || String(series.endNumber).length,
        startNumber: allocation.startNumber,
        endNumber: allocation.endNumber,
        formattedStart: `${series.prefix}${String(allocation.startNumber).padStart(series.numberWidth || String(series.endNumber).length, '0')}`,
        formattedEnd: `${series.prefix}${String(allocation.endNumber).padStart(series.numberWidth || String(series.endNumber).length, '0')}`,
        allocatedToType: allocation.allocatedToType,
        allocatedToId: allocation.allocatedToId,
        allocatedToName: allocation.allocatedToName,
        allocatedToCode: allocation.allocatedToCode || '',
        allocatedAt: allocation.allocatedAt,
        allocatedBy: allocation.allocatedBy,
        capacity,
        used,
        available: Math.max(0, capacity - used),
        utilizationRate: capacity > 0 ? Number(((used / capacity) * 100).toFixed(2)) : 0,
        status: used >= capacity ? 'exhausted' : (used / capacity >= 0.8 ? 'near_exhaustion' : 'active')
    };
};

const getAwbSeries = asyncHandler(async (req, res) => {
    const query = getScopedQuery(req);
    const { search, status } = req.query;
    if (search) {
        query.$or = [
            { code: { $regex: search, $options: 'i' } },
            { name: { $regex: search, $options: 'i' } },
            { prefix: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = String(status).toUpperCase();

    const series = await AwbSeries.find(query).populate('createdBy', 'name email').sort({ createdAt: -1 });
    res.json(series);
});

const getAwbStats = asyncHandler(async (req, res) => {
    const series = await AwbSeries.find(getScopedQuery(req)).select('startNumber endNumber allocations status');
    const stats = series.reduce((result, item) => {
        const capacity = item.endNumber - item.startNumber + 1;
        const allocated = item.allocations.reduce((sum, allocation) => sum + allocation.endNumber - allocation.startNumber + 1, 0);
        const consumed = item.allocations.reduce((sum, allocation) => sum + (allocation.consumedCount || 0), 0);
        result.totalCapacity += capacity;
        result.totalAllocated += allocated;
        result.totalConsumed += consumed;
        if (item.status === 'ACTIVE') result.activeSeries += 1;
        if (item.status === 'EXHAUSTED') result.exhaustedSeries += 1;
        if (item.status === 'INACTIVE') result.inactiveSeries += 1;
        return result;
    }, {
        totalCapacity: 0,
        totalAllocated: 0,
        totalConsumed: 0,
        activeSeries: 0,
        exhaustedSeries: 0,
        inactiveSeries: 0
    });

    res.json({
        totalSeries: series.length,
        ...stats,
        totalUnallocated: Math.max(0, stats.totalCapacity - stats.totalAllocated),
        totalAvailable: Math.max(0, stats.totalAllocated - stats.totalConsumed),
        utilizationRate: stats.totalAllocated > 0
            ? Number(((stats.totalConsumed / stats.totalAllocated) * 100).toFixed(2))
            : 0
    });
});

const getAllAllocations = asyncHandler(async (req, res) => {
    const series = await AwbSeries.find(getScopedQuery(req))
        .select('code name prefix numberWidth endNumber allocations')
        .populate('allocations.allocatedBy', 'name email')
        .sort({ createdAt: -1 });
    res.json(series.flatMap((item) => item.allocations.map((allocation) => serializeAllocation(item, allocation))));
});

const getUsage = asyncHandler(async (req, res) => {
    const series = await AwbSeries.find(getScopedQuery(req))
        .select('code name prefix numberWidth endNumber allocations status')
        .sort({ createdAt: -1 });
    const allocations = series.flatMap((item) => item.allocations.map((allocation) => serializeAllocation(item, allocation)));
    const used = allocations.reduce((sum, allocation) => sum + allocation.used, 0);
    const available = allocations.reduce((sum, allocation) => sum + allocation.available, 0);
    const allocated = used + available;

    res.json({
        summary: {
            totalSeries: series.length,
            activeSeries: series.filter((item) => item.status === 'ACTIVE').length,
            totalAllocations: allocations.length,
            allocated,
            used,
            available,
            utilizationRate: allocated > 0 ? Number(((used / allocated) * 100).toFixed(2)) : 0,
            activeBranches: new Set(allocations.filter((item) => item.allocatedToType === 'branch').map((item) => String(item.allocatedToId))).size,
            activePartners: new Set(allocations.filter((item) => item.allocatedToType === 'partner').map((item) => String(item.allocatedToId))).size
        },
        allocations
    });
});

const getAwbSeriesById = asyncHandler(async (req, res) => {
    const series = await findScopedSeries(req, req.params.id, true);
    if (!series) {
        res.status(404);
        throw new Error('AWB series not found');
    }
    res.json(series);
});

const createAwbSeries = asyncHandler(async (req, res) => {
    requireManager(req);
    const prefix = String(req.body.prefix || '').trim().toUpperCase();
    const { start, end } = parseRange(req.body.startNumber, req.body.endNumber);
    const name = String(req.body.name || `${prefix} ${start}-${end}`).trim();
    const status = String(req.body.status || 'ACTIVE').toUpperCase();
    if (!prefix || !/^[A-Z0-9]+$/.test(prefix)) {
        res.status(400);
        throw new Error('prefix is required and may contain only letters and numbers');
    }
    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
        res.status(400);
        throw new Error('New series status must be ACTIVE or INACTIVE');
    }

    let target = null;
    if (req.body.branchId) target = await resolveAllocationTarget(req, 'branch', req.body.branchId);
    const code = String(req.body.code || generateAwbSeriesCode()).toUpperCase();
    const overlap = await AwbSeries.findOne({
        prefix,
        isDeleted: { $ne: true },
        startNumber: { $lte: end },
        endNumber: { $gte: start }
    });
    if (overlap || await AwbSeries.exists({ code })) {
        res.status(409);
        throw new Error('AWB series code or numeric range overlaps an existing series with this prefix');
    }

    const partnerId = target && target.partnerId ? target.partnerId : getEffectivePartnerId(req.user);
    const branchId = target ? target.id : (getEffectiveBranchId(req.user) || req.user.branchId || null);
    const allocations = target ? [{
        startNumber: start,
        endNumber: end,
        allocatedToType: 'branch',
        allocatedToId: target.id,
        allocatedToName: target.name,
        allocatedToCode: target.code,
        allocatedBy: req.user._id,
        consumedCount: 0,
        lastConsumedNumber: start - 1
    }] : [];

    const series = await AwbSeries.create({
        code,
        prefix,
        name,
        description: req.body.description,
        startNumber: start,
        endNumber: end,
        numberWidth: Math.max(String(req.body.startNumber).length, String(req.body.endNumber).length),
        currentNumber: target ? end + 1 : start,
        allocations,
        status,
        partnerId,
        branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'awb_series',
        resourceId: series._id,
        description: `AWB series ${series.name} (${series.code}) created`,
        details: { prefix, startNumber: start, endNumber: end, branchId: target && target.id }
    });
    res.status(201).json(series);
});

const updateAwbSeries = asyncHandler(async (req, res) => {
    requireManager(req);
    const series = await findScopedSeries(req, req.params.id);
    if (!series) {
        res.status(404);
        throw new Error('AWB series not found');
    }

    const allowed = ['name', 'description', 'status'];
    allowed.forEach((field) => {
        if (req.body[field] !== undefined) series[field] = field === 'status' ? String(req.body[field]).toUpperCase() : req.body[field];
    });
    if (!['ACTIVE', 'INACTIVE', 'EXHAUSTED'].includes(series.status)) {
        res.status(400);
        throw new Error('Invalid AWB series status');
    }
    await series.save();
    await logAudit(req, {
        action: 'UPDATE', resource: 'awb_series', resourceId: series._id,
        description: `AWB series ${series.name} (${series.code}) updated`, details: req.body
    });
    res.json(series);
});

const deleteAwbSeries = asyncHandler(async (req, res) => {
    requireManager(req);
    const series = await findScopedSeries(req, req.params.id);
    if (!series) {
        res.status(404);
        throw new Error('AWB series not found');
    }
    if (series.allocations.some((allocation) => (allocation.consumedCount || 0) > 0)) {
        res.status(409);
        throw new Error('A series with consumed AWBs cannot be deleted; mark it inactive instead');
    }
    series.isDeleted = true;
    series.status = 'INACTIVE';
    await series.save();
    await logAudit(req, {
        action: 'DELETE', resource: 'awb_series', resourceId: series._id,
        description: `AWB series ${series.name} (${series.code}) deleted`
    });
    res.json({ message: 'AWB series removed' });
});

const allocateRange = asyncHandler(async (req, res) => {
    requireManager(req);
    const { start, end } = parseRange(req.body.startNumber, req.body.endNumber);
    const target = await resolveAllocationTarget(req, req.body.allocatedToType, req.body.allocatedToId);
    const series = await findScopedSeries(req, req.params.id);
    if (!series) {
        res.status(404);
        throw new Error('AWB series not found');
    }
    if (series.status !== 'ACTIVE') {
        res.status(409);
        throw new Error('Only active AWB series can be allocated');
    }
    if (start < series.startNumber || end > series.endNumber) {
        res.status(400);
        throw new Error('Allocation range is outside the series bounds');
    }
    if (series.allocations.some((allocation) => !(end < allocation.startNumber || start > allocation.endNumber))) {
        res.status(409);
        throw new Error('Allocation range overlaps an existing allocation');
    }

    const updated = await AwbSeries.findOneAndUpdate(
        {
            _id: series._id,
            __v: series.__v,
            ...getScopedQuery(req),
            allocations: { $not: { $elemMatch: { startNumber: { $lte: end }, endNumber: { $gte: start } } } }
        },
        {
            $push: { allocations: {
                startNumber: start,
                endNumber: end,
                allocatedToType: req.body.allocatedToType,
                allocatedToId: target.id,
                allocatedToName: target.name,
                allocatedToCode: target.code,
                allocatedBy: req.user._id,
                consumedCount: 0,
                lastConsumedNumber: start - 1
            } },
            $max: { currentNumber: end + 1 },
            $inc: { __v: 1 }
        },
        { new: true, runValidators: true }
    );
    if (!updated) {
        res.status(409);
        throw new Error('Series changed during allocation; refresh and try again');
    }

    await logAudit(req, {
        action: 'ALLOCATE', resource: 'awb_series', resourceId: updated._id,
        description: `Range ${start}-${end} allocated to ${req.body.allocatedToType} ${target.name}`,
        details: { startNumber: start, endNumber: end, allocatedToType: req.body.allocatedToType, allocatedToId: target.id }
    });
    res.status(201).json(updated);
});

const consumeAwb = asyncHandler(async (req, res) => {
    const series = await findScopedSeries(req, req.params.id);
    if (!series) {
        res.status(404);
        throw new Error('AWB series not found');
    }

    let targetIds = [];
    const roleName = getRoleName(req.user);
    if (roleName === 'super_admin' && req.body.allocatedToId) {
        targetIds = [req.body.allocatedToId];
    } else {
        targetIds = [getEffectiveBranchId(req.user), req.user.branchId, req.user._id];
    }

    const result = await consumeAllocatedAwb({
        seriesId: series._id,
        targetIds
    });
    await logAudit(req, {
        action: 'CONSUME', resource: 'awb_series', resourceId: result.seriesId,
        description: `AWB number ${result.awbNumber} consumed from series ${result.seriesCode}`,
        details: result
    });
    res.json(result);
});

const getAllocations = asyncHandler(async (req, res) => {
    const series = await findScopedSeries(req, req.params.id, true);
    if (!series) {
        res.status(404);
        throw new Error('AWB series not found');
    }
    res.json({
        seriesCode: series.code,
        seriesName: series.name,
        prefix: series.prefix,
        allocations: series.allocations.map((allocation) => serializeAllocation(series, allocation))
    });
});

module.exports = {
    getAwbSeries,
    getAwbStats,
    getAllAllocations,
    getUsage,
    getAwbSeriesById,
    createAwbSeries,
    updateAwbSeries,
    deleteAwbSeries,
    allocateRange,
    consumeAwb,
    getAllocations
};
