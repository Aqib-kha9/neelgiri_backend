const asyncHandler = require('express-async-handler');
const Vehicle = require('../models/Vehicle');
const Driver = require('../models/Driver');
const { generateVehicleCode } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// @desc    Get all vehicles (role-scoped)
// @route   GET /api/vehicles
// @access  Private
const getVehicles = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, type, ownershipType } = req.query;
    if (search) {
        query.$or = [
            { regNo: { $regex: search, $options: 'i' } },
            { make: { $regex: search, $options: 'i' } },
            { driverName: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (type && type !== 'ALL') query.type = type;
    if (ownershipType && ownershipType !== 'ALL') query.ownershipType = ownershipType;

    const vehicles = await Vehicle.find(query)
        .populate('assignedDriverId', 'name phone code')
        .sort({ createdAt: -1 });

    res.json(vehicles);
});

// @desc    Get vehicle stats
// @route   GET /api/vehicles/stats
// @access  Private
const getVehicleStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, available, inTransit, maintenance, breakdown] = await Promise.all([
        Vehicle.countDocuments(query),
        Vehicle.countDocuments({ ...query, status: 'AVAILABLE' }),
        Vehicle.countDocuments({ ...query, status: 'IN_TRANSIT' }),
        Vehicle.countDocuments({ ...query, status: 'MAINTENANCE' }),
        Vehicle.countDocuments({ ...query, status: 'BREAKDOWN' })
    ]);

    res.json({ total, available, inTransit, maintenance, breakdown });
});

// @desc    Get single vehicle
// @route   GET /api/vehicles/:id
// @access  Private
const getVehicleById = asyncHandler(async (req, res) => {
    const vehicle = await Vehicle.findById(req.params.id).populate('assignedDriverId');
    if (!vehicle || vehicle.isDeleted) {
        res.status(404);
        throw new Error('Vehicle not found');
    }
    res.json(vehicle);
});

// @desc    Create vehicle
// @route   POST /api/vehicles
// @access  Private
const createVehicle = asyncHandler(async (req, res) => {
    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;

    const regExists = await Vehicle.findOne({ regNo: req.body.regNo?.toUpperCase() });
    if (regExists) {
        res.status(400);
        throw new Error('Vehicle with this registration number already exists');
    }

    const code = req.body.code || generateVehicleCode();

    const vehicle = await Vehicle.create({
        ...req.body,
        code,
        partnerId,
        branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'vehicle',
        resourceId: vehicle._id,
        description: `Vehicle ${vehicle.regNo} created`,
        details: { regNo: vehicle.regNo, type: vehicle.type }
    });

    res.status(201).json(vehicle);
});

// @desc    Update vehicle
// @route   PUT /api/vehicles/:id
// @access  Private
const updateVehicle = asyncHandler(async (req, res) => {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle || vehicle.isDeleted) {
        res.status(404);
        throw new Error('Vehicle not found');
    }

    Object.assign(vehicle, req.body);
    await vehicle.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'vehicle',
        resourceId: vehicle._id,
        description: `Vehicle ${vehicle.regNo} updated`,
        details: req.body
    });

    res.json(vehicle);
});

// @desc    Soft delete vehicle
// @route   DELETE /api/vehicles/:id
// @access  Private
const deleteVehicle = asyncHandler(async (req, res) => {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) {
        res.status(404);
        throw new Error('Vehicle not found');
    }

    vehicle.isDeleted = true;
    vehicle.status = 'MAINTENANCE';
    await vehicle.save();

    // Unassign from driver
    if (vehicle.assignedDriverId) {
        await Driver.findByIdAndUpdate(vehicle.assignedDriverId, { currentVehicleId: null });
    }

    await logAudit(req, {
        action: 'DELETE',
        resource: 'vehicle',
        resourceId: vehicle._id,
        description: `Vehicle ${vehicle.regNo} deleted`
    });

    res.json({ message: 'Vehicle removed' });
});

// @desc    Assign driver to vehicle
// @route   PUT /api/vehicles/:id/assign-driver
// @access  Private
const assignDriver = asyncHandler(async (req, res) => {
    const { driverId } = req.body;
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) {
        res.status(404);
        throw new Error('Vehicle not found');
    }

    // Release previous driver
    if (vehicle.assignedDriverId) {
        await Driver.findByIdAndUpdate(vehicle.assignedDriverId, { currentVehicleId: null });
    }

    if (driverId) {
        const driver = await Driver.findById(driverId);
        if (!driver) {
            res.status(404);
            throw new Error('Driver not found');
        }
        // Release driver's previous vehicle
        if (driver.currentVehicleId) {
            await Vehicle.findByIdAndUpdate(driver.currentVehicleId, { assignedDriverId: null, driverName: null, driverPhone: null });
        }
        driver.currentVehicleId = vehicle._id;
        await driver.save();
        vehicle.assignedDriverId = driver._id;
        vehicle.driverName = driver.name;
        vehicle.driverPhone = driver.phone;
    } else {
        vehicle.assignedDriverId = null;
        vehicle.driverName = null;
        vehicle.driverPhone = null;
    }

    await vehicle.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'vehicle',
        resourceId: vehicle._id,
        description: `Driver ${driverId || 'unassigned'} assigned to vehicle ${vehicle.regNo}`,
        details: { driverId }
    });

    res.json(vehicle);
});

module.exports = {
    getVehicles,
    getVehicleStats,
    getVehicleById,
    createVehicle,
    updateVehicle,
    deleteVehicle,
    assignDriver
};
