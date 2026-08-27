/**
 * pickupController.js
 *
 * Full pickup request lifecycle:
 *   1. Customer/branch staff creates a pickup request
 *   2. Dispatcher assigns a rider
 *   3. Rider starts the pickup run (visits customer location)
 *   4. Rider scans each parcel at customer location
 *   5. Rider completes the pickup (parcels brought to branch)
 *   6. Parcels are inward-scanned at the branch counter
 */

const asyncHandler = require('express-async-handler');
const PickupRequest = require('../models/PickupRequest');
const Shipment = require('../models/Shipment');
const Customer = require('../models/Customer');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { generatePickupRequestId } = require('../utils/idGenerator');
const {
    buildScopeQuery,
    getEffectivePartnerId,
    getEffectiveBranchId,
    getScopedRiders
} = require('../utils/scopeHelper');
const { autoRoute } = require('../utils/autoRouter');
const { logAudit } = require('../utils/auditLogger');
const { notifyBulk } = require('../utils/notificationHelper');
const {
    roleName,
    isOperationsRole,
    canExecutePickup
} = require('../utils/pickupPolicy');

const pickupScope = (user) => buildScopeQuery(user, { customerField: 'customer' });

const getScopedPickup = (user, id) => {
    const scope = pickupScope(user);
    return PickupRequest.findOne(scope === null ? { _id: null } : { _id: id, ...scope });
};

const shipmentScope = (user, customerUserId) => {
    const currentRole = roleName(user);
    if (currentRole === 'super_admin') return {};
    if (currentRole === 'customer') return { createdBy: user._id };

    const partnerId = getEffectivePartnerId(user);
    const branchId = getEffectiveBranchId(user);
    if (branchId) return { branchId };
    if (partnerId) return { partnerId };
    if (customerUserId) return { createdBy: customerUserId };
    return { _id: null };
};

const validateBranchScope = async (user, branchId) => {
    if (!branchId) return null;
    const currentRole = roleName(user);
    if (currentRole === 'super_admin') return Branch.findById(branchId);

    const branchQuery = { _id: branchId, isActive: true };
    if (['branch_admin', 'branch', 'dispatcher', 'rider'].includes(currentRole)) {
        if (!user.branchId || user.branchId.toString() !== branchId.toString()) return null;
    } else if (['partner_admin', 'partner'].includes(currentRole)) {
        branchQuery.partnerId = user._id;
    }
    return Branch.findOne(branchQuery);
};

