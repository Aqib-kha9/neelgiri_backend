const asyncHandler = require('express-async-handler');
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');
const { generateDriverCode } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// @desc    Get all drivers (role-scoped)
// @route   GET /api/drivers
// @access  Private
const getDrivers = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, verificationStatus } = req.query;
    if (search) {
        query.$or = [
            { name: { $regex: search, $options: 'i' } },
            { code: { $regex: search, $options: 'i' } },
            { phone: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (verificationStatus && verificationStatus !== 'ALL') query.verificationStatus = verificationStatus;

    const drivers = await Driver.find(query)
        .populate('currentVehicleId', 'regNo type')
        .sort({ createdAt: -1 });

    res.json(drivers);
});

// @desc    Get driver stats
// @route   GET /api/drivers/stats
// @access  Private
const getDriverStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, onLeave, pending, avgRatingAgg] = await Promise.all([
        Driver.countDocuments(query),
        Driver.countDocuments({ ...query, status: 'ACTIVE' }),
        Driver.countDocuments({ ...query, status: 'ON_LEAVE' }),
        Driver.countDocuments({ ...query, verificationStatus: 'PENDING' }),
        Driver.aggregate([
            { $match: query },
            { $group: { _id: null, avgRating: { $avg: '$rating' } } }
        ])
    ]);

    res.json({
        total,
        active,
        onLeave,
        inactive: total - active - onLeave,
        pendingVerification: pending,
        avgRating: avgRatingAgg[0]?.avgRating ? Number(avgRatingAgg[0].avgRating.toFixed(2)) : 0
    });
});

// @desc    Get single driver
// @route   GET /api/drivers/:id
// @access  Private
const getDriverById = asyncHandler(async (req, res) => {
    const driver = await Driver.findById(req.params.id).populate('currentVehicleId');
    if (!driver || driver.isDeleted) {
        res.status(404);
        throw new Error('Driver not found');
    }
    res.json(driver);
});

// @desc    Create driver
// @route   POST /api/drivers
// @access  Private
const createDriver = asyncHandler(async (req, res) => {
    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.body.hubId || req.user.branchId;

    const code = req.body.code || generateDriverCode();

    const driverExists = await Driver.findOne({ $or: [{ code }, { phone: req.body.phone }] });
    if (driverExists) {
        res.status(400);
        throw new Error('Driver with this code or phone already exists');
    }

    const driver = await Driver.create({
        ...req.body,
        code,
        partnerId,
        branchId,
        hubId: branchId ? String(branchId) : undefined,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'driver',
        resourceId: driver._id,
        description: `Driver ${driver.name} (${driver.code}) created`,
        details: { code: driver.code, phone: driver.phone }
    });

    res.status(201).json(driver);
});

// @desc    Update driver
// @route   PUT /api/drivers/:id
// @access  Private
const updateDriver = asyncHandler(async (req, res) => {
    const driver = await Driver.findById(req.params.id);
    if (!driver || driver.isDeleted) {
        res.status(404);
        throw new Error('Driver not found');
    }

    Object.assign(driver, req.body);
    await driver.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'driver',
        resourceId: driver._id,
        description: `Driver ${driver.name} (${driver.code}) updated`,
        details: req.body
    });

    res.json(driver);
});

// @desc    Soft delete driver
// @route   DELETE /api/drivers/:id
// @access  Private
const deleteDriver = asyncHandler(async (req, res) => {
    const driver = await Driver.findById(req.params.id);
    if (!driver) {
        res.status(404);
        throw new Error('Driver not found');
    }

    driver.isDeleted = true;
    driver.status = 'INACTIVE';
    await driver.save();

    // Unassign from any vehicle
    if (driver.currentVehicleId) {
        await Vehicle.findByIdAndUpdate(driver.currentVehicleId, { assignedDriverId: null });
    }

    await logAudit(req, {
        action: 'DELETE',
        resource: 'driver',
        resourceId: driver._id,
        description: `Driver ${driver.name} (${driver.code}) deleted`
    });

    res.json({ message: 'Driver removed' });
});

// @desc    Assign vehicle to driver
// @route   PUT /api/drivers/:id/assign-vehicle
// @access  Private
const assignVehicle = asyncHandler(async (req, res) => {
    const { vehicleId } = req.body;
    const driver = await Driver.findById(req.params.id);
    if (!driver) {
        res.status(404);
        throw new Error('Driver not found');
    }

    // Release previous vehicle
    if (driver.currentVehicleId) {
        await Vehicle.findByIdAndUpdate(driver.currentVehicleId, { assignedDriverId: null });
    }

    if (vehicleId) {
        const vehicle = await Vehicle.findById(vehicleId);
        if (!vehicle) {
            res.status(404);
            throw new Error('Vehicle not found');
        }
        vehicle.assignedDriverId = driver._id;
        vehicle.driverName = driver.name;
        vehicle.driverPhone = driver.phone;
        await vehicle.save();
        driver.currentVehicleId = vehicle._id;
    } else {
        driver.currentVehicleId = null;
    }

    await driver.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'driver',
        resourceId: driver._id,
        description: `Vehicle ${vehicleId || 'unassigned'} assigned to driver ${driver.name}`,
        details: { vehicleId }
    });

    res.json(driver);
});

module.exports = {
    getDrivers,
    getDriverStats,
    getDriverById,
    createDriver,
    updateDriver,
    deleteDriver,
    assignVehicle
};
