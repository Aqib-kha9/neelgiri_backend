const asyncHandler = require('express-async-handler');
const Route = require('../models/Route');
const Location = require('../models/Location');
const Pincode = require('../models/Pincode');
const Product = require('../models/Product');
const SystemConfig = require('../models/SystemConfig');
const { generateRouteCode, generateLocationCode, generateSkuCode } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// ==================== ROUTES ====================

const getRoutes = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, type } = req.query;
    if (search) {
        query.$or = [
            { code: { $regex: search, $options: 'i' } },
            { name: { $regex: search, $options: 'i' } },
            { sourceCity: { $regex: search, $options: 'i' } },
            { destinationCity: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (type && type !== 'ALL') query.type = type;

    const routes = await Route.find(query)
        .populate('sourceHub', 'code name')
        .populate('destinationHub', 'code name')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 });
    res.json(routes);
});

const getRouteStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, inactive, blocked] = await Promise.all([
        Route.countDocuments(query),
        Route.countDocuments({ ...query, status: 'ACTIVE' }),
        Route.countDocuments({ ...query, status: 'INACTIVE' }),
        Route.countDocuments({ ...query, status: 'BLOCKED' })
    ]);

    const typeBreakdown = await Route.aggregate([
        { $match: query },
        { $group: { _id: '$type', count: { $sum: 1 } } }
    ]);

    const totalDistanceAgg = await Route.aggregate([
        { $match: query },
        { $group: { _id: null, totalDistance: { $sum: '$totalDistanceKm' }, avgDistance: { $avg: '$totalDistanceKm' } } }
    ]);
    const distanceStats = totalDistanceAgg[0] || { totalDistance: 0, avgDistance: 0 };

    res.json({
        total,
        active,
        inactive,
        blocked,
        typeBreakdown: typeBreakdown.reduce((acc, t) => { acc[t._id] = t.count; return acc; }, {}),
        totalDistanceKm: distanceStats.totalDistance,
        avgDistanceKm: Math.round(distanceStats.avgDistance * 100) / 100
    });
});

const getRouteById = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id)
        .populate('sourceHub', 'code name address')
        .populate('destinationHub', 'code name address')
        .populate('stops.hubId', 'code name')
        .populate('createdBy', 'name email');
    if (!route) {
        res.status(404);
        throw new Error('Route not found');
    }
    res.json(route);
});

const createRoute = asyncHandler(async (req, res) => {
    const routeData = {
        ...req.body,
        code: req.body.code || generateRouteCode(),
        partnerId: getEffectivePartnerId(req.user),
        branchId: getEffectiveBranchId(req.user),
        createdBy: req.user._id
    };

    const route = await Route.create(routeData);

    await logAudit(req, {
        action: 'CREATE',
        resource: 'route',
        resourceId: route._id,
        description: `Route ${route.code} created (${route.sourceCity} → ${route.destinationCity})`
    });

    res.status(201).json(route);
});

const updateRoute = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id);
    if (!route) {
        res.status(404);
        throw new Error('Route not found');
    }

    Object.assign(route, req.body);
    await route.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'route',
        resourceId: route._id,
        description: `Route ${route.code} updated`
    });

    res.json(route);
});

const deleteRoute = asyncHandler(async (req, res) => {
    const route = await Route.findById(req.params.id);
    if (!route) {
        res.status(404);
        throw new Error('Route not found');
    }
    route.isDeleted = true;
    route.status = 'INACTIVE';
    await route.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'route',
        resourceId: route._id,
        description: `Route ${route.code} deleted`
    });

    res.json({ message: 'Route removed' });
});

// ==================== LOCATIONS ====================

const getLocations = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, type, city, state } = req.query;
    if (search) {
        query.$or = [
            { code: { $regex: search, $options: 'i' } },
            { name: { $regex: search, $options: 'i' } },
            { 'address.city': { $regex: search, $options: 'i' } },
            { 'address.state': { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (type && type !== 'ALL') query.type = type;
    if (city) query['address.city'] = { $regex: city, $options: 'i' };
    if (state) query['address.state'] = { $regex: state, $options: 'i' };

    const locations = await Location.find(query)
        .populate('parentLocation', 'code name')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 });
    res.json(locations);
});

const getLocationStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, inactive, maintenance] = await Promise.all([
        Location.countDocuments(query),
        Location.countDocuments({ ...query, status: 'ACTIVE' }),
        Location.countDocuments({ ...query, status: 'INACTIVE' }),
        Location.countDocuments({ ...query, status: 'UNDER_MAINTENANCE' })
    ]);

    const typeBreakdown = await Location.aggregate([
        { $match: query },
        { $group: { _id: '$type', count: { $sum: 1 } } }
    ]);

    const stateBreakdown = await Location.aggregate([
        { $match: query },
        { $group: { _id: '$address.state', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
    ]);

    res.json({
        total,
        active,
        inactive,
        maintenance,
        typeBreakdown: typeBreakdown.reduce((acc, t) => { acc[t._id] = t.count; return acc; }, {}),
        stateBreakdown: stateBreakdown.map(s => ({ state: s._id, count: s.count }))
    });
});

