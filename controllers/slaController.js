/**
 * slaController.js
 *
 * SLA / TAT monitoring API endpoints.
 * Allows admins to check SLA status, trigger breach checks manually,
 * and view approaching breaches.
 */

const asyncHandler = require('express-async-handler');
const Shipment = require('../models/Shipment');
const { buildScopeQuery } = require('../utils/scopeHelper');
const {
    checkAndMarkBreaches,
    getSLAStats,
    getApproachingBreaches,
    setSLA,
    SLA_DEFAULTS
} = require('../utils/slaUtility');

// @desc    Get SLA dashboard / stats
// @route   GET /api/sla/stats
// @access  Private
exports.getSLADashboard = asyncHandler(async (req, res) => {
    const scope = buildScopeQuery(req.user) ?? {};
    const stats = await getSLAStats(scope);

    // Also get approaching breaches
    const approaching = await getApproachingBreaches(6, scope);

    res.json({
        ...stats,
        approachingBreaches: approaching.length,
        approachingShipments: approaching.slice(0, 20) // Top 20
    });
});

// @desc    Get shipments approaching SLA breach
// @route   GET /api/sla/approaching
// @access  Private
exports.getApproaching = asyncHandler(async (req, res) => {
    const scope = buildScopeQuery(req.user) ?? {};
    const withinHours = parseInt(req.query.hours) || 6;

    const shipments = await getApproachingBreaches(withinHours, scope);

    res.json({
        withinHours,
        count: shipments.length,
        shipments
    });
});

// @desc    Get all breached shipments
// @route   GET /api/sla/breached
// @access  Private
exports.getBreached = asyncHandler(async (req, res) => {
    const scope = buildScopeQuery(req.user) ?? {};

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const query = { slaBreached: true, ...scope };

    const [shipments, total] = await Promise.all([
        Shipment.find(query)
            .select('awb status slaDeadline slaBreachedAt slaHours currentBranch originBranch destinationBranch receiver sender')
            .populate('currentBranch originBranch destinationBranch', 'name code')
            .sort({ slaBreachedAt: -1 })
            .skip(skip)
            .limit(limit),
        Shipment.countDocuments(query)
    ]);

    res.json({
        breached: shipments.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        shipments
    });
});

// @desc    Manually trigger SLA breach check
// @route   POST /api/sla/check
// @access  Private (admin only)
exports.triggerBreachCheck = asyncHandler(async (req, res) => {
    const result = await checkAndMarkBreaches(req.user);

    res.json({
        message: 'SLA breach check completed',
        ...result
    });
});

// @desc    Get SLA configuration defaults
// @route   GET /api/sla/config
// @access  Private
exports.getSLAConfig = asyncHandler(async (req, res) => {
    res.json({
        slaDefaults: SLA_DEFAULTS,
        description: 'SLA hours by service type. Used when transit days are not available.'
    });
});

// @desc    Update SLA for a specific shipment (manual override)
// @route   PUT /api/sla/:awb
// @access  Private (admin only)
exports.updateShipmentSLA = asyncHandler(async (req, res) => {
    const { awb } = req.params;
    const { slaHours, serviceType, transitDays } = req.body;

    const shipment = await Shipment.findOne({ awb });
    if (!shipment) {
        res.status(404);
        throw new Error('Shipment not found');
    }

    // Use setSLA utility or manual override
    if (slaHours) {
        shipment.slaHours = slaHours;
        shipment.slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000);
        shipment.slaBreached = false;
        shipment.slaBreachedAt = null;
    } else {
        setSLA(shipment, serviceType || shipment.serviceType, transitDays);
    }

    await shipment.save();

    res.json({
        message: 'SLA updated successfully',
        awb,
        slaHours: shipment.slaHours,
        slaDeadline: shipment.slaDeadline
    });
});
