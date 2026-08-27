/**
 * tripController.js
 *
 * Trip management — ties together Vehicle, Driver, Route and Manifests.
 * Represents the physical movement of parcels via a vehicle.
 *
 * Lifecycle: planned → loading → departed → in_transit → arrived → completed
 *             (→ breakdown → reassigned)
 *             (→ cancelled before departed)
 */

const asyncHandler = require('express-async-handler');
const Trip = require('../models/Trip');
const Manifest = require('../models/Manifest');
const Vehicle = require('../models/Vehicle');
const Driver = require('../models/Driver');
const Branch = require('../models/Branch');
const Route = require('../models/Route');
const { generateTripId } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');
const { notifyExceptionRaised } = require('../utils/notificationHelper');
const Exception = require('../models/Exception');
const { generateExceptionId } = require('../utils/idGenerator');

// @desc    Create a trip
// @route   POST /api/trips
// @access  Private (branch_admin, dispatcher, super_admin)
const createTrip = asyncHandler(async (req, res) => {
    const {
        vehicleId,
        driverId,
        routeId,
        originBranch,
        destinationBranch,
        manifests,
        plannedDeparture,
        transportMode,
        vendor,
        notes
    } = req.body;

    if (!originBranch || !destinationBranch) {
        return res.status(400).json({ message: 'Origin and destination branches are required' });
    }

    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user);

    // Fetch related entities for denormalization
    const [originBranchDoc, destBranchDoc, vehicleDoc, driverDoc, routeDoc] = await Promise.all([
        Branch.findById(originBranch).select('name code'),
        Branch.findById(destinationBranch).select('name code'),
        vehicleId ? Vehicle.findById(vehicleId).select('vehicleNumber type') : null,
        driverId ? Driver.findById(driverId).select('name phone') : null,
        routeId ? Route.findById(routeId).select('code name stops totalDistanceKm totalTransitTimeHours') : null
    ]);

    if (!originBranchDoc || !destBranchDoc) {
        return res.status(400).json({ message: 'Invalid origin or destination branch' });
    }

    // Build stops from route if available
    let stops = [];
    if (routeDoc && routeDoc.stops && routeDoc.stops.length > 0) {
        stops = routeDoc.stops.map((s, idx) => ({
            location: s.hubId,
            locationName: s.hubName || '',
            sequence: idx + 1,
            status: 'pending'
        }));
    }

    const trip = await Trip.create({
        tripId: generateTripId(),
        vehicle: vehicleId || null,
        vehicleNumber: vehicleDoc?.vehicleNumber || '',
        driver: driverId || null,
        driverName: driverDoc?.name || '',
        driverPhone: driverDoc?.phone || '',
        route: routeId || null,
        routeCode: routeDoc?.code || '',
        originBranch,
        originBranchName: originBranchDoc.name,
        destinationBranch,
        destinationBranchName: destBranchDoc.name,
        manifests: manifests || [],
        stops,
        plannedDeparture: plannedDeparture || null,
        estimatedArrival: plannedDeparture && routeDoc?.totalTransitTimeHours
            ? new Date(new Date(plannedDeparture).getTime() + routeDoc.totalTransitTimeHours * 3600000)
            : null,
        transportMode: transportMode || 'ROAD',
        vendor: vendor || '',
        totalManifests: manifests ? manifests.length : 0,
        partnerId,
        branchId,
        createdBy: req.user._id,
        history: [{
            status: 'planned',
            updatedBy: req.user._id,
            remark: 'Trip created'
        }],
        notes: notes || ''
    });

    // Link manifests to this trip
    if (manifests && manifests.length > 0) {
        await Manifest.updateMany(
            { _id: { $in: manifests } },
            { $set: { tripId: trip._id, status: 'vehicle_assigned' } }
        );
    }

    await logAudit(req, {
        action: 'CREATE',
        resource: 'trip',
        resourceId: trip._id,
        description: `Trip ${trip.tripId} created: ${originBranchDoc.name} → ${destBranchDoc.name}`
    });

    res.status(201).json(trip);
});