// @desc    Create a pickup request
// @route   POST /api/pickups
// @access  Private (customer, branch_admin, dispatcher)
const createPickupRequest = asyncHandler(async (req, res) => {
    const {
        customer,
        customerId,
        pickupAddress,
        preferredDate,
        preferredTimeSlot,
        shipments = [],
        estimatedPackageCount,
        estimatedWeight,
        serviceType,
        paymentMode,
        priority,
        packageType,
        notes
    } = req.body;

    const requiredAddressFields = ['name', 'phone', 'addressLine1', 'city', 'state', 'pincode'];
    if (!pickupAddress || requiredAddressFields.some((field) => !String(pickupAddress[field] || '').trim()) || !preferredDate) {
        return res.status(400).json({ message: 'Pickup address (name, phone, addressLine1, city, state, pincode) and preferred date are required' });
    }

    const currentRole = roleName(req.user);
    const isCustomer = currentRole === 'customer';
    const effectiveCustomer = isCustomer ? req.user._id : (customer || req.user._id);
    if (!isCustomer && !customer) {
        return res.status(400).json({ message: 'Customer is required when staff creates a pickup request' });
    }

    // Customer self-service requests must resolve from the authenticated user.
    // Ignore a client-provided Customer document id because it may be stale.
    let customerRecord = isCustomer
        ? await Customer.findOne({ userId: req.user._id }).select('userId partnerId branchId status')
        : customerId
            ? await Customer.findById(customerId).select('userId partnerId branchId status')
            : await Customer.findOne({ userId: effectiveCustomer }).select('userId partnerId branchId status');

    if (!customerRecord || customerRecord.status === 'inactive') {
        return res.status(400).json({ message: 'Customer record is invalid or inactive' });
    }
    if (!customerRecord.userId || customerRecord.userId.toString() !== effectiveCustomer.toString()) {
        return res.status(400).json({ message: 'Customer record does not match the selected customer user' });
    }

    if (!isCustomer) {
        const partnerId = getEffectivePartnerId(req.user);
        const scopedBranchId = getEffectiveBranchId(req.user);
        if (partnerId && customerRecord.partnerId?.toString() !== partnerId.toString()) {
            return res.status(403).json({ message: 'Selected customer is outside your partner scope' });
        }
        if (scopedBranchId && customerRecord.branchId?.toString() !== scopedBranchId.toString()) {
            return res.status(403).json({ message: 'Selected customer is outside your branch scope' });
        }
    }

    const route = await autoRoute(pickupAddress.pincode, pickupAddress.pincode);
    let branchId = customerRecord?.branchId || getEffectiveBranchId(req.user);

    if (!route.serviceable) {
        return res.status(400).json({
            message: 'Pickup service is not currently available for this pincode',
            code: 'PICKUP_PINCODE_NOT_SERVICEABLE',
            reasons: route.errors
        });
    }

    if (!branchId && route.originBranch) branchId = route.originBranch._id;
    if (!branchId) {
        return res.status(400).json({
            message: 'Pickup pincode is not assigned to an operational branch',
            code: 'PICKUP_BRANCH_NOT_ASSIGNED'
        });
    }
    if (!(await validateBranchScope(req.user, branchId))) {
        return res.status(403).json({ message: 'Pickup branch is outside your scope' });
    }

    const normalizedShipments = Array.isArray(shipments) ? shipments : [];
    const awbs = normalizedShipments
        .map((item) => String(item?.awb || '').trim().toUpperCase())
        .filter(Boolean);
    if (awbs.length === 0) {
        return res.status(400).json({
            message: 'Select at least one booked shipment AWB before requesting a pickup',
            code: 'PICKUP_AWB_REQUIRED'
        });
    }
    if (new Set(awbs).size !== awbs.length) {
        return res.status(400).json({ message: 'Duplicate AWBs are not allowed in a pickup request' });
    }

    let linkedShipments = [];
    if (awbs.length > 0) {
        linkedShipments = await Shipment.find({
            awb: { $in: awbs },
            ...shipmentScope(req.user, effectiveCustomer)
        }).select('_id awb weight pickupRequestId partnerId branchId createdBy customerId sender status');
        if (linkedShipments.length !== awbs.length) {
            return res.status(403).json({ message: 'One or more supplied AWBs do not exist or are outside your scope' });
        }
        if (linkedShipments.some((shipment) => shipment.pickupRequestId)) {
            return res.status(409).json({ message: 'One or more AWBs are already linked to a pickup request' });
        }
        if (linkedShipments.some((shipment) => shipment.status !== 'not_scheduled')) {
            return res.status(409).json({ message: 'Only booked and not-scheduled shipments can be added to a pickup request' });
        }
        if (linkedShipments.some((shipment) => shipment.customerId && shipment.customerId.toString() !== customerRecord._id.toString())) {
            return res.status(403).json({ message: 'One or more AWBs belong to a different customer account' });
        }
        if (linkedShipments.some((shipment) => String(shipment.sender?.pincode || '') !== String(pickupAddress.pincode))) {
            return res.status(400).json({ message: 'Pickup address pincode must match every selected shipment origin pincode' });
        }
    }

    const normalizedEntries = normalizedShipments.map((item) => {
        const awb = String(item?.awb || '').trim().toUpperCase();
        const linkedShipment = linkedShipments.find((shipment) => shipment.awb === awb);
        return {
        awb,
        shipmentId: linkedShipment?._id || null,
        weight: Number(item.weight ?? linkedShipment?.weight ?? 0),
        description: item.description || '',
        scanStatus: 'pending'
    };
    });
    const totalWeight = normalizedEntries.reduce((sum, item) => sum + item.weight, 0);
    const pickupRequest = await PickupRequest.create({
        pickupRequestId: generatePickupRequestId(),
        customer: effectiveCustomer,
        customerId: customerRecord?._id || customerId || null,
        pickupAddress,
        preferredDate,
        preferredTimeSlot: preferredTimeSlot || 'ANY',
        shipments: normalizedEntries,
        estimatedPackageCount: normalizedEntries.length,
        estimatedWeight: totalWeight,
        totalShipments: normalizedEntries.length,
        totalWeight,
        priority: priority || 'normal',
        packageType: packageType || '',
        serviceType: serviceType || 'SURFACE',
        paymentMode: paymentMode || 'PREPAID',
        partnerId: customerRecord?.partnerId || getEffectivePartnerId(req.user),
        branchId,
        createdBy: req.user._id,
        history: [{
            status: 'requested',
            updatedBy: req.user._id,
            remark: 'Pickup request created'
        }],
        notes: notes || ''
    });

    if (linkedShipments.length > 0) {
        await Shipment.updateMany(
            { _id: { $in: linkedShipments.map((shipment) => shipment._id) } },
            { $set: { pickupRequestId: pickupRequest._id } }
        );
    }

    await logAudit(req, {
        action: 'CREATE',
        resource: 'pickup_request',
        resourceId: pickupRequest._id,
        description: `Pickup request ${pickupRequest.pickupRequestId} created for ${pickupAddress.name}`
    });

    res.status(201).json(pickupRequest);
});

