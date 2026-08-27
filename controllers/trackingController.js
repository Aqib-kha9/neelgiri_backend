const asyncHandler = require('express-async-handler');
const Tracking = require('../models/Tracking');
const Shipment = require('../models/Shipment');
const DRS = require('../models/DRS');
const Driver = require('../models/Driver');
const { generateTrackingId } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// @desc    Update rider location (called by rider app)
// @route   POST /api/tracking/location
// @access  Private
const updateLocation = asyncHandler(async (req, res) => {
    const { latitude, longitude, accuracy, heading, speed, batteryLevel, networkType, awb, drsId, event, remark, address } = req.body;

    if (latitude === undefined || longitude === undefined) {
        res.status(400);
        throw new Error('Latitude and longitude are required');
    }

    // Find active DRS for this rider if drsId not provided
    let activeDrs = null;
    let activeAwb = awb;
    let riderName = req.user.name;

    if (drsId) {
        activeDrs = await DRS.findOne({ drsId });
        if (activeDrs) {
            riderName = riderName || req.user.name;
        }
    } else {
        activeDrs = await DRS.findOne({ rider: req.user._id, status: 'in_progress' });
        if (activeDrs && !activeAwb && activeDrs.shipments.length > 0) {
            const pendingShipment = activeDrs.shipments.find(s => s.status === 'pending' || s.status === 'scheduled');
            if (pendingShipment) activeAwb = pendingShipment.awb;
        }
    }

    // Get driver info
    const driver = await Driver.findOne({ userId: req.user._id }).select('driverCode name');
    if (driver) riderName = driver.name;

    const trackingPing = await Tracking.create({
        trackingId: generateTrackingId(),
        awb: activeAwb,
        riderId: req.user._id,
        riderName,
        drsId: activeDrs ? activeDrs.drsId : null,
        location: {
            latitude,
            longitude,
            accuracy: accuracy || null,
            heading: heading || null,
            speed: speed || 0
        },
        address: address || '',
        batteryLevel: batteryLevel || null,
        networkType: networkType || 'UNKNOWN',
        event: event || 'LOCATION_UPDATE',
        remark: remark || '',
        partnerId: getEffectivePartnerId(req.user),
        branchId: getEffectiveBranchId(req.user),
        createdBy: req.user._id
    });

    // If event is delivery-related, update shipment
    if (event === 'DELIVERY_COMPLETE' && activeAwb) {
        await Shipment.findOneAndUpdate(
            { awb: activeAwb },
            { $push: { history: { status: 'complete', updatedBy: req.user._id, remark: 'Delivery completed via rider app' } } }
        );
    }

    res.status(201).json({
        message: 'Location updated',
        trackingId: trackingPing.trackingId,
        timestamp: trackingPing.createdAt
    });
});

// @desc    Get live tracking for a shipment by AWB
// @route   GET /api/tracking/awb/:awb
// @access  Private
const getTrackingByAwb = asyncHandler(async (req, res) => {
    const { awb } = req.params;

    const shipment = await Shipment.findOne({ awb }).select('awb status sender receiver history createdAt deliveredAt');
    if (!shipment) {
        res.status(404);
        throw new Error('Shipment not found');
    }

    // Get latest tracking ping
    const latestPing = await Tracking.findOne({ awb }).sort({ createdAt: -1 });

    // Get tracking history (last 100 pings)
    const trackingHistory = await Tracking.find({ awb })
        .sort({ createdAt: -1 })
        .limit(100)
        .select('location address event createdAt batteryLevel');

    // Build tracking timeline from shipment history + tracking pings
    const timeline = [];

    // Add shipment history events
    if (shipment.history && shipment.history.length > 0) {
        shipment.history.forEach(h => {
            timeline.push({
                type: 'STATUS_CHANGE',
                status: h.status,
                remark: h.remark || '',
                timestamp: h.timestamp,
                location: null
            });
        });
    }

    // Add tracking location events
    trackingHistory.reverse().forEach(p => {
        timeline.push({
            type: 'TRACKING',
            event: p.event,
            location: p.location,
            address: p.address,
            timestamp: p.createdAt,
            batteryLevel: p.batteryLevel
        });
    });

    // Sort by timestamp
    timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.json({
        awb: shipment.awb,
        status: shipment.status,
        sender: shipment.sender,
        receiver: shipment.receiver,
        createdAt: shipment.createdAt,
        deliveredAt: shipment.deliveredAt,
        currentLocation: latestPing ? {
            latitude: latestPing.location.latitude,
            longitude: latestPing.location.longitude,
            address: latestPing.address,
            updatedAt: latestPing.createdAt,
            speed: latestPing.location.speed,
            heading: latestPing.location.heading
        } : null,
        rider: latestPing ? {
            name: latestPing.riderName,
            id: latestPing.riderId
        } : null,
        timeline,
        totalPings: trackingHistory.length
    });
});