// @desc    Get all trips (scoped)
// @route   GET /api/trips
// @access  Private
const getTrips = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};

    const { status, search, vehicleId, driverId } = req.query;
    if (status && status !== 'ALL') query.status = status;
    if (vehicleId) query.vehicle = vehicleId;
    if (driverId) query.driver = driverId;
    if (search) {
        query.$or = [
            { tripId: { $regex: search, $options: 'i' } },
            { vehicleNumber: { $regex: search, $options: 'i' } },
            { driverName: { $regex: search, $options: 'i' } },
            { originBranchName: { $regex: search, $options: 'i' } },
            { destinationBranchName: { $regex: search, $options: 'i' } }
        ];
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [trips, total] = await Promise.all([
        Trip.find(query)
            .populate('vehicle', 'vehicleNumber type')
            .populate('driver', 'name phone')
            .populate('route', 'code name')
            .populate('originBranch', 'name code')
            .populate('destinationBranch', 'name code')
            .populate('manifests', 'manifestId status')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Trip.countDocuments(query)
    ]);

    res.json({
        trips,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
});

// @desc    Get trip by ID
// @route   GET /api/trips/:id
// @access  Private
const getTripById = asyncHandler(async (req, res) => {
    const trip = await Trip.findById(req.params.id)
        .populate('vehicle', 'vehicleNumber type capacity')
        .populate('driver', 'name phone licenseNumber')
        .populate('route', 'code name stops totalDistanceKm totalTransitTimeHours')
        .populate('originBranch', 'name code address')
        .populate('destinationBranch', 'name code address')
        .populate('manifests', 'manifestId status stats transportDetails');

    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }
    res.json(trip);
});

// @desc    Add manifests to a trip
// @route   POST /api/trips/:id/manifests
// @access  Private (branch_admin, dispatcher)
const addManifestsToTrip = asyncHandler(async (req, res) => {
    const { manifestIds } = req.body;
    if (!manifestIds || !Array.isArray(manifestIds) || manifestIds.length === 0) {
        return res.status(400).json({ message: 'manifestIds array is required' });
    }

    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (['departed', 'in_transit', 'arrived', 'completed', 'cancelled'].includes(trip.status)) {
        return res.status(400).json({ message: `Cannot add manifests — trip is ${trip.status}` });
    }

    // Add manifests that aren't already in the trip
    const existingIds = trip.manifests.map(m => m.toString());
    const newManifestIds = manifestIds.filter(id => !existingIds.includes(id));

    trip.manifests.push(...newManifestIds);
    trip.totalManifests = trip.manifests.length;

    // Update trip stats from manifests
    const manifests = await Manifest.find({ _id: { $in: trip.manifests } });
    trip.totalShipments = manifests.reduce((sum, m) => sum + (m.stats?.totalShipments || 0), 0);
    trip.totalWeight = manifests.reduce((sum, m) => sum + (m.stats?.totalWeight || 0), 0);

    // Link manifests to trip
    await Manifest.updateMany(
        { _id: { $in: newManifestIds } },
        { $set: { tripId: trip._id, status: 'vehicle_assigned' } }
    );

    await trip.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'trip',
        resourceId: trip._id,
        description: `${newManifestIds.length} manifest(s) added to trip ${trip.tripId}`
    });

    res.json(trip);
});

// @desc    Start loading (transition to loading state)
// @route   PUT /api/trips/:id/start-loading
// @access  Private (branch_admin, dispatcher)
const startLoading = asyncHandler(async (req, res) => {
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (trip.status !== 'planned') {
        return res.status(400).json({ message: `Cannot start loading — trip is ${trip.status}` });
    }

    if (trip.manifests.length === 0) {
        return res.status(400).json({ message: 'Cannot start loading — no manifests assigned' });
    }

    trip.status = 'loading';
    trip.history.push({
        status: 'loading',
        updatedBy: req.user._id,
        remark: 'Loading started'
    });

    await trip.save();
    res.json(trip);
});