const getLocationById = asyncHandler(async (req, res) => {
    const location = await Location.findById(req.params.id)
        .populate('parentLocation', 'code name')
        .populate('connectedRoutes', 'code name')
        .populate('createdBy', 'name email');
    if (!location) {
        res.status(404);
        throw new Error('Location not found');
    }
    res.json(location);
});

const syncAddressPincodeCoverage = async (location) => {
    if (
        !location.serviceability?.autoMapAddressPincode ||
        location.status !== 'ACTIVE' ||
        !location.address?.pincode
    ) {
        return 0;
    }

    const result = await Pincode.updateMany(
        { pincode: location.address.pincode },
        {
            $set: {
                locationId: location._id,
                isServiceable: true,
                transitDays: location.serviceability.defaultTransitDays || 3
            }
        }
    );

    return result.modifiedCount;
};

const createLocation = asyncHandler(async (req, res) => {
    const locationData = {
        ...req.body,
        code: req.body.code || generateLocationCode(),
        partnerId: getEffectivePartnerId(req.user),
        branchId: getEffectiveBranchId(req.user),
        createdBy: req.user._id
    };

    const location = await Location.create(locationData);
    const mappedPincodes = await syncAddressPincodeCoverage(location);

    await logAudit(req, {
        action: 'CREATE',
        resource: 'location',
        resourceId: location._id,
        description: `Location ${location.code} (${location.name}) created${mappedPincodes ? ` and mapped to ${mappedPincodes} pincode records` : ''}`
    });

    res.status(201).json(location);
});

const updateLocation = asyncHandler(async (req, res) => {
    const location = await Location.findById(req.params.id);
    if (!location) {
        res.status(404);
        throw new Error('Location not found');
    }

    Object.assign(location, req.body);
    await location.save();
    const mappedPincodes = await syncAddressPincodeCoverage(location);

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'location',
        resourceId: location._id,
        description: `Location ${location.code} updated${mappedPincodes ? ` and mapped to ${mappedPincodes} pincode records` : ''}`
    });

    res.json(location);
});

const deleteLocation = asyncHandler(async (req, res) => {
    const location = await Location.findById(req.params.id);
    if (!location) {
        res.status(404);
        throw new Error('Location not found');
    }
    location.isDeleted = true;
    location.status = 'INACTIVE';
    await location.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'location',
        resourceId: location._id,
        description: `Location ${location.code} deleted`
    });

    res.json({ message: 'Location removed' });
});

// ==================== PRODUCTS ====================

const getProducts = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, category, customerId } = req.query;
    if (search) {
        query.$or = [
            { sku: { $regex: search, $options: 'i' } },
            { name: { $regex: search, $options: 'i' } },
            { hsnCode: { $regex: search, $options: 'i' } },
            { barcode: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (category && category !== 'ALL') query.category = { $regex: category, $options: 'i' };
    if (customerId) query.customerId = customerId;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [total, products] = await Promise.all([
        Product.countDocuments(query),
        Product.find(query)
            .populate('customerId', 'name customerId')
            .populate('createdBy', 'name email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
    ]);

    res.json({
        products,
        page,
        pages: Math.ceil(total / limit),
        total
    });
});

const getProductStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, inactive, discontinued] = await Promise.all([
        Product.countDocuments(query),
        Product.countDocuments({ ...query, status: 'active' }),
        Product.countDocuments({ ...query, status: 'inactive' }),
        Product.countDocuments({ ...query, status: 'discontinued' })
    ]);

    const categoryBreakdown = await Product.aggregate([
        { $match: query },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
    ]);

    const fragileCount = await Product.countDocuments({ ...query, 'handlingFlags.fragile': true });
    const hazardousCount = await Product.countDocuments({ ...query, 'handlingFlags.hazardous': true });

    res.json({
        total,
        active,
        inactive,
        discontinued,
        fragileCount,
        hazardousCount,
        categoryBreakdown: categoryBreakdown.map(c => ({ category: c._id, count: c.count }))
    });
});

const getProductById = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id)
        .populate('customerId', 'name customerId')
        .populate('createdBy', 'name email');
    if (!product) {
        res.status(404);
        throw new Error('Product not found');
    }
    res.json(product);
});

