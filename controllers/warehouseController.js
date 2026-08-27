const asyncHandler = require('express-async-handler');
const Warehouse = require('../models/Warehouse');
const Inventory = require('../models/Inventory');
const Asset = require('../models/Asset');
const { generateSkuCode, generateAssetCode, generateLocationCode } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// ==================== WAREHOUSE ====================

const getWarehouses = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, type } = req.query;
    if (search) {
        query.$or = [
            { code: { $regex: search, $options: 'i' } },
            { name: { $regex: search, $options: 'i' } },
            { 'address.city': { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (type && type !== 'ALL') query.type = type;

    const warehouses = await Warehouse.find(query)
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 });
    res.json(warehouses);
});

const getWarehouseStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, maintenance, inactive] = await Promise.all([
        Warehouse.countDocuments(query),
        Warehouse.countDocuments({ ...query, status: 'ACTIVE' }),
        Warehouse.countDocuments({ ...query, status: 'MAINTENANCE' }),
        Warehouse.countDocuments({ ...query, status: 'INACTIVE' })
    ]);

    const capacityAgg = await Warehouse.aggregate([
        { $match: query },
        { $group: { _id: null, totalArea: { $sum: '$totalArea' }, usedArea: { $sum: '$usedArea' } } }
    ]);
    const capacity = capacityAgg[0] || { totalArea: 0, usedArea: 0 };

    res.json({
        total, active, maintenance, inactive,
        totalArea: capacity.totalArea,
        usedArea: capacity.usedArea,
        utilizationRate: capacity.totalArea > 0 ? Number(((capacity.usedArea / capacity.totalArea) * 100).toFixed(2)) : 0
    });
});

const getWarehouseById = asyncHandler(async (req, res) => {
    const warehouse = await Warehouse.findById(req.params.id).populate('createdBy', 'name email');
    if (!warehouse || warehouse.isDeleted) {
        res.status(404);
        throw new Error('Warehouse not found');
    }
    res.json(warehouse);
});

const createWarehouse = asyncHandler(async (req, res) => {
    const { name, type, address, totalArea, contactPerson, phone, email, operatingHours, facilities } = req.body;
    if (!name) {
        res.status(400);
        throw new Error('name is required');
    }

    const code = generateLocationCode();
    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;

    const warehouse = await Warehouse.create({
        code,
        name,
        type: type || 'HUB',
        address,
        totalArea,
        contactPerson,
        phone,
        email,
        operatingHours,
        facilities,
        partnerId,
        branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'warehouse',
        resourceId: warehouse._id,
        description: `Warehouse ${warehouse.name} (${warehouse.code}) created`,
        details: { code, name, type }
    });

    res.status(201).json(warehouse);
});

const updateWarehouse = asyncHandler(async (req, res) => {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse || warehouse.isDeleted) {
        res.status(404);
        throw new Error('Warehouse not found');
    }

    Object.assign(warehouse, req.body);
    if (warehouse.totalArea > 0) {
        warehouse.capacityUtilization = Number(((warehouse.usedArea / warehouse.totalArea) * 100).toFixed(2));
    }
    await warehouse.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'warehouse',
        resourceId: warehouse._id,
        description: `Warehouse ${warehouse.name} (${warehouse.code}) updated`,
        details: req.body
    });

    res.json(warehouse);
});

const deleteWarehouse = asyncHandler(async (req, res) => {
    const warehouse = await Warehouse.findById(req.params.id);
    if (!warehouse) {
        res.status(404);
        throw new Error('Warehouse not found');
    }
    warehouse.isDeleted = true;
    warehouse.status = 'INACTIVE';
    await warehouse.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'warehouse',
        resourceId: warehouse._id,
        description: `Warehouse ${warehouse.name} (${warehouse.code}) deleted`
    });

    res.json({ message: 'Warehouse removed' });
});

// ==================== INVENTORY ====================

const getInventory = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, category, status, warehouseId } = req.query;
    if (search) {
        query.$or = [
            { skuCode: { $regex: search, $options: 'i' } },
            { name: { $regex: search, $options: 'i' } }
        ];
    }
    if (category && category !== 'ALL') query.category = category;
    if (status && status !== 'ALL') query.status = status;
    if (warehouseId) query.warehouseId = warehouseId;

    const items = await Inventory.find(query)
        .populate('warehouseId', 'code name')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 });
    res.json(items);
});

const getInventoryStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, inStock, lowStock, outOfStock, discontinued] = await Promise.all([
        Inventory.countDocuments(query),
        Inventory.countDocuments({ ...query, status: 'IN_STOCK' }),
        Inventory.countDocuments({ ...query, status: 'LOW_STOCK' }),
        Inventory.countDocuments({ ...query, status: 'OUT_OF_STOCK' }),
        Inventory.countDocuments({ ...query, status: 'DISCONTINUED' })
    ]);

    const valueAgg = await Inventory.aggregate([
        { $match: query },
        { $group: { _id: null, totalValue: { $sum: '$totalValue' } } }
    ]);

    res.json({
        total, inStock, lowStock, outOfStock, discontinued,
        totalValue: Number((valueAgg[0]?.totalValue || 0).toFixed(2))
    });
});

const getInventoryById = asyncHandler(async (req, res) => {
    const item = await Inventory.findById(req.params.id)
        .populate('warehouseId')
        .populate('transactions.performedBy', 'name email');
    if (!item || item.isDeleted) {
        res.status(404);
        throw new Error('Inventory item not found');
    }
    res.json(item);
});

const createInventory = asyncHandler(async (req, res) => {
    const { name, description, category, quantity, reorderLevel, maxLevel, unit, unitCost, warehouseId, warehouseName, storageLocation } = req.body;
    if (!name) {
        res.status(400);
        throw new Error('name is required');
    }

    const skuCode = generateSkuCode();
    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;

    const item = await Inventory.create({
        skuCode,
        name,
        description,
        category: category || 'PACKAGING',
        quantity: quantity || 0,
        reorderLevel: reorderLevel || 0,
        maxLevel: maxLevel || 0,
        unit: unit || 'PIECE',
        unitCost: unitCost || 0,
        warehouseId,
        warehouseName,
        storageLocation,
        partnerId,
        branchId,
        createdBy: req.user._id,
        transactions: quantity > 0 ? [{
            type: 'INWARD',
            quantity: quantity,
            reference: 'Initial stock',
            performedBy: req.user._id
        }] : []
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'inventory',
        resourceId: item._id,
        description: `Inventory item ${item.name} (${item.skuCode}) created`,
        details: { skuCode, name, quantity }
    });

    res.status(201).json(item);
});

const updateInventory = asyncHandler(async (req, res) => {
    const item = await Inventory.findById(req.params.id);
    if (!item || item.isDeleted) {
        res.status(404);
        throw new Error('Inventory item not found');
    }

    Object.assign(item, req.body);
    await item.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'inventory',
        resourceId: item._id,
        description: `Inventory item ${item.name} (${item.skuCode}) updated`,
        details: req.body
    });

    res.json(item);
});

// @desc    Stock transaction (inward/outward/adjustment)
// @route   POST /api/inventory/:id/transaction
const stockTransaction = asyncHandler(async (req, res) => {
    const { type, quantity, reference, remarks } = req.body;
    if (!type || !quantity) {
        res.status(400);
        throw new Error('type and quantity are required');
    }

    const item = await Inventory.findById(req.params.id);
    if (!item || item.isDeleted) {
        res.status(404);
        throw new Error('Inventory item not found');
    }

    if (type === 'INWARD') {
        item.quantity += Number(quantity);
    } else if (type === 'OUTWARD') {
        if (item.quantity < Number(quantity)) {
            res.status(400);
            throw new Error('Insufficient stock');
        }
        item.quantity -= Number(quantity);
    } else if (type === 'ADJUSTMENT') {
        item.quantity = Number(quantity); // set absolute
    }

    item.transactions.push({
        type,
        quantity: Number(quantity),
        reference,
        remarks,
        performedBy: req.user._id
    });

    await item.save();

    await logAudit(req, {
        action: 'STOCK_TRANSACTION',
        resource: 'inventory',
        resourceId: item._id,
        description: `Stock ${type.toLowerCase()} of ${quantity} for ${item.skuCode}`,
        details: { type, quantity, newQuantity: item.quantity }
    });

    res.json(item);
});

const deleteInventory = asyncHandler(async (req, res) => {
    const item = await Inventory.findById(req.params.id);
    if (!item) {
        res.status(404);
        throw new Error('Inventory item not found');
    }
    item.isDeleted = true;
    item.status = 'DISCONTINUED';
    await item.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'inventory',
        resourceId: item._id,
        description: `Inventory item ${item.name} (${item.skuCode}) deleted`
    });

    res.json({ message: 'Inventory item removed' });
});

// ==================== ASSETS ====================

const getAssets = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, type, status } = req.query;
    if (search) {
        query.$or = [
            { assetCode: { $regex: search, $options: 'i' } },
            { name: { $regex: search, $options: 'i' } },
            { assignedToName: { $regex: search, $options: 'i' } }
        ];
    }
    if (type && type !== 'ALL') query.type = type;
    if (status && status !== 'ALL') query.status = status;

    const assets = await Asset.find(query)
        .populate('assignedTo', 'name email')
        .populate('warehouseId', 'code name')
        .sort({ createdAt: -1 });
    res.json(assets);
});

const getAssetStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, active, assigned, maintenance, retired, lost] = await Promise.all([
        Asset.countDocuments(query),
        Asset.countDocuments({ ...query, status: 'ACTIVE' }),
        Asset.countDocuments({ ...query, status: 'ASSIGNED' }),
        Asset.countDocuments({ ...query, status: 'MAINTENANCE' }),
        Asset.countDocuments({ ...query, status: 'RETIRED' }),
        Asset.countDocuments({ ...query, status: 'LOST' })
    ]);

    const valueAgg = await Asset.aggregate([
        { $match: query },
        { $group: { _id: null, totalPurchaseValue: { $sum: '$purchasePrice' }, totalCurrentValue: { $sum: '$currentValue' } } }
    ]);
    const values = valueAgg[0] || { totalPurchaseValue: 0, totalCurrentValue: 0 };

    res.json({
        total, active, assigned, maintenance, retired, lost,
        totalPurchaseValue: Number(values.totalPurchaseValue.toFixed(2)),
        totalCurrentValue: Number(values.totalCurrentValue.toFixed(2))
    });
});

const getAssetById = asyncHandler(async (req, res) => {
    const asset = await Asset.findById(req.params.id)
        .populate('assignedTo', 'name email')
        .populate('warehouseId', 'code name');
    if (!asset || asset.isDeleted) {
        res.status(404);
        throw new Error('Asset not found');
    }
    res.json(asset);
});

const createAsset = asyncHandler(async (req, res) => {
    const { name, description, type, purchaseDate, purchasePrice, vendor, warrantyExpiry, depreciationRate, warehouseId, warehouseName, branchId } = req.body;
    if (!name) {
        res.status(400);
        throw new Error('name is required');
    }

    const assetCode = generateAssetCode();
    const partnerId = getEffectivePartnerId(req.user);

    const asset = await Asset.create({
        assetCode,
        name,
        description,
        type: type || 'OTHER',
        purchaseDate,
        purchasePrice: purchasePrice || 0,
        vendor,
        warrantyExpiry,
        depreciationRate: depreciationRate || 15,
        currentValue: purchasePrice || 0,
        warehouseId,
        warehouseName,
        branchId: branchId || getEffectiveBranchId(req.user) || req.user.branchId,
        partnerId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'asset',
        resourceId: asset._id,
        description: `Asset ${asset.name} (${asset.assetCode}) created`,
        details: { assetCode, name, type }
    });

    res.status(201).json(asset);
});

const updateAsset = asyncHandler(async (req, res) => {
    const asset = await Asset.findById(req.params.id);
    if (!asset || asset.isDeleted) {
        res.status(404);
        throw new Error('Asset not found');
    }

    Object.assign(asset, req.body);
    await asset.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'asset',
        resourceId: asset._id,
        description: `Asset ${asset.name} (${asset.assetCode}) updated`,
        details: req.body
    });

    res.json(asset);
});

// @desc    Assign asset to user
// @route   PUT /api/assets/:id/assign
const assignAsset = asyncHandler(async (req, res) => {
    const { assignedTo, assignedToName } = req.body;
    const asset = await Asset.findById(req.params.id);
    if (!asset || asset.isDeleted) {
        res.status(404);
        throw new Error('Asset not found');
    }

    asset.assignedTo = assignedTo || null;
    asset.assignedToName = assignedToName || '';
    asset.assignedAt = assignedTo ? new Date() : null;
    asset.status = assignedTo ? 'ASSIGNED' : 'ACTIVE';

    await asset.save();

    await logAudit(req, {
        action: 'ASSIGN',
        resource: 'asset',
        resourceId: asset._id,
        description: `Asset ${asset.assetCode} ${assignedTo ? 'assigned to ' + assignedToName : 'unassigned'}`,
        details: { assignedTo, assignedToName }
    });

    res.json(asset);
});

const deleteAsset = asyncHandler(async (req, res) => {
    const asset = await Asset.findById(req.params.id);
    if (!asset) {
        res.status(404);
        throw new Error('Asset not found');
    }
    asset.isDeleted = true;
    asset.status = 'RETIRED';
    await asset.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'asset',
        resourceId: asset._id,
        description: `Asset ${asset.name} (${asset.assetCode}) deleted`
    });

    res.json({ message: 'Asset removed' });
});

module.exports = {
    // Warehouses
    getWarehouses,
    getWarehouseStats,
    getWarehouseById,
    createWarehouse,
    updateWarehouse,
    deleteWarehouse,
    // Inventory
    getInventory,
    getInventoryStats,
    getInventoryById,
    createInventory,
    updateInventory,
    stockTransaction,
    deleteInventory,
    // Assets
    getAssets,
    getAssetStats,
    getAssetById,
    createAsset,
    updateAsset,
    assignAsset,
    deleteAsset
};