// @desc    Depart trip (vehicle leaves origin)
// @route   PUT /api/trips/:id/depart
// @access  Private (branch_admin, dispatcher)
const departTrip = asyncHandler(async (req, res) => {
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (!['planned', 'loading'].includes(trip.status)) {
        return res.status(400).json({ message: `Cannot depart — trip is ${trip.status}` });
    }

    trip.status = 'departed';
    trip.actualDeparture = new Date();
    trip.history.push({
        status: 'departed',
        updatedBy: req.user._id,
        location: trip.originBranchName,
        remark: 'Vehicle departed from origin'
    });

    // Update all manifests to in_transit
    await Manifest.updateMany(
        { _id: { $in: trip.manifests } },
        {
            $set: { status: 'in_transit', departedAt: new Date() },
            $push: {
                history: {
                    status: 'in_transit',
                    timestamp: new Date(),
                    updatedBy: req.user._id,
                    remark: `Departed on trip ${trip.tripId}`
                }
            }
        }
    );

    await trip.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'trip',
        resourceId: trip._id,
        description: `Trip ${trip.tripId} departed from ${trip.originBranchName}`
    });

    res.json(trip);
});

// @desc    Mark trip in transit
// @route   PUT /api/trips/:id/in-transit
// @access  Private (branch_admin, dispatcher, rider)
const markInTransit = asyncHandler(async (req, res) => {
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (trip.status !== 'departed') {
        return res.status(400).json({ message: `Cannot mark in-transit — trip is ${trip.status}` });
    }

    trip.status = 'in_transit';
    trip.history.push({
        status: 'in_transit',
        updatedBy: req.user._id,
        remark: 'Trip in transit'
    });

    await trip.save();
    res.json(trip);
});

// @desc    Arrive at a stop
// @route   PUT /api/trips/:id/arrive-stop
// @access  Private (branch_admin, dispatcher, rider)
const arriveAtStop = asyncHandler(async (req, res) => {
    const { stopSequence } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    const stop = trip.stops.find(s => s.sequence === stopSequence);
    if (!stop) {
        return res.status(404).json({ message: 'Stop not found' });
    }

    stop.arrivalTime = new Date();
    stop.status = 'arrived';
    trip.history.push({
        status: 'in_transit',
        updatedBy: req.user._id,
        location: stop.locationName,
        remark: `Arrived at stop ${stop.sequence}: ${stop.locationName}`
    });

    await trip.save();
    res.json(trip);
});

// @desc    Depart from a stop
// @route   PUT /api/trips/:id/depart-stop
// @access  Private (branch_admin, dispatcher, rider)
const departFromStop = asyncHandler(async (req, res) => {
    const { stopSequence } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    const stop = trip.stops.find(s => s.sequence === stopSequence);
    if (!stop) {
        return res.status(404).json({ message: 'Stop not found' });
    }

    stop.departureTime = new Date();
    stop.status = 'departed';
    trip.history.push({
        status: 'in_transit',
        updatedBy: req.user._id,
        location: stop.locationName,
        remark: `Departed from stop ${stop.sequence}: ${stop.locationName}`
    });

    await trip.save();
    res.json(trip);
});

// @desc    Arrive at destination
// @route   PUT /api/trips/:id/arrive
// @access  Private (branch_admin, dispatcher, rider)
const arriveTrip = asyncHandler(async (req, res) => {
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (!['departed', 'in_transit', 'breakdown'].includes(trip.status)) {
        return res.status(400).json({ message: `Cannot arrive — trip is ${trip.status}` });
    }

    trip.status = 'arrived';
    trip.actualArrival = new Date();
    trip.history.push({
        status: 'arrived',
        updatedBy: req.user._id,
        location: trip.destinationBranchName,
        remark: 'Arrived at destination'
    });

    // Update manifests to arrived
    await Manifest.updateMany(
        { _id: { $in: trip.manifests } },
        {
            $set: { status: 'arrived', arrivedAt: new Date() },
            $push: {
                history: {
                    status: 'arrived',
                    timestamp: new Date(),
                    updatedBy: req.user._id,
                    remark: `Arrived at ${trip.destinationBranchName} on trip ${trip.tripId}`
                }
            }
        }
    );

    await trip.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'trip',
        resourceId: trip._id,
        description: `Trip ${trip.tripId} arrived at ${trip.destinationBranchName}`
    });

    res.json(trip);
});