// @desc    Get all pickup requests (scoped)
// @route   GET /api/pickups
// @access  Private
const getPickupRequests = asyncHandler(async (req, res) => {
    const scope = pickupScope(req.user);
    if (scope === null) return res.json({ pickups: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 } });

    const filters = [];
    const query = { ...scope };
    const { status, search, date, riderId } = req.query;
    if (status && status !== 'ALL') query.status = status;
    if (riderId) query.assignedRider = riderId;
    if (date) {
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);
        query.preferredDate = { $gte: dayStart, $lte: dayEnd };
    }
    if (search) {
        filters.push({
            $or: [
                { pickupRequestId: { $regex: search, $options: 'i' } },
                { 'pickupAddress.name': { $regex: search, $options: 'i' } },
                { 'pickupAddress.phone': { $regex: search, $options: 'i' } },
                { 'pickupAddress.pincode': { $regex: search, $options: 'i' } }
            ]
        });
    }
    if (filters.length > 0) query.$and = filters;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [pickups, total] = await Promise.all([
        PickupRequest.find(query)
            .populate('customer', 'name email phone')
            .populate('customerId', 'code name contactPerson email mobileNo phoneO phoneR')
            .populate('assignedRider', 'name phone')
            .populate('assignedBranch', 'name code')
            .sort({ preferredDate: 1, createdAt: -1 })
            .skip(skip)
            .limit(limit),
        PickupRequest.countDocuments(query)
    ]);

    res.json({
        pickups,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
});

// @desc    Get pickup request by ID
// @route   GET /api/pickups/:id
// @access  Private
const getPickupRequestById = asyncHandler(async (req, res) => {
    const pickup = await getScopedPickup(req.user, req.params.id)
        .populate('customer', 'name email phone')
        .populate('customerId', 'code name contactPerson email mobileNo phoneO phoneR')
        .populate('assignedRider', 'name phone')
        .populate('assignedBranch', 'name code')
        .populate('shipments.shipmentId');

    if (!pickup) {
        res.status(404);
        throw new Error('Pickup request not found');
    }
    res.json(pickup);
});

// @desc    Get booked shipments eligible for a new pickup request
// @route   GET /api/pickups/available-shipments
// @access  Private (pickup creators)
const getAvailableShipments = asyncHandler(async (req, res) => {
    const currentRole = roleName(req.user);
    const isCustomer = currentRole === 'customer';
    const requestedCustomerId = String(req.query.customerId || '').trim();

    const customerRecord = isCustomer
        ? await Customer.findOne({ userId: req.user._id }).select('_id userId partnerId branchId status')
        : requestedCustomerId
            ? await Customer.findById(requestedCustomerId).select('_id userId partnerId branchId status')
            : null;

    if (!customerRecord || customerRecord.status === 'inactive' || !customerRecord.userId) {
        return res.status(400).json({ message: 'Select a valid active customer with portal access' });
    }

    if (!isCustomer) {
        const partnerId = getEffectivePartnerId(req.user);
        const branchId = getEffectiveBranchId(req.user);
        if (partnerId && customerRecord.partnerId?.toString() !== partnerId.toString()) {
            return res.status(403).json({ message: 'Selected customer is outside your partner scope' });
        }
        if (branchId && customerRecord.branchId?.toString() !== branchId.toString()) {
            return res.status(403).json({ message: 'Selected customer is outside your branch scope' });
        }
    }

    const ownershipFilter = {
        $or: [
            { customerId: customerRecord._id },
            // Controlled fallback for shipments booked before Shipment.customerId was introduced.
            { customerId: { $exists: false }, createdBy: customerRecord.userId },
            { customerId: null, createdBy: customerRecord.userId }
        ]
    };

    const shipments = await Shipment.find({
        status: 'not_scheduled',
        $and: [
            ownershipFilter,
            { $or: [{ pickupRequestId: { $exists: false } }, { pickupRequestId: null }] }
        ],
        ...shipmentScope(req.user, customerRecord.userId)
    })
        .select('_id awb sender receiver weight dimensions contents status createdAt customerId')
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();

    res.json(shipments);
});