// @desc    Get all active riders with live locations
// @route   GET /api/tracking/active-riders
// @access  Private
const getActiveRiders = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};

    // Find all active DRS
    const activeDrsList = await DRS.find({ status: 'in_progress' })
        .populate('rider', 'name email phone')
        .select('drsId rider branchId vehicleMode shipments stats startDate');

    // Filter by scope
    const filteredDrs = activeDrsList.filter(drs => {
        if (req.user.role === 'super_admin') return true;
        if (req.user.role === 'partner_admin' || req.user.role === 'partner') {
            return drs.branchId && drs.branchId.toString() === req.user.branchId?.toString();
        }
        return drs.branchId && drs.branchId.toString() === req.user.branchId?.toString();
    });

    // Get latest ping for each rider
    const activeRiders = await Promise.all(filteredDrs.map(async (drs) => {
        const latestPing = await Tracking.findOne({ drsId: drs.drsId })
            .sort({ createdAt: -1 })
            .select('location address createdAt batteryLevel speed heading awb');

        const driver = await Driver.findOne({ userId: drs.rider._id }).select('driverCode name phone vehicleMode');

        return {
            drsId: drs.drsId,
            riderId: drs.rider._id,
            riderName: drs.rider.name,
            riderPhone: drs.rider.phone,
            driverCode: driver?.driverCode || '',
            vehicleMode: drs.vehicleMode,
            currentLocation: latestPing ? {
                latitude: latestPing.location.latitude,
                longitude: latestPing.location.longitude,
                address: latestPing.address,
                updatedAt: latestPing.createdAt,
                speed: latestPing.location.speed,
                heading: latestPing.location.heading
            } : null,
            batteryLevel: latestPing?.batteryLevel || null,
            currentAwb: latestPing?.awb || null,
            stats: drs.stats,
            startDate: drs.startDate,
            totalShipments: drs.shipments.length,
            isOnline: latestPing ? (Date.now() - new Date(latestPing.createdAt).getTime() < 5 * 60 * 1000) : false
        };
    }));

    res.json(activeRiders);
});