// @desc    Complete trip (all manifests received)
// @route   PUT /api/trips/:id/complete
// @access  Private (branch_admin, dispatcher)
const completeTrip = asyncHandler(async (req, res) => {
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (trip.status !== 'arrived') {
        return res.status(400).json({ message: `Cannot complete — trip is ${trip.status}` });
    }

    trip.status = 'completed';
    trip.history.push({
        status: 'completed',
        updatedBy: req.user._id,
        remark: 'Trip completed'
    });

    await trip.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'trip',
        resourceId: trip._id,
        description: `Trip ${trip.tripId} completed`
    });

    res.json(trip);
});

// @desc    Mark vehicle breakdown
// @route   PUT /api/trips/:id/breakdown
// @access  Private (branch_admin, dispatcher, rider)
const markBreakdown = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (!['departed', 'in_transit'].includes(trip.status)) {
        return res.status(400).json({ message: `Cannot mark breakdown — trip is ${trip.status}` });
    }

    trip.status = 'breakdown';
    trip.breakdownReason = reason || 'Vehicle breakdown';
    trip.breakdownAt = new Date();
    trip.history.push({
        status: 'breakdown',
        updatedBy: req.user._id,
        remark: trip.breakdownReason
    });

    await trip.save();

    // ─── PHASE 4.5: Update linked manifests to 'delayed' status ───
    let affectedManifests = [];
    if (trip.manifests && trip.manifests.length > 0) {
        affectedManifests = await Manifest.updateMany(
            { _id: { $in: trip.manifests }, status: 'in_transit' },
            {
                $set: { status: 'delayed' },
                $push: {
                    history: {
                        status: 'delayed',
                        timestamp: new Date(),
                        remark: `Trip ${trip.tripId} breakdown: ${trip.breakdownReason}`
                    }
                }
            }
        );
    }

    // ─── PHASE 4.5: Create Exception for breakdown ───
    try {
        const exceptionId = await generateExceptionId();
        await Exception.create({
            exceptionId,
            type: 'VEHICLE_BREAKDOWN',
            title: `Vehicle Breakdown - Trip ${trip.tripId}`,
            description: `Vehicle ${trip.vehicleNumber} broke down on trip ${trip.tripId}. Reason: ${trip.breakdownReason}. ${affectedManifests.modifiedCount || 0} manifest(s) affected.`,
            severity: 'HIGH',
            status: 'OPEN',
            category: 'OPERATIONAL',
            branchId: trip.branchId || trip.originBranch,
            partnerId: trip.partnerId,
            createdBy: req.user._id,
            relatedTripId: trip._id
        });
    } catch (excErr) {
        console.error('Failed to create breakdown exception:', excErr.message);
    }

    // ─── PHASE 4.5: Fire-and-forget notification ───
    try {
        notifyExceptionRaised(
            { awb: trip.tripId, _id: trip._id },
            { type: 'VEHICLE_BREAKDOWN', severity: 'HIGH' },
            req.user
        );
    } catch (notifErr) {
        console.error('Breakdown notification failed:', notifErr.message);
    }

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'trip',
        resourceId: trip._id,
        description: `Trip ${trip.tripId} breakdown: ${trip.breakdownReason}`
    });

    res.json({
        ...trip.toObject(),
        breakdownInfo: {
            affectedManifests: affectedManifests.modifiedCount || 0,
            exceptionCreated: true
        }
    });
});