// @desc    Get riders available in the caller's scope
// @route   GET /api/pickups/riders
// @access  Private (operations)
const getPickupRiders = asyncHandler(async (req, res) => {
    res.json(await getScopedRiders(req.user));
});

// @desc    Assign a rider to a pickup request
// @route   PUT /api/pickups/:id/assign
// @access  Private (branch_admin, dispatcher, super_admin)
const assignRider = asyncHandler(async (req, res) => {
    const { riderId, branchId } = req.body;
    if (!riderId) {
        return res.status(400).json({ message: 'Rider ID is required' });
    }

    const pickup = await getScopedPickup(req.user, req.params.id);
    if (!pickup) {
        res.status(404);
        throw new Error('Pickup request not found');
    }

    if (pickup.status !== 'requested' && pickup.status !== 'assigned') {
        return res.status(400).json({ message: `Cannot assign rider — pickup is already ${pickup.status}` });
    }

    const rider = await User.findById(riderId).populate('role');
    if (!rider || roleName(rider) !== 'rider' || rider.isInactive || rider.status === 'inactive') {
        return res.status(400).json({ message: 'Selected user is not an active rider' });
    }
    const scopedRiders = await getScopedRiders(req.user);
    if (!scopedRiders.some((item) => item._id.toString() === rider._id.toString())) {
        return res.status(403).json({ message: 'Selected rider is outside your scope' });
    }

    const effectiveBranchId = branchId || pickup.assignedBranch || rider.branchId || pickup.branchId;
    if (!effectiveBranchId || !(await validateBranchScope(req.user, effectiveBranchId))) {
        return res.status(403).json({ message: 'Assignment branch is outside your scope' });
    }
    if (rider.branchId && rider.branchId.toString() !== effectiveBranchId.toString()) {
        return res.status(400).json({ message: 'Rider does not belong to the assignment branch' });
    }

    pickup.assignedRider = riderId;
    pickup.assignedBranch = effectiveBranchId;
    pickup.status = 'assigned';
    pickup.history.push({
        status: 'assigned',
        updatedBy: req.user._id,
        remark: `Assigned to rider ${rider.name}`
    });

    await pickup.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'pickup_request',
        resourceId: pickup._id,
        description: `Rider ${rider.name} assigned to pickup ${pickup.pickupRequestId}`
    });

    // Fire-and-forget: notify all customers that pickup is scheduled with rider
    if (pickup.shipments && pickup.shipments.length > 0) {
        const awbs = pickup.shipments.map(s => s.awb).filter(Boolean);
        notifyBulk(
            awbs,
            'pickup_scheduled',
            (s) => ({
                awb: s.awb,
                date: pickup.preferredDate ? new Date(pickup.preferredDate).toDateString() : '',
                timeSlot: pickup.preferredTimeSlot || 'ANY',
                riderName: rider.name || 'TBD'
            }),
            req.user
        );
    }

    res.json(pickup);
});

// @desc    Start pickup run (rider begins visiting customer)
// @route   PUT /api/pickups/:id/start
// @access  Private (rider, dispatcher)
const startPickupRun = asyncHandler(async (req, res) => {
    const pickup = await getScopedPickup(req.user, req.params.id);
    if (!pickup) {
        res.status(404);
        throw new Error('Pickup request not found');
    }

    if (!canExecutePickup(req.user, pickup)) {
        return res.status(403).json({ message: 'Only the assigned rider or scoped operations staff can start this pickup' });
    }

    if (pickup.status !== 'assigned') {
        return res.status(400).json({ message: `Cannot start — pickup must be assigned first (current: ${pickup.status})` });
    }

    pickup.status = 'pickup_started';
    pickup.actualPickupTime = new Date();
    pickup.history.push({
        status: 'pickup_started',
        updatedBy: req.user._id,
        remark: 'Rider started pickup run'
    });

    await pickup.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'pickup_request',
        resourceId: pickup._id,
        description: `Pickup run started for ${pickup.pickupRequestId}`
    });

    res.json(pickup);
});

