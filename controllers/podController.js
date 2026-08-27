const asyncHandler = require('express-async-handler');
const Pod = require('../models/Pod');
const Shipment = require('../models/Shipment');
const { generatePodId } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// @desc    Get all PODs (role-scoped)
// @route   GET /api/pods
// @access  Private
const getPods = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, deliveryStatus, verificationStatus, startDate, endDate } = req.query;
    if (search) {
        query.$or = [
            { awb: { $regex: search, $options: 'i' } },
            { podId: { $regex: search, $options: 'i' } },
            { 'deliveredTo.name': { $regex: search, $options: 'i' } }
        ];
    }
    if (deliveryStatus && deliveryStatus !== 'ALL') query.deliveryStatus = deliveryStatus;
    if (verificationStatus && verificationStatus !== 'ALL') query.verificationStatus = verificationStatus;
    if (startDate || endDate) {
        query.deliveryDate = {};
        if (startDate) query.deliveryDate.$gte = new Date(startDate);
        if (endDate) query.deliveryDate.$lte = new Date(endDate);
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [pods, total] = await Promise.all([
        Pod.find(query)
            .populate('shipmentId', 'awb sender receiver status')
            .populate('capturedBy', 'name email')
            .sort({ deliveryDate: -1 })
            .skip(skip)
            .limit(limit),
        Pod.countDocuments(query)
    ]);

    res.json({
        data: pods,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
});

// @desc    Get POD stats
// @route   GET /api/pods/stats
// @access  Private
const getPodStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, delivered, undelivered, rto, pendingVerification, verified, rejected] = await Promise.all([
        Pod.countDocuments(query),
        Pod.countDocuments({ ...query, deliveryStatus: 'DELIVERED' }),
        Pod.countDocuments({ ...query, deliveryStatus: 'UNDELIVERED' }),
        Pod.countDocuments({ ...query, deliveryStatus: 'RTO' }),
        Pod.countDocuments({ ...query, verificationStatus: 'PENDING' }),
        Pod.countDocuments({ ...query, verificationStatus: 'VERIFIED' }),
        Pod.countDocuments({ ...query, verificationStatus: 'REJECTED' })
    ]);

    const deliveryRate = total > 0 ? Number(((delivered / total) * 100).toFixed(2)) : 0;
    const verificationRate = total > 0 ? Number(((verified / total) * 100).toFixed(2)) : 0;

    res.json({
        total,
        delivered,
        undelivered,
        rto,
        pendingVerification,
        verified,
        rejected,
        deliveryRate,
        verificationRate
    });
});

// @desc    Get single POD
// @route   GET /api/pods/:id
// @access  Private
const getPodById = asyncHandler(async (req, res) => {
    const pod = await Pod.findById(req.params.id)
        .populate('shipmentId')
        .populate('capturedBy', 'name email')
        .populate('verifiedBy', 'name email');
    if (!pod || pod.isDeleted) {
        res.status(404);
        throw new Error('POD not found');
    }
    res.json(pod);
});

// @desc    Get POD by AWB
// @route   GET /api/pods/awb/:awb
// @access  Private
const getPodByAwb = asyncHandler(async (req, res) => {
    const pod = await Pod.findOne({ awb: req.params.awb, isDeleted: { $ne: true } })
        .populate('shipmentId')
        .populate('capturedBy', 'name email');
    if (!pod) {
        res.status(404);
        throw new Error('POD not found for this AWB');
    }
    res.json(pod);
});