// @desc    Get tracking history for a rider
// @route   GET /api/tracking/rider/:riderId
// @access  Private
const getRiderTracking = asyncHandler(async (req, res) => {
    const { riderId } = req.params;
    const { startDate, endDate, limit } = req.query;

    const query = { riderId };
    if (startDate && endDate) {
        query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const maxLimit = parseInt(limit) || 500;
    const pings = await Tracking.find(query)
        .sort({ createdAt: -1 })
        .limit(maxLimit)
        .select('location address event awb drsId createdAt batteryLevel speed');

    // Calculate total distance
    let totalDistance = 0;
    for (let i = 0; i < pings.length - 1; i++) {
        const p1 = pings[i].location;
        const p2 = pings[i + 1].location;
        if (p1 && p2) {
            totalDistance += haversineDistance(p1.latitude, p1.longitude, p2.latitude, p2.longitude);
        }
    }

    res.json({
        riderId,
        totalPings: pings.length,
        totalDistanceKm: Math.round(totalDistance * 100) / 100,
        pings: pings.reverse()
    });
});

// Helper: Haversine distance formula
const haversineDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

// @desc    Get tracking stats
// @route   GET /api/tracking/stats
// @access  Private
const getTrackingStats = asyncHandler(async (req, res) => {
    const scopeQuery = buildScopeQuery(req.user) ?? {};

    const now = new Date();
    const fiveMinsAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [activeRiders, totalPingsToday, totalPingsLastHour, activeDrsCount] = await Promise.all([
        Tracking.distinct('riderId', { ...scopeQuery, createdAt: { $gte: fiveMinsAgo } }),
        Tracking.countDocuments({ ...scopeQuery, createdAt: { $gte: todayStart } }),
        Tracking.countDocuments({ ...scopeQuery, createdAt: { $gte: oneHourAgo } }),
        DRS.countDocuments({ status: 'in_progress' })
    ]);

    res.json({
        activeRiders: activeRiders.length,
        activeDrs: activeDrsCount,
        totalPingsToday,
        totalPingsLastHour,
        onlineRiders: activeRiders.length
    });
});

// @desc    Get tracking timeline for a DRS
// @route   GET /api/tracking/drs/:drsId
// @access  Private
const getTrackingByDrs = asyncHandler(async (req, res) => {
    const { drsId } = req.params;

    const drs = await DRS.findOne({ drsId })
        .populate('rider', 'name email phone')
        .populate('shipments.awb');

    if (!drs) {
        res.status(404);
        throw new Error('DRS not found');
    }

    // Get all tracking pings for this DRS
    const pings = await Tracking.find({ drsId })
        .sort({ createdAt: 1 })
        .select('location address event awb createdAt batteryLevel speed');

    // Calculate total distance
    let totalDistance = 0;
    for (let i = 0; i < pings.length - 1; i++) {
        const p1 = pings[i].location;
        const p2 = pings[i + 1].location;
        if (p1 && p2) {
            totalDistance += haversineDistance(p1.latitude, p1.longitude, p2.latitude, p2.longitude);
        }
    }

    // Get latest location
    const latestPing = pings.length > 0 ? pings[pings.length - 1] : null;

    res.json({
        drsId: drs.drsId,
        rider: drs.rider,
        status: drs.status,
        vehicleMode: drs.vehicleMode,
        startDate: drs.startDate,
        stats: drs.stats,
        totalShipments: drs.shipments.length,
        currentLocation: latestPing ? {
            latitude: latestPing.location.latitude,
            longitude: latestPing.location.longitude,
            address: latestPing.address,
            updatedAt: latestPing.createdAt,
            speed: latestPing.location.speed
        } : null,
        totalDistanceKm: Math.round(totalDistance * 100) / 100,
        totalPings: pings.length,
        timeline: pings
    });
});

// @desc    Get nearby riders (within radius)
// @route   GET /api/tracking/nearby
// @access  Private
const getNearbyRiders = asyncHandler(async (req, res) => {
    const { latitude, longitude, radiusKm } = req.query;

    if (!latitude || !longitude) {
        res.status(400);
        throw new Error('Latitude and longitude are required');
    }

    const radius = parseFloat(radiusKm) || 10; // default 10km
    const scopeQuery = buildScopeQuery(req.user) ?? {};

    // Get all unique riders with recent pings
    const recentTime = new Date(Date.now() - 30 * 60 * 1000); // last 30 mins
    const pings = await Tracking.find({
        ...scopeQuery,
        createdAt: { $gte: recentTime }
    }).sort({ createdAt: -1 });

    // Deduplicate by riderId (keep latest)
    const riderMap = new Map();
    pings.forEach(p => {
        if (!riderMap.has(p.riderId.toString())) {
            riderMap.set(p.riderId.toString(), p);
        }
    });

    // Filter by radius
    const nearbyRiders = [];
    riderMap.forEach(ping => {
        const distance = haversineDistance(
            parseFloat(latitude), parseFloat(longitude),
            ping.location.latitude, ping.location.longitude
        );
        if (distance <= radius) {
            nearbyRiders.push({
                riderId: ping.riderId,
                riderName: ping.riderName,
                distance: Math.round(distance * 100) / 100,
                location: {
                    latitude: ping.location.latitude,
                    longitude: ping.location.longitude,
                    address: ping.address,
                    updatedAt: ping.createdAt
                },
                awb: ping.awb,
                drsId: ping.drsId
            });
        }
    });

    nearbyRiders.sort((a, b) => a.distance - b.distance);

    res.json({
        center: { latitude: parseFloat(latitude), longitude: parseFloat(longitude) },
        radiusKm: radius,
        totalNearby: nearbyRiders.length,
        riders: nearbyRiders
    });
});

module.exports = {
    updateLocation,
    getTrackingByAwb,
    getActiveRiders,
    getRiderTracking,
    getTrackingStats,
    getTrackingByDrs,
    getNearbyRiders
};
