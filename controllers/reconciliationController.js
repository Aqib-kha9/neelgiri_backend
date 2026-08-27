const asyncHandler = require('express-async-handler');
const StockReconciliation = require('../models/StockReconciliation');
const Inventory = require('../models/Inventory');
const { generateReconciliationId } = require('../utils/idGenerator');
const { buildScopeQuery, getEffectivePartnerId, getEffectiveBranchId } = require('../utils/scopeHelper');
const { logAudit } = require('../utils/auditLogger');

// @desc    Get all stock reconciliations (role-scoped)
// @route   GET /api/reconciliations
// @access  Private
const getReconciliations = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const { search, status, category, warehouseId } = req.query;
    if (search) {
        query.$or = [
            { itemName: { $regex: search, $options: 'i' } },
            { sku: { $regex: search, $options: 'i' } },
            { reconciliationId: { $regex: search, $options: 'i' } }
        ];
    }
    if (status && status !== 'ALL') query.status = status;
    if (category && category !== 'ALL') query.category = category;
    if (warehouseId) query.warehouseId = warehouseId;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
        StockReconciliation.find(query)
            .populate('warehouseId', 'code name')
            .populate('inventoryId', 'skuCode name quantity')
            .populate('resolvedBy', 'name email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        StockReconciliation.countDocuments(query)
    ]);

    res.json({
        data: records,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
});

// @desc    Get reconciliation stats
// @route   GET /api/reconciliations/stats
// @access  Private
const getReconciliationStats = asyncHandler(async (req, res) => {
    const query = buildScopeQuery(req.user) ?? {};
    query.isDeleted = { $ne: true };

    const [total, pending, inProgress, resolved, discrepancy] = await Promise.all([
        StockReconciliation.countDocuments(query),
        StockReconciliation.countDocuments({ ...query, status: 'pending' }),
        StockReconciliation.countDocuments({ ...query, status: 'in-progress' }),
        StockReconciliation.countDocuments({ ...query, status: 'resolved' }),
        StockReconciliation.countDocuments({ ...query, status: 'discrepancy' })
    ]);

    // Total variance value (sum of absolute variance)
    const varianceAgg = await StockReconciliation.aggregate([
        { $match: query },
        { $group: { _id: null, totalVariance: { $sum: { $abs: '$variance' } } } }
    ]);

    const resolutionRate = total > 0 ? Number(((resolved / total) * 100).toFixed(2)) : 0;

    res.json({
        total,
        pending,
        inProgress,
        resolved,
        discrepancy,
        totalVariance: varianceAgg[0]?.totalVariance || 0,
        resolutionRate
    });
});

// @desc    Get single reconciliation
// @route   GET /api/reconciliations/:id
// @access  Private
const getReconciliationById = asyncHandler(async (req, res) => {
    const record = await StockReconciliation.findById(req.params.id)
        .populate('warehouseId')
        .populate('inventoryId')
        .populate('resolvedBy', 'name email');
    if (!record || record.isDeleted) {
        res.status(404);
        throw new Error('Reconciliation record not found');
    }
    res.json(record);
});

// @desc    Create reconciliation
// @route   POST /api/reconciliations
// @access  Private
const createReconciliation = asyncHandler(async (req, res) => {
    const { itemName, sku, category, expectedQty, actualQty, warehouseId, inventoryId, location, notes } = req.body;

    if (!itemName || !sku) {
        res.status(400);
        throw new Error('itemName and sku are required');
    }

    const partnerId = getEffectivePartnerId(req.user);
    const branchId = getEffectiveBranchId(req.user) || req.user.branchId;
    const reconciliationId = generateReconciliationId();

    // If inventoryId provided, fetch expectedQty from inventory
    let finalExpectedQty = expectedQty;
    if (inventoryId && !expectedQty) {
        const inv = await Inventory.findById(inventoryId);
        if (inv) {
            finalExpectedQty = inv.quantity;
        }
    }

    const record = await StockReconciliation.create({
        reconciliationId,
        itemName,
        sku,
        category: category || 'GENERAL',
        expectedQty: finalExpectedQty || 0,
        actualQty: actualQty !== undefined ? actualQty : null,
        warehouseId,
        inventoryId,
        location,
        notes,
        status: actualQty !== undefined && actualQty !== null ? 'in-progress' : 'pending',
        partnerId,
        branchId,
        createdBy: req.user._id
    });

    await logAudit(req, {
        action: 'CREATE',
        resource: 'stock-reconciliation',
        resourceId: record._id,
        description: `Reconciliation ${record.reconciliationId} created for ${itemName} (${sku})`,
        details: { reconciliationId, itemName, sku, expectedQty: finalExpectedQty }
    });

    res.status(201).json(record);
});