// @desc    Capture POD (delivery proof)
// @route   POST /api/pods
// @access  Private
const capturePod = asyncHandler(async (req, res) => {
    const { shipmentId, awb, deliveryStatus, deliveredTo, signature, attachments, remarks, undeliveredReason, location, deliveryDate, captureDevice } = req.body;

    if (!shipmentId || !awb) {
        res.status(400);
        throw new Error('shipmentId and awb are required');
    }

    // Verify shipment exists
    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) {
        res.status(404);
        throw new Error('Shipment not found');
    }

    // Check if POD already exists for this shipment
    const existingPod = await Pod.findOne({ shipmentId, isDeleted: { $ne: true } });
    if (existingPod) {
        res.status(409);
        throw new Error('POD already exists for this shipment. Use update instead.');
    }

    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;
    const podId = generatePodId();

    const pod = await Pod.create({
        podId,
        shipmentId,
        awb,
        deliveryStatus: deliveryStatus || 'DELIVERED',
        deliveredTo,
        signature,
        attachments: attachments || [],
        remarks,
        undeliveredReason: deliveryStatus === 'UNDELIVERED' ? undeliveredReason : null,
        location,
        deliveryDate: deliveryDate || new Date(),
        captureDevice: captureDevice || 'web',
        capturedBy: req.user._id,
        capturedByName: req.user.name,
        partnerId,
        branchId,
        createdBy: req.user._id,
        verificationStatus: 'PENDING'
    });

    // Update shipment status based on delivery outcome
    if (deliveryStatus === 'DELIVERED') {
        shipment.status = 'DELIVERED';
    } else if (deliveryStatus === 'UNDELIVERED' || deliveryStatus === 'REFUSED') {
        shipment.status = 'UNDELIVERED';
    } else if (deliveryStatus === 'RTO') {
        shipment.status = 'RTO';
    }
    shipment.history = shipment.history || [];
    shipment.history.push({
        status: shipment.status,
        timestamp: new Date(),
        note: `POD captured: ${remarks || deliveryStatus}`,
        updatedBy: req.user._id
    });
    await shipment.save();

    await logAudit(req, {
        action: 'CREATE',
        resource: 'pod',
        resourceId: pod._id,
        description: `POD ${pod.podId} captured for AWB ${awb} (${deliveryStatus})`,
        details: { awb, deliveryStatus, podId }
    });

    res.status(201).json(pod);
});

// @desc    Update POD
// @route   PUT /api/pods/:id
// @access  Private
const updatePod = asyncHandler(async (req, res) => {
    const pod = await Pod.findById(req.params.id);
    if (!pod || pod.isDeleted) {
        res.status(404);
        throw new Error('POD not found');
    }

    Object.assign(pod, req.body);
    await pod.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'pod',
        resourceId: pod._id,
        description: `POD ${pod.podId} updated for AWB ${pod.awb}`,
        details: req.body
    });

    res.json(pod);
});

// @desc    Verify POD
// @route   PUT /api/pods/:id/verify
// @access  Private
const verifyPod = asyncHandler(async (req, res) => {
    const { status, rejectionReason } = req.body;

    if (!['VERIFIED', 'REJECTED'].includes(status)) {
        res.status(400);
        throw new Error('status must be VERIFIED or REJECTED');
    }

    const pod = await Pod.findById(req.params.id);
    if (!pod || pod.isDeleted) {
        res.status(404);
        throw new Error('POD not found');
    }

    pod.verificationStatus = status;
    pod.verifiedBy = req.user._id;
    pod.verifiedAt = new Date();
    if (status === 'REJECTED') {
        pod.rejectionReason = rejectionReason || 'Not specified';
    }

    await pod.save();

    await logAudit(req, {
        action: 'VERIFY',
        resource: 'pod',
        resourceId: pod._id,
        description: `POD ${pod.podId} for AWB ${pod.awb} ${status.toLowerCase()}`,
        details: { status, rejectionReason }
    });

    res.json(pod);
});

// @desc    Soft delete POD
// @route   DELETE /api/pods/:id
// @access  Private
const deletePod = asyncHandler(async (req, res) => {
    const pod = await Pod.findById(req.params.id);
    if (!pod) {
        res.status(404);
        throw new Error('POD not found');
    }

    pod.isDeleted = true;
    await pod.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'pod',
        resourceId: pod._id,
        description: `POD ${pod.podId} for AWB ${pod.awb} deleted`
    });

    res.json({ message: 'POD removed' });
});

module.exports = {
    getPods,
    getPodStats,
    getPodById,
    getPodByAwb,
    capturePod,
    updatePod,
    verifyPod,
    deletePod
};