// @desc    Scan a parcel during pickup run
// @route   POST /api/pickups/:id/scan
// @access  Private (rider)
const scanParcelAtPickup = asyncHandler(async (req, res) => {
    const { weight, description } = req.body;
    const awb = String(req.body.awb || '').trim().toUpperCase();
    if (!awb) {
        return res.status(400).json({ message: 'AWB is required' });
    }

    const pickup = await getScopedPickup(req.user, req.params.id);
    if (!pickup) {
        res.status(404);
        throw new Error('Pickup request not found');
    }

    if (!canExecutePickup(req.user, pickup)) {
        return res.status(403).json({ message: 'Only the assigned rider or scoped operations staff can scan this pickup' });
    }

    if (!['assigned', 'pickup_started'].includes(pickup.status)) {
        return res.status(400).json({ message: `Cannot scan — pickup is ${pickup.status}` });
    }

    const existing = pickup.shipments.find(s => s.awb === awb);
    if (!existing) {
        return res.status(404).json({ message: 'This AWB is not registered in the pickup request' });
    }
    if (existing.scanStatus === 'scanned') {
        return res.status(409).json({ message: 'This AWB has already been scanned', shipment: existing });
    }

    const linkedShipment = await Shipment.findOne({
        awb,
        ...shipmentScope(req.user, pickup.customer)
    }).select('_id awb weight pickupRequestId');
    if (!linkedShipment) {
        return res.status(404).json({ message: 'Shipment does not exist or is outside this pickup scope' });
    }
    if (linkedShipment.pickupRequestId && linkedShipment.pickupRequestId.toString() !== pickup._id.toString()) {
        return res.status(409).json({ message: 'Shipment is already linked to another pickup request' });
    }

    existing.shipmentId = linkedShipment._id;
    existing.scanStatus = 'scanned';
    existing.scannedAt = new Date();
    existing.weight = weight || existing.weight;
    existing.description = description || existing.description;

    // Auto-start if first scan
    if (pickup.status === 'assigned') {
        pickup.status = 'pickup_started';
        pickup.actualPickupTime = new Date();
    }

    pickup.totalShipments = pickup.shipments.length;
    pickup.totalWeight = pickup.shipments.reduce((sum, s) => sum + (s.weight || 0), 0);

    linkedShipment.pickupRequestId = pickup._id;
    await Promise.all([pickup.save(), linkedShipment.save()]);

    res.json({
        message: 'Parcel scanned successfully',
        pickup,
        scannedShipment: pickup.shipments.find(s => s.awb === awb)
    });
});

// @desc    Mark a parcel as missed during pickup
// @route   POST /api/pickups/:id/miss
// @access  Private (rider)
const markParcelMissed = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const awb = String(req.body.awb || '').trim().toUpperCase();
    const pickup = await getScopedPickup(req.user, req.params.id);
    if (!pickup) {
        res.status(404);
        throw new Error('Pickup request not found');
    }

    if (!canExecutePickup(req.user, pickup)) {
        return res.status(403).json({ message: 'Only the assigned rider or scoped operations staff can mark parcels missed' });
    }

    if (!awb) {
        return res.status(400).json({ message: 'AWB is required' });
    }
    const shipment = pickup.shipments.find(s => s.awb === awb);
    if (!shipment) {
        return res.status(404).json({ message: 'Shipment not found in this pickup request' });
    }

    shipment.scanStatus = 'missed';
    shipment.description = reason || 'Missed during pickup';

    await pickup.save();
    res.json({ message: 'Parcel marked as missed', pickup });
});