const createProduct = asyncHandler(async (req, res) => {
    const productData = {
        ...req.body,
        sku: req.body.sku || generateSkuCode(),
        partnerId: getEffectivePartnerId(req.user),
        branchId: getEffectiveBranchId(req.user),
        createdBy: req.user._id
    };

    // Build dimensionString from dimensions if not provided
    if (req.body.dimensions && !req.body.dimensionString) {
        const d = req.body.dimensions;
        productData.dimensionString = `${d.length} x ${d.width} x ${d.height} ${d.unit || 'cm'}`;
    }

    const product = await Product.create(productData);

    await logAudit(req, {
        action: 'CREATE',
        resource: 'product',
        resourceId: product._id,
        description: `Product ${product.sku} (${product.name}) created`
    });

    res.status(201).json(product);
});

const updateProduct = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) {
        res.status(404);
        throw new Error('Product not found');
    }

    Object.assign(product, req.body);

    // Rebuild dimensionString if dimensions changed
    if (req.body.dimensions) {
        const d = req.body.dimensions;
        product.dimensionString = `${d.length} x ${d.width} x ${d.height} ${d.unit || 'cm'}`;
    }

    await product.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'product',
        resourceId: product._id,
        description: `Product ${product.sku} updated`
    });

    res.json(product);
});

const deleteProduct = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) {
        res.status(404);
        throw new Error('Product not found');
    }
    product.isDeleted = true;
    product.status = 'inactive';
    await product.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'product',
        resourceId: product._id,
        description: `Product ${product.sku} deleted`
    });

    res.json({ message: 'Product removed' });
});

// ==================== SYSTEM CONFIG ====================

const getConfigs = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};

    const { search, category, group } = req.query;
    if (search) {
        query.$or = [
            { key: { $regex: search, $options: 'i' } },
            { label: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } }
        ];
    }
    if (category && category !== 'ALL') query.category = category;
    if (group && group !== 'ALL') query.group = group;

    const configs = await SystemConfig.find(query)
        .populate('updatedBy', 'name email')
        .sort({ category: 1, key: 1 });
    res.json(configs);
});

const getConfigByKey = asyncHandler(async (req, res) => {
    const config = await SystemConfig.findOne({ key: req.params.key });
    if (!config) {
        res.status(404);
        throw new Error('Configuration not found');
    }
    res.json(config);
});

const createConfig = asyncHandler(async (req, res) => {
    const configData = {
        ...req.body,
        partnerId: getEffectivePartnerId(req.user),
        branchId: getEffectiveBranchId(req.user),
        createdBy: req.user._id,
        updatedBy: req.user._id
    };

    const config = await SystemConfig.create(configData);

    await logAudit(req, {
        action: 'CREATE',
        resource: 'system_config',
        resourceId: config._id,
        description: `Config ${config.key} created`
    });

    res.status(201).json(config);
});

const updateConfig = asyncHandler(async (req, res) => {
    const config = await SystemConfig.findById(req.params.id);
    if (!config) {
        res.status(404);
        throw new Error('Configuration not found');
    }
    if (config.isSystem && !config.isEditable) {
        res.status(403);
        throw new Error('This system configuration is not editable');
    }

    Object.assign(config, req.body);
    config.updatedBy = req.user._id;
    await config.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'system_config',
        resourceId: config._id,
        description: `Config ${config.key} updated`,
        details: { newValue: req.body.value }
    });

    res.json(config);
});

const deleteConfig = asyncHandler(async (req, res) => {
    const config = await SystemConfig.findById(req.params.id);
    if (!config) {
        res.status(404);
        throw new Error('Configuration not found');
    }
    if (config.isSystem) {
        res.status(403);
        throw new Error('System configurations cannot be deleted');
    }

    await config.deleteOne();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'system_config',
        resourceId: config._id,
        description: `Config ${config.key} deleted`
    });

    res.json({ message: 'Configuration removed' });
});

// Bulk update configs
const bulkUpdateConfigs = asyncHandler(async (req, res) => {
    const { configs } = req.body;
    if (!Array.isArray(configs) || configs.length === 0) {
        res.status(400);
        throw new Error('Configs array is required');
    }

    const results = [];
    for (const item of configs) {
        const config = await SystemConfig.findById(item._id || item.id);
        if (config && (!config.isSystem || config.isEditable)) {
            config.value = item.value;
            config.updatedBy = req.user._id;
            await config.save();
            results.push({ key: config.key, status: 'updated' });
        }
    }

    await logAudit(req, {
        action: 'BULK_UPDATE',
        resource: 'system_config',
        description: `Bulk updated ${results.length} configurations`
    });

    res.json({ updated: results.length, results });
});

module.exports = {
    // Routes
    getRoutes,
    getRouteStats,
    getRouteById,
    createRoute,
    updateRoute,
    deleteRoute,
    // Locations
    getLocations,
    getLocationStats,
    getLocationById,
    createLocation,
    updateLocation,
    deleteLocation,
    // Products
    getProducts,
    getProductStats,
    getProductById,
    createProduct,
    updateProduct,
    deleteProduct,
    // System Config
    getConfigs,
    getConfigByKey,
    createConfig,
    updateConfig,
    deleteConfig,
    bulkUpdateConfigs
};