// @desc    Update reconciliation (e.g., enter actual count)
// @route   PUT /api/reconciliations/:id
// @access  Private
const updateReconciliation = asyncHandler(async (req, res) => {
    const record = await StockReconciliation.findById(req.params.id);
    if (!record || record.isDeleted) {
        res.status(404);
        throw new Error('Reconciliation record not found');
    }

    const { actualQty, status, notes, reconciledBy } = req.body;

    if (actualQty !== undefined && actualQty !== null) {
        record.actualQty = actualQty;
        record.variance = actualQty - record.expectedQty;
        record.variancePercent = record.expectedQty > 0
            ? Number(((record.variance / record.expectedQty) * 100).toFixed(2))
            : 0;

        // Auto-set status based on variance
        if (!status) {
            if (record.variance === 0) {
                record.status = 'resolved';
            } else {
                record.status = 'discrepancy';
            }
        }
        record.reconciledBy = reconciledBy || req.user.name;
        record.reconciledDate = new Date();
    }

    if (status) record.status = status;
    if (notes !== undefined) record.notes = notes;

    await record.save();

    await logAudit(req, {
        action: 'UPDATE',
        resource: 'stock-reconciliation',
        resourceId: record._id,
        description: `Reconciliation ${record.reconciliationId} updated - actualQty: ${record.actualQty}, variance: ${record.variance}`,
        details: { actualQty, variance: record.variance, status: record.status }
    });

    res.json(record);
});

// @desc    Resolve reconciliation (optionally apply adjustment to inventory)
// @route   PUT /api/reconciliations/:id/resolve
// @access  Private
const resolveReconciliation = asyncHandler(async (req, res) => {
    const { resolutionNotes, applyAdjustment } = req.body;

    const record = await StockReconciliation.findById(req.params.id);
    if (!record || record.isDeleted) {
        res.status(404);
        throw new Error('Reconciliation record not found');
    }

    record.status = 'resolved';
    record.resolutionNotes = resolutionNotes || '';
    record.resolvedBy = req.user._id;
    record.resolvedAt = new Date();

    // Optionally apply adjustment to inventory
    if (applyAdjustment && record.inventoryId && record.variance !== 0) {
        const inventory = await Inventory.findById(record.inventoryId);
        if (inventory) {
            inventory.transactions.push({
                type: 'ADJUSTMENT',
                quantity: record.variance,
                reference: `Reconciliation ${record.reconciliationId}`,
                performedBy: req.user._id,
                note: resolutionNotes || 'Stock reconciliation adjustment'
            });
            await inventory.save();
            record.adjustmentApplied = true;
        }
    }

    await record.save();

    await logAudit(req, {
        action: 'RESOLVE',
        resource: 'stock-reconciliation',
        resourceId: record._id,
        description: `Reconciliation ${record.reconciliationId} resolved${applyAdjustment ? ' with inventory adjustment' : ''}`,
        details: { resolutionNotes, applyAdjustment }
    });

    res.json(record);
});

// @desc    Soft delete reconciliation
// @route   DELETE /api/reconciliations/:id
// @access  Private
const deleteReconciliation = asyncHandler(async (req, res) => {
    const record = await StockReconciliation.findById(req.params.id);
    if (!record) {
        res.status(404);
        throw new Error('Reconciliation record not found');
    }

    record.isDeleted = true;
    await record.save();

    await logAudit(req, {
        action: 'DELETE',
        resource: 'stock-reconciliation',
        resourceId: record._id,
        description: `Reconciliation ${record.reconciliationId} deleted`
    });

    res.json({ message: 'Reconciliation record removed' });
});

module.exports = {
    getReconciliations,
    getReconciliationStats,
    getReconciliationById,
    createReconciliation,
    updateReconciliation,
    resolveReconciliation,
    deleteReconciliation
};