// @desc    Complete the pickup run (rider returns to branch)
// @route   PUT /api/pickups/:id/complete
// @access  Private (rider, dispatcher)
const completePickupRun = asyncHandler(async (req, res) => {
    const pickup = await getScopedPickup(req.user, req.params.id);
    if (!pickup) {
        res.status(404);
        throw new Error('Pickup request not found');
    }

    if (!canExecutePickup(req.user, pickup)) {
        return res.status(403).json({ message: 'Only the assigned rider or scoped operations staff can complete this pickup' });
    }

    if (!['pickup_started', 'picked_up'].includes(pickup.status)) {
        return res.status(400).json({ message: `Cannot complete — pickup is ${pickup.status}` });
    }

    const scannedCount = pickup.shipments.filter(s => s.scanStatus === 'scanned').length;
    const missedCount = pickup.shipments.filter(s => s.scanStatus === 'missed').length;
    const unresolvedCount = pickup.shipments.filter(s => !['scanned', 'missed', 'rejected'].includes(s.scanStatus)).length;
    const expectedCount = Math.max(pickup.estimatedPackageCount || 0, pickup.shipments.length);

    if (expectedCount === 0 || unresolvedCount > 0 || scannedCount + missedCount === 0) {
        return res.status(400).json({
            message: unresolvedCount > 0
                ? `Cannot complete pickup — ${unresolvedCount} parcel(s) are still unresolved`
                : 'Cannot complete pickup until at least one booked parcel is scanned or marked missed',
            code: 'PICKUP_PARCELS_UNRESOLVED',
            summary: { scanned: scannedCount, missed: missedCount, unresolved: unresolvedCount, total: expectedCount }
        });
    }

    pickup.status = 'completed';
    pickup.completedAt = new Date();
    pickup.history.push({
        status: 'completed',
        updatedBy: req.user._id,
        remark: `Pickup completed. Scanned: ${scannedCount}, Missed: ${missedCount}`
    });

    await pickup.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'pickup_request',
        resourceId: pickup._id,
        description: `Pickup ${pickup.pickupRequestId} completed (${scannedCount} scanned, ${missedCount} missed)`
    });

    // Fire-and-forget: notify all customers whose parcels were picked up
    const scannedAwbs = pickup.shipments.filter(s => s.scanStatus === 'scanned').map(s => s.awb).filter(Boolean);
    if (scannedAwbs.length > 0) {
        notifyBulk(
            scannedAwbs,
            'pickup_done',
            (s) => ({ awb: s.awb }),
            req.user
        );
    }

    res.json({
        message: 'Pickup run completed',
        pickup,
        summary: { scanned: scannedCount, missed: missedCount, total: expectedCount }
    });
});

// @desc    Cancel a pickup request
// @route   PUT /api/pickups/:id/cancel
// @access  Private (branch_admin, dispatcher, super_admin)
const cancelPickupRequest = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const pickup = await getScopedPickup(req.user, req.params.id);
    if (!pickup) {
        res.status(404);
        throw new Error('Pickup request not found');
    }

    if (['completed', 'cancelled'].includes(pickup.status)) {
        return res.status(400).json({ message: `Cannot cancel — pickup is already ${pickup.status}` });
    }

    pickup.status = 'cancelled';
    pickup.cancellationReason = reason || 'Cancelled by admin';
    pickup.history.push({
        status: 'cancelled',
        updatedBy: req.user._id,
        remark: pickup.cancellationReason
    });

    await pickup.save();

    const linkedShipmentIds = pickup.shipments
        .map((shipment) => shipment.shipmentId)
        .filter(Boolean);
    if (linkedShipmentIds.length > 0) {
        await Shipment.updateMany(
            { _id: { $in: linkedShipmentIds }, pickupRequestId: pickup._id },
            { $unset: { pickupRequestId: 1 } }
        );
    }

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'pickup_request',
        resourceId: pickup._id,
        description: `Pickup ${pickup.pickupRequestId} cancelled: ${pickup.cancellationReason}`
    });

    res.json(pickup);
});

// @desc    Get pickup stats
// @route   GET /api/pickups/stats
// @access  Private
const getPickupStats = asyncHandler(async (req, res) => {
    const query = pickupScope(req.user);
    if (query === null) {
        return res.json({ total: 0, requested: 0, assigned: 0, inProgress: 0, completed: 0, cancelled: 0, scheduledToday: 0 });
    }

    const [total, requested, assigned, inProgress, completed, cancelled] = await Promise.all([
        PickupRequest.countDocuments(query),
        PickupRequest.countDocuments({ ...query, status: 'requested' }),
        PickupRequest.countDocuments({ ...query, status: 'assigned' }),
        PickupRequest.countDocuments({ ...query, status: 'pickup_started' }),
        PickupRequest.countDocuments({ ...query, status: 'completed' }),
        PickupRequest.countDocuments({ ...query, status: 'cancelled' })
    ]);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const scheduledToday = await PickupRequest.countDocuments({
        ...query,
        preferredDate: { $gte: todayStart, $lte: todayEnd },
        status: { $in: ['requested', 'assigned', 'pickup_started'] }
    });

    res.json({
        total,
        requested,
        assigned,
        inProgress,
        completed,
        cancelled,
        scheduledToday
    });
});

module.exports = {
    createPickupRequest,
    getAvailableShipments,
    getPickupRiders,
    getPickupRequests,
    getPickupRequestById,
    assignRider,
    startPickupRun,
    scanParcelAtPickup,
    markParcelMissed,
    completePickupRun,
    cancelPickupRequest,
    getPickupStats
};