// @desc    Reassign vehicle/driver to a broken-down trip
// @route   PUT /api/trips/:id/reassign
// @access  Private (branch_admin, dispatcher, super_admin)
const reassignVehicle = asyncHandler(async (req, res) => {
    const { vehicleId, driverId } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (trip.status !== 'breakdown') {
        return res.status(400).json({ message: `Cannot reassign — trip is ${trip.status} (must be breakdown)` });
    }

    const [vehicleDoc, driverDoc] = await Promise.all([
        vehicleId ? Vehicle.findById(vehicleId).select('vehicleNumber type') : null,
        driverId ? Driver.findById(driverId).select('name phone') : null
    ]);

    if (vehicleId) {
        trip.vehicle = vehicleId;
        trip.vehicleNumber = vehicleDoc?.vehicleNumber || '';
    }
    if (driverId) {
        trip.driver = driverId;
        trip.driverName = driverDoc?.name || '';
        trip.driverPhone = driverDoc?.phone || '';
    }

    trip.status = 'in_transit';
    trip.breakdownReason = '';
    trip.history.push({
        status: 'in_transit',
        updatedBy: req.user._id,
        remark: `Vehicle/driver reassigned after breakdown. Vehicle: ${trip.vehicleNumber}, Driver: ${trip.driverName}`
    });

    await trip.save();

    // ─── PHASE 4.5: Restore linked manifests to 'in_transit' ───
    let restoredManifests = { modifiedCount: 0 };
    if (trip.manifests && trip.manifests.length > 0) {
        restoredManifests = await Manifest.updateMany(
            { _id: { $in: trip.manifests }, status: 'delayed' },
            {
                $set: { status: 'in_transit' },
                $push: {
                    history: {
                        status: 'in_transit',
                        timestamp: new Date(),
                        remark: `Trip ${trip.tripId} resumed — vehicle reassigned to ${trip.vehicleNumber}`
                    }
                }
            }
        );
    }

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'trip',
        resourceId: trip._id,
        description: `Trip ${trip.tripId} reassigned to vehicle ${trip.vehicleNumber}`
    });

    res.json({
        ...trip.toObject(),
        reassignInfo: {
            restoredManifests: restoredManifests.modifiedCount || 0
        }
    });
});

// @desc    Transfer manifests from a broken-down trip to a new trip
// @route   POST /api/trips/:id/transfer-manifests
// @access  Private (branch_admin, dispatcher, super_admin)
const transferManifests = asyncHandler(async (req, res) => {
    const { newTripId, manifestIds } = req.body;
    const sourceTrip = await Trip.findById(req.params.id);
    if (!sourceTrip) {
        res.status(404);
        throw new Error('Source trip not found');
    }

    if (!['breakdown', 'cancelled'].includes(sourceTrip.status)) {
        return res.status(400).json({
            message: `Cannot transfer manifests — source trip is ${sourceTrip.status} (must be breakdown or cancelled)`
        });
    }

    if (!newTripId) {
        return res.status(400).json({ message: 'newTripId is required' });
    }

    const destTrip = await Trip.findById(newTripId);
    if (!destTrip) {
        res.status(404);
        throw new Error('Destination trip not found');
    }

    if (!['planned', 'loading'].includes(destTrip.status)) {
        return res.status(400).json({
            message: `Destination trip must be in 'planned' or 'loading' state (currently ${destTrip.status})`
        });
    }

    // Determine which manifests to transfer
    const manifestsToTransfer = manifestIds && manifestIds.length > 0
        ? manifestIds
        : sourceTrip.manifests;

    if (!manifestsToTransfer || manifestsToTransfer.length === 0) {
        return res.status(400).json({ message: 'No manifests to transfer' });
    }

    // Update manifests: point to new trip
    const transferResult = await Manifest.updateMany(
        { _id: { $in: manifestsToTransfer } },
        {
            $set: {
                tripId: destTrip._id,
                tripCode: destTrip.tripId,
                status: 'vehicle_assigned'
            },
            $push: {
                history: {
                    status: 'vehicle_assigned',
                    timestamp: new Date(),
                    remark: `Transferred from trip ${sourceTrip.tripId} to trip ${destTrip.tripId} due to ${sourceTrip.status}`
                }
            }
        }
    );

    // Add manifests to destination trip
    await Trip.findByIdAndUpdate(
        destTrip._id,
        {
            $addToSet: { manifests: { $each: manifestsToTransfer } },
            $inc: {
                totalManifests: manifestsToTransfer.length
            }
        }
    );

    // Remove manifests from source trip
    await Trip.findByIdAndUpdate(
        sourceTrip._id,
        {
            $pullAll: { manifests: manifestsToTransfer },
            $set: { reassignedToTrip: destTrip._id }
        }
    );

    // Recalculate stats for destination trip
    const destManifests = await Manifest.find({ _id: { $in: manifestsToTransfer } })
        .populate('shipments.shipment', 'weight');
    let totalShipments = 0;
    let totalWeight = 0;
    destManifests.forEach(m => {
        totalShipments += (m.shipments?.length || 0);
        totalWeight += m.shipments?.reduce((sum, s) => sum + (s.shipment?.weight || 0), 0) || 0;
    });
    await Trip.findByIdAndUpdate(destTrip._id, {
        $inc: { totalShipments, totalWeight }
    });

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'trip',
        resourceId: sourceTrip._id,
        description: `${transferResult.modifiedCount} manifest(s) transferred from trip ${sourceTrip.tripId} to trip ${destTrip.tripId}`
    });

    res.json({
        message: 'Manifests transferred successfully',
        transferredCount: transferResult.modifiedCount,
        fromTrip: sourceTrip.tripId,
        toTrip: destTrip.tripId
    });
});

// @desc    Cancel trip
// @route   PUT /api/trips/:id/cancel
// @access  Private (branch_admin, dispatcher, super_admin)
const cancelTrip = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) {
        res.status(404);
        throw new Error('Trip not found');
    }

    if (['arrived', 'completed'].includes(trip.status)) {
        return res.status(400).json({ message: `Cannot cancel — trip is ${trip.status}` });
    }

    trip.status = 'cancelled';
    trip.history.push({
        status: 'cancelled',
        updatedBy: req.user._id,
        remark: reason || 'Trip cancelled'
    });

    // Unlink manifests
    await Manifest.updateMany(
        { _id: { $in: trip.manifests } },
        { $unset: { tripId: '' }, $set: { status: 'closed' } }
    );

    await trip.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'trip',
        resourceId: trip._id,
        description: `Trip ${trip.tripId} cancelled: ${reason || 'No reason provided'}`
    });

    res.json(trip);
});

// @desc    Get trip stats
// @route   GET /api/trips/stats
// @access  Private
const getTripStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};

    const [total, planned, inTransit, arrived, completed, breakdown, cancelled] = await Promise.all([
        Trip.countDocuments(query),
        Trip.countDocuments({ ...query, status: 'planned' }),
        Trip.countDocuments({ ...query, status: { $in: ['departed', 'in_transit'] } }),
        Trip.countDocuments({ ...query, status: 'arrived' }),
        Trip.countDocuments({ ...query, status: 'completed' }),
        Trip.countDocuments({ ...query, status: 'breakdown' }),
        Trip.countDocuments({ ...query, status: 'cancelled' })
    ]);

    res.json({
        total,
        planned,
        inTransit,
        arrived,
        completed,
        breakdown,
        cancelled
    });
});

module.exports = {
    createTrip,
    getTrips,
    getTripById,
    addManifestsToTrip,
    startLoading,
    departTrip,
    markInTransit,
    arriveAtStop,
    departFromStop,
    arriveTrip,
    completeTrip,
    markBreakdown,
    reassignVehicle,
    transferManifests,
    cancelTrip,
    getTripStats
};
